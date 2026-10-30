import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import {
	PROFILE_ENTRY_MAX_CHARS,
	PROFILE_MAX_ENTRIES,
	type ProfileOp,
	type TeachingProfile,
} from "../../core/contracts/profile.ts";
import { profileOpsProblem, renderProfileText } from "../../core/teaching-profile.ts";

/**
 * The profile learner (post-session pass): reads ONE finished session and
 * maintains the learner's teaching profile — short, durable observations of
 * how this person is best taught. A single-submit agent on the shared
 * runSubmitAgent seam: the submit is the whole deliverable, and its
 * validate hook sends a malformed or unlawful operation list back to the
 * model to retry. It returns the operations; it never writes — the server
 * module (src/server/profile.ts) applies them.
 */

/** The transcript budget (chars): the NEWEST part of a long session is kept —
 *  the profile wants recent behavior and the cheap tail is the freshest. */
export const PROFILE_TRANSCRIPT_MAX_CHARS = 120_000;

const INSTRUCTIONS = `You maintain a teaching profile: a short list of durable observations about how ONE learner is best taught. A teacher agent reads it before planning a lesson and before choosing how to present a step, so every entry must change how someone would teach — and must be true of this learner, not of teaching in general.

You are given the current profile (each entry has an id), the session just finished (a transcript with the learner's check results), a small digest of behavioral counts, and sometimes the learner's own reflection. Submit operations against the profile: add, edit, remove.

Evidence rules:
- The strongest evidence is a check the learner answered right or wrong right after a particular way of presenting a step — a worked example, an analogy, a demo, a figure, a plain statement of the fact, a derivation. A pattern needs more than one instance; one instance is a hint, not an entry.
- The learner's reflection is explicit. When it conflicts with what the transcript suggests, the reflection wins — edit or remove the contradicted entry.
- Entries recorded as origin "manual" are the learner's own words. You may not edit or remove them; if the evidence contradicts one, leave it alone.
- Never record WHAT the learner knows (the knowledge graph owns that) or one-off events. Record how they learn: preferred order (example before abstraction or after), representation (visual, symbolic, verbal), step size, pacing, tolerance for analogy, what kinds of check work for them, what they find confusing about explanations.
- If a subject-specific pattern shows up, set the entry's subject (a short field name, e.g. "photonics"). Otherwise leave subject out.

Entry rules: one plain sentence, at most ${PROFILE_ENTRY_MAX_CHARS} characters, in the third person ("Learns best from…"). The profile holds at most ${PROFILE_MAX_ENTRIES} entries — merge near-duplicates (edit one, remove the other) instead of piling up. Prefer editing an existing entry to adding a restatement of it.

Be conservative. If the session offers no real evidence, submit an empty operations list — that is a correct answer. Submit exactly once.`;

const submitInput = Type.Object({
	operations: Type.Array(
		Type.Object({
			op: Type.Union([Type.Literal("add"), Type.Literal("edit"), Type.Literal("remove")], {
				description: "add a new entry, edit an existing one (by id), or remove one (by id)",
			}),
			id: Type.Optional(Type.String({ description: "The existing entry's id — required for edit and remove" })),
			text: Type.Optional(Type.String({ description: "The entry's sentence — required for add and edit" })),
			subject: Type.Optional(Type.String({ description: "Optional subject tag for add/edit" })),
		}),
		{ description: "The operations to apply, in order. Empty when the session shows nothing durable." },
	),
});
type SubmitInput = Static<typeof submitInput>;

/** The flat wire shape → lawful ProfileOps, or the problem that sends the
 *  model back to retry. */
export function toProfileOps(input: SubmitInput): { ops: ProfileOp[]; problem: string | null } {
	const ops: ProfileOp[] = [];
	for (const [i, o] of input.operations.entries()) {
		const at = `operation ${i + 1}`;
		const subject = o.subject?.trim() ? { subject: o.subject } : {};
		if (o.op === "add") {
			if (!o.text?.trim()) return { ops, problem: `${at}: add needs text` };
			ops.push({ op: "add", text: o.text, ...subject });
		} else if (o.op === "edit") {
			if (!o.id || !o.text?.trim()) return { ops, problem: `${at}: edit needs id and text` };
			ops.push({ op: "edit", id: o.id, text: o.text, ...subject });
		} else {
			if (!o.id) return { ops, problem: `${at}: remove needs id` };
			ops.push({ op: "remove", id: o.id });
		}
	}
	return { ops, problem: null };
}

export interface ProfileLearnerInput {
	profile: TeachingProfile;
	/** The session's title (its subject, as the learner named it). */
	title: string;
	/** The session rendered by the shared markdown engine. */
	transcript: string;
	/** The deterministic signals digest (core/teaching-profile.ts renderSignals). */
	signals: string;
	/** The learner's own end-of-session words, when given. */
	reflection?: string;
}

export interface ProfileLearnerOptions {
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	onUsage?: (usage: Usage, model: string) => void;
}

/** Trim a long transcript to its newest part, on a block boundary. */
function clipTranscript(transcript: string): string {
	if (transcript.length <= PROFILE_TRANSCRIPT_MAX_CHARS) return transcript;
	const tail = transcript.slice(transcript.length - PROFILE_TRANSCRIPT_MAX_CHARS);
	const boundary = tail.indexOf("\n### ");
	return `(earlier part of the session omitted)\n\n${boundary >= 0 ? tail.slice(boundary + 1) : tail}`;
}

export async function runProfileLearner(input: ProfileLearnerInput, opts: ProfileLearnerOptions): Promise<ProfileOp[]> {
	const current = renderProfileText(input.profile, { ids: true }) || "(empty — no entries yet)";
	const prompt = [
		"## Current profile",
		current,
		"## Session",
		`Title: ${input.title}`,
		"## Behavioral digest",
		input.signals,
		...(input.reflection?.trim() ? ["## The learner's own reflection (explicit — it wins on conflict)", input.reflection.trim()] : []),
		"## Transcript",
		clipTranscript(input.transcript),
		"Submit your operations.",
	].join("\n\n");
	const result = await runSubmitAgent<SubmitInput>({
		role: "profileLearner",
		toolName: "submit_profile_updates",
		toolDescription:
			"Submit the operations that update the teaching profile. An empty list is valid when the session shows nothing durable.",
		parameters: submitInput,
		fill: (raw: SubmitInput) => ({ operations: raw.operations ?? [] }),
		// Wire shape first, then lawfulness against THIS profile (unknown ids,
		// manual entries, the entry cap) — a problem sends the model back.
		validate: (value) => {
			const { ops, problem } = toProfileOps(value);
			return problem ?? profileOpsProblem(input.profile, ops, { protectManual: true });
		},
		systemPrompt: INSTRUCTIONS,
		prompt,
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) => opts.onUsage?.(usage, model),
		neverSubmitted: "the profile learner never submitted updates",
	});
	return toProfileOps(result).ops;
}
