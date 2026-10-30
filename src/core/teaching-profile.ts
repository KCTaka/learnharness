/**
 * The teaching profile's PURE brain: operations → next profile, the text the
 * teacher's reader tool and the learning pass both see, and the session's
 * deterministic behavioral-signals digest. No IO — the store persists, the
 * server module (src/server/profile.ts) is the sole writer.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "./native-messages.ts";
import {
	PROFILE_CHANGE_LOG_MAX,
	PROFILE_ENTRY_MAX_CHARS,
	PROFILE_MAX_ENTRIES,
	PROFILE_SUBJECT_MAX_CHARS,
	type ProfileChange,
	type ProfileEntry,
	type ProfileOp,
	type ProfileOrigin,
	type TeachingProfile,
} from "./contracts/profile.ts";

export function emptyProfile(): TeachingProfile {
	return { entries: [], changes: [], learned: {} };
}

/** Trim + collapse whitespace; "" when nothing is left. */
function cleanText(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function cleanSubject(value: unknown): string | undefined {
	const subject = cleanText(value);
	return subject === "" ? undefined : subject;
}

function newEntryId(): string {
	return `pf_${Date.now().toString(36)}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Why an op list cannot apply to this profile — null when it can. The same
 * check runs at the learner's submit seam (error-back) and again inside
 * applyProfileOps, so nothing malformed ever reaches the store.
 * `protectManual`: the learning pass may not touch the learner's own entries.
 */
export function profileOpsProblem(
	profile: TeachingProfile,
	ops: readonly ProfileOp[],
	opts: { protectManual?: boolean } = {},
): string | null {
	const byId = new Map(profile.entries.map((e) => [e.id, e]));
	const removed = new Set<string>();
	let count = profile.entries.length;
	for (const [i, op] of ops.entries()) {
		const at = `operation ${i + 1}`;
		if (op.op === "add") {
			const text = cleanText(op.text);
			if (text === "") return `${at}: add needs non-empty text`;
			if (text.length > PROFILE_ENTRY_MAX_CHARS) return `${at}: text is over ${PROFILE_ENTRY_MAX_CHARS} characters — one sentence`;
			if ((cleanSubject(op.subject) ?? "").length > PROFILE_SUBJECT_MAX_CHARS) return `${at}: subject is over ${PROFILE_SUBJECT_MAX_CHARS} characters`;
			count++;
			continue;
		}
		const entry = byId.get(op.id);
		if (!entry || removed.has(op.id)) return `${at}: unknown entry id "${op.id}" — use an id from the current profile`;
		if (opts.protectManual && entry.origin === "manual") return `${at}: entry "${op.id}" was written by the learner and may not be changed`;
		if (op.op === "remove") {
			removed.add(op.id);
			count--;
			continue;
		}
		const text = cleanText(op.text);
		if (text === "") return `${at}: edit needs non-empty text`;
		if (text.length > PROFILE_ENTRY_MAX_CHARS) return `${at}: text is over ${PROFILE_ENTRY_MAX_CHARS} characters — one sentence`;
		if ((cleanSubject(op.subject) ?? "").length > PROFILE_SUBJECT_MAX_CHARS) return `${at}: subject is over ${PROFILE_SUBJECT_MAX_CHARS} characters`;
	}
	if (count > PROFILE_MAX_ENTRIES) return `the profile would hold ${count} entries (max ${PROFILE_MAX_ENTRIES}) — merge or remove some`;
	return null;
}

/**
 * Apply ops in order (pure). Throws on a problem — callers validate first;
 * an op list is all-or-nothing. An edit keeps the entry's createdAt; the
 * entry's origin becomes the editor's. Every applied op lands in the log.
 */
export function applyProfileOps(
	profile: TeachingProfile,
	ops: readonly ProfileOp[],
	origin: ProfileOrigin,
	now: string = new Date().toISOString(),
	opts: { protectManual?: boolean } = {},
): TeachingProfile {
	const problem = profileOpsProblem(profile, ops, opts);
	if (problem) throw new Error(problem);
	let entries = [...profile.entries];
	const changes: ProfileChange[] = [];
	for (const op of ops) {
		if (op.op === "add") {
			const subject = cleanSubject(op.subject);
			const entry: ProfileEntry = {
				id: newEntryId(),
				text: cleanText(op.text),
				...(subject ? { subject } : {}),
				origin,
				createdAt: now,
				updatedAt: now,
			};
			entries.push(entry);
			changes.push({ at: now, kind: "added", entryId: entry.id, text: entry.text, origin });
		} else if (op.op === "edit") {
			const subject = cleanSubject(op.subject);
			entries = entries.map((e) => {
				if (e.id !== op.id) return e;
				const { subject: _old, ...rest } = e;
				return { ...rest, ...(subject ? { subject } : {}), text: cleanText(op.text), origin, updatedAt: now };
			});
			changes.push({ at: now, kind: "edited", entryId: op.id, text: cleanText(op.text), origin });
		} else {
			const gone = entries.find((e) => e.id === op.id)!;
			entries = entries.filter((e) => e.id !== op.id);
			changes.push({ at: now, kind: "removed", entryId: op.id, text: gone.text, origin });
		}
	}
	return {
		entries,
		changes: [...profile.changes, ...changes].slice(-PROFILE_CHANGE_LOG_MAX),
		learned: profile.learned,
	};
}

/** The profile as plain text — what the teacher's reader tool returns and
 *  the learning pass reads. Ids are shown to the learning pass (it edits by id). */
export function renderProfileText(profile: TeachingProfile, opts: { ids?: boolean } = {}): string {
	return profile.entries
		.map((e) => `- ${opts.ids ? `[${e.id}] ` : ""}${e.subject ? `(${e.subject}) ` : ""}${e.text}${opts.ids ? ` — ${e.origin}` : ""}`)
		.join("\n");
}

// ─── the session's behavioral signals (deterministic, no LLM) ───────────────

/** The checks that verify a step landed: teach-phase quiz/explain, probe-phase probe/recall. */
const CHECK_TOOLS = new Set(["quiz", "explain", "probe", "recall"]);
/** The presentation artifacts the teacher can reach for. */
const PRESENTATION_TOOLS = ["demo", "visual", "research", "pdf"] as const;

export interface TeachingSignals {
	/** Checks the learner actually answered (skips excluded). */
	answered: number;
	correct: number;
	incorrect: number;
	dontKnow: number;
	skipped: number;
	/** How many times each presentation tool was dispatched. */
	presentations: Record<string, number>;
}

export function teachingSignals(messages: ReadonlyArray<LhMessage>): TeachingSignals {
	const signals: TeachingSignals = { answered: 0, correct: 0, incorrect: 0, dontKnow: 0, skipped: 0, presentations: {} };
	for (const message of messages) {
		const role = (message as { role?: string }).role;
		if (role === "toolResult") {
			const result = message as ToolResultMessage;
			if (result.isError || !CHECK_TOOLS.has(result.toolName)) continue;
			const out = result.details as Partial<{ correct: boolean; dontKnow: boolean; dismissed: boolean }> | undefined;
			if (out?.dismissed === true) signals.skipped++;
			else if (out?.dontKnow === true) {
				signals.answered++;
				signals.dontKnow++;
			} else {
				signals.answered++;
				if (out?.correct === true) signals.correct++;
				else if (out?.correct === false) signals.incorrect++;
			}
		} else if (role === "assistant") {
			const content = (message as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const block of content as Array<{ type?: string; name?: string }>) {
				if (block.type === "toolCall" && block.name && (PRESENTATION_TOOLS as readonly string[]).includes(block.name)) {
					signals.presentations[block.name] = (signals.presentations[block.name] ?? 0) + 1;
				}
			}
		}
	}
	return signals;
}

export function renderSignals(s: TeachingSignals): string {
	const presented = Object.entries(s.presentations).map(([k, n]) => `${k} ×${n}`).join(", ") || "none";
	return [
		`Checks answered: ${s.answered} (correct ${s.correct}, incorrect ${s.incorrect}, "don't know" ${s.dontKnow}); skipped: ${s.skipped}.`,
		`Presentation tools dispatched: ${presented}.`,
	].join("\n");
}
