// ─── The teaching profile (how this learner is best taught) ──────────────────
//
// ONE global, human-readable, editable record. Entries are plain sentences
// ("learns best from a worked example before the abstraction"), optionally
// tagged with a subject. Written by exactly one server module
// (src/server/profile.ts): the post-session learning pass (origins
// "inferred" / "reflection") and the settings editor ("manual"). The
// teacher READS it through a tool; nothing is ever injected into a prompt.

export const PROFILE_ORIGINS = ["inferred", "reflection", "manual"] as const;
export type ProfileOrigin = (typeof PROFILE_ORIGINS)[number];

/** Hard bounds — an entry is one sentence, the profile stays skimmable. */
export const PROFILE_ENTRY_MAX_CHARS = 400;
export const PROFILE_SUBJECT_MAX_CHARS = 60;
export const PROFILE_MAX_ENTRIES = 40;
/** The change log keeps the most recent N changes. */
export const PROFILE_CHANGE_LOG_MAX = 200;

export interface ProfileEntry {
	id: string;
	text: string;
	/** Optional subject tag; absent = applies in every subject. */
	subject?: string;
	origin: ProfileOrigin;
	createdAt: string;
	updatedAt: string;
}

export interface ProfileChange {
	at: string;
	kind: "added" | "edited" | "removed";
	entryId: string;
	/** The entry's text AFTER the change (removed: the text that was removed). */
	text: string;
	origin: ProfileOrigin;
}

export interface TeachingProfile {
	entries: ProfileEntry[];
	changes: ProfileChange[];
	/** chatId → fingerprint of the transcript the learning pass last read
	 *  (idempotency: an unchanged session is not learned from twice). */
	learned: Record<string, string>;
}

/** One operation the learning pass (or the editor) proposes. */
export type ProfileOp =
	| { op: "add"; text: string; subject?: string }
	| { op: "edit"; id: string; text: string; subject?: string }
	| { op: "remove"; id: string };
