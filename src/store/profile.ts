/**
 * ProfileStore — the fs JSON adapter: ONE file, data/profile.json, under the
 * LH_DATA_DIR seam (contracts/profile.ts). Whole-file read-modify-write like
 * the settings record; sync fs, tab-indented JSON. Everything off disk is
 * shape-guarded — an invalid entry or log line is dropped, never guessed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	PROFILE_ORIGINS,
	type ProfileChange,
	type ProfileEntry,
	type ProfileOrigin,
	type TeachingProfile,
} from "../core/contracts/profile.ts";
import type { ProfileStore } from "../core/ports.ts";
import { emptyProfile } from "../core/teaching-profile.ts";

/** Read lazily so the LH_DATA_DIR seam is honored however late it is set. */
const profileFile = () => path.join(PATHS.data, "profile.json");

const isOrigin = (v: unknown): v is ProfileOrigin => (PROFILE_ORIGINS as readonly unknown[]).includes(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

function guardEntry(raw: unknown): ProfileEntry | null {
	const e = raw as Partial<ProfileEntry> | null;
	if (!e || !isStr(e.id) || !isStr(e.text) || !isOrigin(e.origin) || !isStr(e.createdAt) || !isStr(e.updatedAt)) return null;
	return {
		id: e.id,
		text: e.text,
		...(isStr(e.subject) ? { subject: e.subject } : {}),
		origin: e.origin,
		createdAt: e.createdAt,
		updatedAt: e.updatedAt,
	};
}

function guardChange(raw: unknown): ProfileChange | null {
	const c = raw as Partial<ProfileChange> | null;
	if (!c || !isStr(c.at) || !isStr(c.entryId) || typeof c.text !== "string" || !isOrigin(c.origin)) return null;
	if (c.kind !== "added" && c.kind !== "edited" && c.kind !== "removed") return null;
	return { at: c.at, kind: c.kind, entryId: c.entryId, text: c.text, origin: c.origin };
}

function read(): TeachingProfile {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(profileFile(), "utf-8"));
	} catch {
		return emptyProfile();
	}
	const body = (raw ?? {}) as { entries?: unknown; changes?: unknown; learned?: unknown };
	const learned: Record<string, string> = {};
	if (body.learned && typeof body.learned === "object") {
		for (const [chatId, fp] of Object.entries(body.learned as Record<string, unknown>)) {
			if (typeof fp === "string") learned[chatId] = fp;
		}
	}
	return {
		entries: Array.isArray(body.entries) ? body.entries.map(guardEntry).filter((e): e is ProfileEntry => e !== null) : [],
		changes: Array.isArray(body.changes) ? body.changes.map(guardChange).filter((c): c is ProfileChange => c !== null) : [],
		learned,
	};
}

function write(profile: TeachingProfile): void {
	fs.mkdirSync(PATHS.data, { recursive: true });
	fs.writeFileSync(profileFile(), JSON.stringify(profile, null, "\t"), "utf-8");
}

export const profileStore: ProfileStore = { read, write };
