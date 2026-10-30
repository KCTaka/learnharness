/**
 * The teaching profile — deterministic, zero network, isolated LH_DATA_DIR:
 * pure ops + signals, the fs store, the learner agent (scripted submit with
 * validate error-back), the server pass (gates, idempotency, reflection),
 * the wrap-up route, the idle trigger, the teacher's reader tool, the prompt
 * fragment, and the settings view.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-profile-"));
process.env.LH_DATA_DIR = TMP_DATA;

const core = await import("../src/core/teaching-profile.ts");
const { profileStore } = await import("../src/store/profile.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { runProfileLearner } = await import("../src/agent/subagents/profile-learner.ts");
const server = await import("../src/server/profile.ts");
const { POST: wrapUp } = await import("../app/api/chats/[id]/wrap-up/route.ts");
const { GET: getProfile, POST: postProfile, PUT: putProfile, DELETE: deleteProfile } = await import("../app/api/profile/route.ts");
const { createTeacherTools } = await import("../src/agent/tools.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { ProfileView } = await import("../components/settings/profile-section.tsx");
const { ROLE_SLOT } = await import("../src/core/settings.ts");
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { TeachingProfile } from "../src/core/contracts/profile.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

afterEach(() => {
	profileStore.write(core.emptyProfile());
	writeSettings({ version: 1 });
});

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const submit = (operations: unknown[]): FauxResponseStep =>
	fauxAssistantMessage([fauxToolCall("submit_profile_updates", { operations } as never, { id: `s${Math.random()}` })], { stopReason: "toolUse" });

/** A session with `answered` checked steps (one correct, rest as given). */
function session(results: Array<boolean | "skip">): LhMessage[] {
	const out: LhMessage[] = [{ id: "u1", role: "user", content: "teach me waveguides", timestamp: 1 } as never];
	results.forEach((r, i) => {
		out.push(
			{
				id: `a${i}`,
				role: "assistant",
				content: [
					{ type: "text", text: `Step ${i}: a worked example first.` },
					{ type: "toolCall", id: `q${i}`, name: "quiz", arguments: {} as never },
				],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 2,
			} as never,
			{
				id: `r${i}`,
				role: "toolResult",
				toolCallId: `q${i}`,
				toolName: "quiz",
				content: [{ type: "text", text: "answered" }],
				details: r === "skip" ? { questionText: "Q?", dismissed: true } : { questionText: "Q?", correct: r },
				isError: false,
				timestamp: 3,
			} as never,
		);
	});
	return out;
}

function chatWith(results: Array<boolean | "skip">): string {
	const chat = chatStore.createChat("Waveguides");
	chatStore.saveMessages(chat.id, session(results));
	return chat.id;
}

