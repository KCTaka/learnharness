import { createHash } from "node:crypto";
import { runProfileLearner } from "../agent/subagents/profile-learner.ts";
import type { PiEngine } from "../agent/models.ts";
import type { ProfileOp, TeachingProfile } from "../core/contracts/profile.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { applyProfileOps, renderSignals, teachingSignals } from "../core/teaching-profile.ts";
import { resolveEngine } from "./agent-health.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * THE TEACHING PROFILE's server module — the SOLE writer of data/profile.json
 * (contracts/profile.ts). Two kinds of writer pass through here and nowhere
 * else: the settings editor (origin "manual") and the post-session learning
 * pass (origin "inferred" / "reflection"). Every write is a synchronous
 * read-modify-write with no await between the read and the write, so
 * atomicity rides the Node event loop like every other store.
 *
 * The learning pass is triggered two ways — automatically after a session
 * goes idle (armProfileIdle, behavioral signals alone) and explicitly by the
 * "Wrap up session" action (runProfilePass with the learner's reflection) —
 * and it never touches the chat record.
 */

// ─── manual edits (the settings editor) ──────────────────────────────────────

export function readProfile(): TeachingProfile {
	return stores.profileStore.read();
}

/** Apply learner-authored ops. Throws on an unlawful op list (the route maps it to 400). */
export function applyManualOps(ops: ProfileOp[]): TeachingProfile {
	const next = applyProfileOps(stores.profileStore.read(), ops, "manual");
	stores.profileStore.write(next);
	return next;
}

/** Remove every entry (each removal lands in the log). Sessions already
 *  learned from stay marked — clearing must not make the next idle pass
 *  re-learn the same history. */
export function clearProfile(): TeachingProfile {
	const current = stores.profileStore.read();
	const next = applyProfileOps(current, current.entries.map((e) => ({ op: "remove" as const, id: e.id })), "manual");
	stores.profileStore.write(next);
	return next;
}

// ─── the learning pass ───────────────────────────────────────────────────────

export type ProfilePassOutcome =
	| { ok: true; skipped: null; applied: number }
	| { ok: true; skipped: "unchanged" | "no_checks"; applied: 0 }
	| { ok: false; status: number; error: string; body?: Record<string, unknown> };

function pass(): Set<string> {
	const g = globalThis as { __lhProfilePasses?: Set<string> };
	return (g.__lhProfilePasses ??= new Set());
}

/** The transcript identity the pass learned from: the exact document the
 *  learner agent reads, so "unchanged" means "nothing new to read". */
function fingerprintOf(markdown: string): string {
	return createHash("sha256").update(markdown).digest("hex");
}

export interface ProfilePassOptions {
	/** The learner's own end-of-session words. A non-empty reflection is new
	 *  input: it forces a run even when the transcript is unchanged. */
	reflection?: string;
	/** Test seam: a scripted engine replaces the strong-slot resolution. */
	engine?: PiEngine;
}

export async function runProfilePass(chatId: string, opts: ProfilePassOptions = {}): Promise<ProfilePassOutcome> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return { ok: false, status: 404, error: "Not found" };
	if (record.kind === "practice") return { ok: false, status: 400, error: "Practice sessions are not learned from." };
	if (isTurnRunning(chatId) || pass().has(chatId)) {
		return { ok: false, status: 409, error: "A turn or profile update is already running for this session." };
	}

	// The strong-slot chain, gated like the job runner's: no model or no key
	// refuses with the same machine-readable 503 envelope turns use.
	const engine = opts.engine ?? resolveEngine("profileLearner");
	if (!engine) {
		const envelope = modelsNotConfigured(["strong"]);
		return { ok: false, status: 503, error: envelope.error, body: { ...envelope } };
	}
	if (!opts.engine && !providerKeyPresent(engine.model.provider)) {
		const envelope = providerKeyMissingEnvelope(engine.model.provider, ["strong"]);
		return { ok: false, status: 503, error: envelope.error, body: { ...envelope } };
	}

	const reflection = opts.reflection?.trim() || undefined;
	const transcript = sessionMarkdown(record.messages, { title: record.title, anchors: false });
	const fingerprint = fingerprintOf(transcript);
	const signals = teachingSignals(record.messages);
	if (!reflection) {
		if (signals.answered < 1) return { ok: true, skipped: "no_checks", applied: 0 };
		if (stores.profileStore.read().learned[chatId] === fingerprint) return { ok: true, skipped: "unchanged", applied: 0 };
	}

	pass().add(chatId);
	try {
		const ops = await runProfileLearner(
			{
				profile: stores.profileStore.read(),
				title: record.title,
				transcript,
				signals: renderSignals(signals),
				reflection,
			},
			{ engine },
		);
		// Fresh read AFTER the model call: the learner may have edited the
		// profile meanwhile. An op that no longer applies fails the pass
		// honestly (nothing written, nothing marked learned) — a retry sees truth.
		const current = stores.profileStore.read();
		const next = applyProfileOps(current, ops, reflection ? "reflection" : "inferred", undefined, { protectManual: true });
		stores.profileStore.write({ ...next, learned: { ...next.learned, [chatId]: fingerprint } });
		return { ok: true, skipped: null, applied: ops.length };
	} catch (err) {
		console.error(`[profile ${chatId}] learning pass failed:`, err);
		return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
	} finally {
		pass().delete(chatId);
	}
}

// ─── the idle trigger ────────────────────────────────────────────────────────

/** A session counts as finished after this long without a settled turn. */
export const PROFILE_IDLE_MS = 20 * 60 * 1000;

function timers(): Map<string, ReturnType<typeof setTimeout>> {
	const g = globalThis as { __lhProfileIdle?: Map<string, ReturnType<typeof setTimeout>> };
	return (g.__lhProfileIdle ??= new Map());
}

export interface ArmProfileIdleOptions {
	delayMs?: number;
	/** Test seam: what fires at idle (default: the behavioral-only pass). */
	run?: (chatId: string) => Promise<unknown>;
}

/** (Re)arm the chat's idle timer — called when a turn settles. Debounced: a
 *  later settle resets it. The timer is unref'd (never holds the process
 *  open) and a turn still running at fire time simply re-arms it. */
export function armProfileIdle(chatId: string, opts: ArmProfileIdleOptions = {}): void {
	const delayMs = opts.delayMs ?? PROFILE_IDLE_MS;
	const run = opts.run ?? ((id: string) => runProfilePass(id));
	const t = timers();
	const existing = t.get(chatId);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		t.delete(chatId);
		if (isTurnRunning(chatId)) {
			armProfileIdle(chatId, opts);
			return;
		}
		void run(chatId).catch((err: unknown) => console.error(`[profile ${chatId}] idle pass failed:`, err));
	}, delayMs);
	timer.unref?.();
	t.set(chatId, timer);
}

/** Drop a chat's pending idle timer (session deletion, tests). */
export function disarmProfileIdle(chatId: string): void {
	const t = timers();
	const existing = t.get(chatId);
	if (existing) clearTimeout(existing);
	t.delete(chatId);
}