const entry = (id: string, origin: "inferred" | "reflection" | "manual" = "inferred") => ({
	id,
	text: `text ${id}`,
	origin,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("core: profile operations", () => {
	it("adds, edits and removes, logging every change with its origin", () => {
		let p = core.applyProfileOps(core.emptyProfile(), [{ op: "add", text: "  Learns   from examples. ", subject: "photonics" }], "inferred");
		assert.equal(p.entries.length, 1);
		assert.equal(p.entries[0]!.text, "Learns from examples.");
		assert.equal(p.entries[0]!.subject, "photonics");
		const id = p.entries[0]!.id;
		p = core.applyProfileOps(p, [{ op: "edit", id, text: "Prefers examples first." }], "reflection");
		assert.equal(p.entries[0]!.origin, "reflection");
		assert.equal(p.entries[0]!.subject, undefined, "an edit without a subject clears the tag");
		p = core.applyProfileOps(p, [{ op: "remove", id }], "manual");
		assert.deepEqual(p.entries, []);
		assert.deepEqual(p.changes.map((c) => [c.kind, c.origin]), [["added", "inferred"], ["edited", "reflection"], ["removed", "manual"]]);
	});

	it("rejects unknown ids, empty text, over-long text, and the entry cap", () => {
		const p: TeachingProfile = { ...core.emptyProfile(), entries: [entry("pf_a")] };
		assert.match(core.profileOpsProblem(p, [{ op: "edit", id: "nope", text: "x" }]) ?? "", /unknown entry id/);
		assert.match(core.profileOpsProblem(p, [{ op: "remove", id: "nope" }]) ?? "", /unknown entry id/);
		assert.match(core.profileOpsProblem(p, [{ op: "add", text: "   " }]) ?? "", /non-empty/);
		assert.match(core.profileOpsProblem(p, [{ op: "add", text: "x".repeat(401) }]) ?? "", /over 400/);
		const full: TeachingProfile = { ...core.emptyProfile(), entries: Array.from({ length: 40 }, (_, i) => entry(`pf_${i}`)) };
		assert.match(core.profileOpsProblem(full, [{ op: "add", text: "one more" }]) ?? "", /max 40/);
		assert.throws(() => core.applyProfileOps(p, [{ op: "remove", id: "nope" }], "manual"), /unknown entry id/);
	});

	it("protects the learner's own entries from the learning pass only", () => {
		const p: TeachingProfile = { ...core.emptyProfile(), entries: [entry("pf_m", "manual")] };
		assert.match(core.profileOpsProblem(p, [{ op: "remove", id: "pf_m" }], { protectManual: true }) ?? "", /written by the learner/);
		assert.equal(core.profileOpsProblem(p, [{ op: "remove", id: "pf_m" }]), null);
	});

	it("renders text with and without ids; empty renders empty", () => {
		const p: TeachingProfile = { ...core.emptyProfile(), entries: [{ ...entry("pf_a"), subject: "optics" }] };
		assert.equal(core.renderProfileText(p), "- (optics) text pf_a");
		assert.equal(core.renderProfileText(p, { ids: true }), "- [pf_a] (optics) text pf_a — inferred");
		assert.equal(core.renderProfileText(core.emptyProfile()), "");
	});

	it("folds behavioral signals: answered, right/wrong, skipped, presentation tools", () => {
		const messages = [
			...session([true, false, "skip"]),
			{
				id: "d",
				role: "assistant",
				content: [{ type: "toolCall", id: "d1", name: "demo", arguments: {} as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "t",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 9,
			} as never,
		];
		const s = core.teachingSignals(messages);
		assert.deepEqual([s.answered, s.correct, s.incorrect, s.skipped], [2, 1, 1, 1]);
		assert.deepEqual(s.presentations, { demo: 1 });
		assert.match(core.renderSignals(s), /demo ×1/);
	});
});

describe("store: data/profile.json", () => {
	it("round-trips, and drops invalid entries and log lines instead of guessing", () => {
		const p = core.applyProfileOps(core.emptyProfile(), [{ op: "add", text: "A" }], "manual");
		profileStore.write({ ...p, learned: { c1: "fp" } });
		assert.deepEqual(profileStore.read(), { ...p, learned: { c1: "fp" } });
		fs.writeFileSync(
			path.join(TMP_DATA, "profile.json"),
			JSON.stringify({ entries: [{ id: "x" }, entry("ok")], changes: [{ kind: "wat" }], learned: { a: 3, b: "fp" } }),
		);
		const read = profileStore.read();
		assert.deepEqual(read.entries.map((e) => e.id), ["ok"]);
		assert.deepEqual(read.changes, []);
		assert.deepEqual(read.learned, { b: "fp" });
	});

	it("a missing or corrupt file reads as the empty profile", () => {
		fs.rmSync(path.join(TMP_DATA, "profile.json"), { force: true });
		assert.deepEqual(profileStore.read(), core.emptyProfile());
		fs.writeFileSync(path.join(TMP_DATA, "profile.json"), "{not json");
		assert.deepEqual(profileStore.read(), core.emptyProfile());
	});
});

describe("learner agent", () => {
	const input = (profile: TeachingProfile = core.emptyProfile(), reflection?: string) => ({
		profile,
		title: "Waveguides",
		transcript: "### Learner\n\nhi",
		signals: "Checks answered: 1",
		reflection,
	});

	it("returns the submitted operations", async () => {
		const ops = await runProfileLearner(input(), { engine: fauxEngine([submit([{ op: "add", text: "Learns from examples.", subject: "optics" }])]) });
		assert.deepEqual(ops, [{ op: "add", text: "Learns from examples.", subject: "optics" }]);
	});

	it("an empty list is a valid, correct answer", async () => {
		assert.deepEqual(await runProfileLearner(input(), { engine: fauxEngine([submit([])]) }), []);
	});

	it("sends an unlawful submit back (unknown id), then accepts the retry", async () => {
		const p: TeachingProfile = { ...core.emptyProfile(), entries: [entry("pf_a")] };
		const ops = await runProfileLearner(input(p), {
			engine: fauxEngine([submit([{ op: "remove", id: "ghost" }]), submit([{ op: "edit", id: "pf_a", text: "Better." }])]),
		});
		assert.deepEqual(ops, [{ op: "edit", id: "pf_a", text: "Better." }]);
	});

	it("sends a malformed op back (edit without text), and a manual-entry touch back", async () => {
		const p: TeachingProfile = { ...core.emptyProfile(), entries: [entry("pf_m", "manual"), entry("pf_a")] };
		const ops = await runProfileLearner(input(p), {
			engine: fauxEngine([
				submit([{ op: "edit", id: "pf_a" }]),
				submit([{ op: "remove", id: "pf_m" }]),
				submit([{ op: "remove", id: "pf_a" }]),
			]),
		});
		assert.deepEqual(ops, [{ op: "remove", id: "pf_a" }]);
	});

	it("throws when the model never submits", async () => {
		await assert.rejects(runProfileLearner(input(), { engine: fauxEngine([fauxAssistantMessage([fauxText("no")])]) }), /never submitted/);
	});

	it("is slot-only on the strong tier", () => {
		assert.equal(ROLE_SLOT.profileLearner, "strong");
	});
});

describe("server: the learning pass", () => {
	it("404 unknown chat; 400 practice session", async () => {
		assert.equal((await server.runProfilePass("nope")).ok, false);
		const practice = chatStore.createChat("p", "practice");
		const out = await server.runProfilePass(practice.id);
		assert.ok(!out.ok && out.status === 400);
	});

	it("503 with the models_not_configured envelope when the strong slot is empty", async () => {
		const id = chatWith([true]);
		const out = await server.runProfilePass(id);
		assert.ok(!out.ok && out.status === 503);
		assert.equal((out as { body?: { code?: string } }).body?.code, "models_not_configured");
	});

	it("409 while a turn is running", async () => {
		const id = chatWith([true]);
		assert.ok(beginTurn(id));
		try {
			const out = await server.runProfilePass(id, { engine: fauxEngine([]) });
			assert.ok(!out.ok && out.status === 409);
		} finally {
			endTurn(id);
		}
	});

	it("skips a session with no answered check (behavioral only), but a reflection still runs", async () => {
		const id = chatWith(["skip"]);
		assert.deepEqual(await server.runProfilePass(id, { engine: fauxEngine([]) }), { ok: true, skipped: "no_checks", applied: 0 });
		const out = await server.runProfilePass(id, {
			reflection: "Examples help.",
			engine: fauxEngine([submit([{ op: "add", text: "Finds examples helpful." }])]),
		});
		assert.deepEqual(out, { ok: true, skipped: null, applied: 1 });
		assert.equal(profileStore.read().entries[0]!.origin, "reflection");
	});

	it("applies inferred ops, marks the session learned, then skips it as unchanged; a reflection re-runs", async () => {
		const id = chatWith([true, false]);
		const first = await server.runProfilePass(id, { engine: fauxEngine([submit([{ op: "add", text: "Worked examples land first." }])]) });
		assert.deepEqual(first, { ok: true, skipped: null, applied: 1 });
		const p = profileStore.read();
		assert.equal(p.entries[0]!.origin, "inferred");
		assert.ok(p.learned[id]);
		assert.deepEqual(await server.runProfilePass(id, { engine: fauxEngine([]) }), { ok: true, skipped: "unchanged", applied: 0 });
		const again = await server.runProfilePass(id, {
			reflection: "The analogy lost me.",
			engine: fauxEngine([submit([{ op: "add", text: "Analogies don't land." }])]),
		});
		assert.deepEqual(again, { ok: true, skipped: null, applied: 1 });
		assert.equal(profileStore.read().entries.length, 2);
	});

	it("never touches the chat record", async () => {
		const id = chatWith([true]);
		const before = JSON.stringify(chatStore.getChat(id)!.messages);
		await server.runProfilePass(id, { engine: fauxEngine([submit([{ op: "add", text: "x" }])]) });
		assert.equal(JSON.stringify(chatStore.getChat(id)!.messages), before);
	});

	it("a failed pass writes nothing and does not mark the session learned", async () => {
		const id = chatWith([true]);
		const out = await server.runProfilePass(id, { engine: fauxEngine([fauxAssistantMessage([fauxText("nothing")])]) });
		assert.ok(!out.ok && out.status === 500);
		assert.deepEqual(profileStore.read(), core.emptyProfile());
	});

	it("manual edits and clear are origin manual, logged; clear keeps the learned marks", () => {
		profileStore.write({ ...core.emptyProfile(), learned: { c1: "fp" } });
		const added = server.applyManualOps([{ op: "add", text: "Mine." }]);
		assert.equal(added.entries[0]!.origin, "manual");
		const cleared = server.clearProfile();
		assert.deepEqual(cleared.entries, []);
		assert.equal(cleared.changes.at(-1)!.kind, "removed");
		assert.deepEqual(cleared.learned, { c1: "fp" });
	});
});

describe("route: /api/chats/[id]/wrap-up", () => {
	const call = (id: string, body?: unknown) =>
		wrapUp(new Request("http://t/x", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }), {
			params: Promise.resolve({ id }),
		});

	it("409 while a turn is running", async () => {
		const id = chatWith([true]);
		writeSettings({ version: 1, models: { strong: { model: { provider: "openrouter", id: "x/y" } } } });
		process.env.OPENROUTER_API_KEY ??= "test-key";
		assert.ok(beginTurn(id));
		try {
			assert.equal((await call(id, { reflection: "hi" })).status, 409);
		} finally {
			endTurn(id);
		}
	});

	it("503 with the machine-readable envelope when no strong model is configured", async () => {
		const res = await call(chatWith([true]), { reflection: "hi" });
		assert.equal(res.status, 503);
		assert.equal(((await res.json()) as { code: string }).code, "models_not_configured");
	});

	it("400 on a non-string reflection, 404 on an unknown chat", async () => {
		assert.equal((await call(chatWith([true]), { reflection: 3 })).status, 400);
		assert.equal((await call("missing", {})).status, 404);
	});
});

describe("route: /api/profile", () => {
	const req = (method: string, body?: unknown, qs = "") =>
		new Request(`http://t/api/profile${qs}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

	it("add → edit → delete → clear, each manual and logged; bad input is 400", async () => {
		let res = await postProfile(req("POST", { text: "Likes diagrams.", subject: "optics" }));
		let body = (await res.json()) as { entries: Array<{ id: string; origin: string }>; changes: unknown[]; learned?: unknown };
		assert.equal(res.status, 200);
		assert.equal(body.entries[0]!.origin, "manual");
		assert.equal(body.learned, undefined, "learned bookkeeping never leaves the server");
		const id = body.entries[0]!.id;
		res = await putProfile(req("PUT", { id, text: "Likes diagrams a lot." }));
		body = (await res.json()) as typeof body;
		assert.equal(res.status, 200);
		assert.equal((await postProfile(req("POST", { text: "  " }))).status, 400);
		assert.equal((await putProfile(req("PUT", { id: "ghost", text: "x" }))).status, 400);
		assert.equal((await deleteProfile(req("DELETE", {}))).status, 400);
		res = await deleteProfile(req("DELETE", { id }));
		assert.equal(((await res.json()) as typeof body).entries.length, 0);
		await postProfile(req("POST", { text: "Again." }));
		res = await deleteProfile(req("DELETE", undefined, "?all=true"));
		const cleared = (await res.json()) as typeof body;
		assert.equal(cleared.entries.length, 0);
		assert.ok(cleared.changes.length >= 5);
		assert.equal(((await (await getProfile()).json()) as typeof body).entries.length, 0);
	});
});

describe("server: the idle trigger", () => {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it("fires once after the delay and debounces re-arming", async () => {
		const fired: string[] = [];
		const run = async (id: string) => void fired.push(id);
		server.armProfileIdle("idle-1", { delayMs: 40, run });
		await sleep(20);
		server.armProfileIdle("idle-1", { delayMs: 40, run }); // a later settle resets the timer
		await sleep(30);
		assert.deepEqual(fired, [], "reset: not yet");
		await sleep(60);
		assert.deepEqual(fired, ["idle-1"]);
	});

	it("re-arms instead of running while a turn is in flight", async () => {
		const fired: string[] = [];
		assert.ok(beginTurn("idle-2"));
		server.armProfileIdle("idle-2", { delayMs: 20, run: async (id) => void fired.push(id) });
		await sleep(60);
		assert.deepEqual(fired, []);
		endTurn("idle-2");
		await sleep(60);
		assert.deepEqual(fired, ["idle-2"]);
	});

	it("disarm cancels, and the default window is twenty minutes", async () => {
		const fired: string[] = [];
		server.armProfileIdle("idle-3", { delayMs: 20, run: async (id) => void fired.push(id) });
		server.disarmProfileIdle("idle-3");
		await sleep(50);
		assert.deepEqual(fired, []);
		assert.equal(server.PROFILE_IDLE_MS, 20 * 60 * 1000);
	});
});

describe("teacher: read_teaching_profile", () => {
	const ctx = (readProfile?: () => TeachingProfile) => ({
		chatId: "c",
		chatStore,
		jobStore,
		spawn: () => {},
		readProfile,
	});
	const text = async (tool: { execute: (...a: any[]) => Promise<any> }) => (await tool.execute("t1", {})).content[0].text as string;

	it("is registered only when a reader is injected", () => {
		assert.equal("read_teaching_profile" in createTeacherTools(ctx() as never), false);
		assert.equal("read_teaching_profile" in createTeacherTools(ctx(() => core.emptyProfile()) as never), true);
	});

	it("says so honestly when empty; lists entries (subject in parentheses, no ids) when not", async () => {
		const empty = createTeacherTools(ctx(() => core.emptyProfile()) as never).read_teaching_profile!;
		assert.match(await text(empty as never), /No teaching profile yet/);
		const p: TeachingProfile = { ...core.emptyProfile(), entries: [{ ...entry("pf_a"), subject: "optics", text: "Prefers derivations first." }, { ...entry("pf_b"), text: "Short steps." }] };
		const full = createTeacherTools(ctx(() => p) as never).read_teaching_profile!;
		const out = await text(full as never);
		assert.match(out, /- \(optics\) Prefers derivations first\./);
		assert.match(out, /- Short steps\./);
		assert.doesNotMatch(out, /pf_a/);
	});

	it("the teacher prompt carries the profile fragment, and it never says to announce it", () => {
		const prompt = composeInstructions("teacher");
		assert.match(prompt, /read_teaching_profile/);
		assert.match(prompt, /Never announce it/);
	});
});

describe("settings: the profile view", () => {
	const noop = () => {};
	const view = (over: Partial<Parameters<typeof ProfileView>[0]> = {}) =>
		renderToStaticMarkup(
			createElement(ProfileView, {
				profile: null,
				error: null,
				editingId: null,
				confirmingClear: false,
				onAdd: noop,
				onStartEdit: noop,
				onCancelEdit: noop,
				onSaveEdit: noop,
				onDelete: noop,
				onAskClear: noop,
				onCancelClear: noop,
				onClear: noop,
				...over,
			}),
		);

	it("empty state offers adding a line and hides clear + log", () => {
		const html = view({ profile: { entries: [], changes: [] } });
		assert.match(html, /data-testid="profile-empty"/);
		assert.match(html, /data-testid="profile-add"/);
		assert.doesNotMatch(html, /profile-clear/);
		assert.doesNotMatch(html, /profile-log/);
	});

	it("lists entries with subject tag + origin badge, edit/delete, the change log and clear", () => {
		const e = { ...entry("pf_a", "reflection"), subject: "optics", text: "Prefers derivations first." };
		const html = view({
			profile: { entries: [e], changes: [{ at: "2026-01-02T00:00:00.000Z", kind: "added", entryId: "pf_a", text: e.text, origin: "reflection" }] },
		});
		assert.match(html, /Prefers derivations first\./);
		assert.match(html, /data-testid="profile-subject"[^>]*>optics/);
		assert.match(html, /your reflection/);
		assert.match(html, /profile-edit-pf_a/);
		assert.match(html, /profile-delete-pf_a/);
		assert.match(html, /data-testid="profile-log"/);
		assert.match(html, /data-testid="profile-clear"/);
	});

	it("shows the editor for the entry being edited, the confirm for clear, and errors", () => {
		const e = entry("pf_a");
		const p = { entries: [e], changes: [] };
		assert.match(view({ profile: p, editingId: "pf_a" }), /profile-editor-pf_a/);
		assert.match(view({ profile: p, confirmingClear: true }), /data-testid="profile-clear-confirm"/);
		assert.match(view({ profile: p, error: "boom" }), /data-testid="profile-error"[^>]*>boom/);
	});
});
