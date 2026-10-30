/**
 * Agent health check (settings → Agent → "Test agents") — deterministic,
 * zero network: scripted faux engines, stubbed fetch, a fake headless.
 * The check must PASS only on evidence (a fetched page read back, a demo
 * that ran clean) and FAIL with an honest reason otherwise.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { AGENT_HEALTH_KINDS } from "../src/core/contracts.ts";
import { providerKeyMissing } from "../src/core/settings.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { runAgentHealthCheck, type AgentHealthDeps } from "../src/agent/subagents/health-check.ts";
import { headlessOverride, type DemoRunResult, type HeadlessApi } from "../src/agent/subagents/headless.ts";
import { isAgentHealthKind } from "../src/server/agent-health.ts";

function fauxEngine(steps: FauxResponseStep[], input?: ("text" | "image")[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	const model = faux.getModel();
	return { model: input ? { ...model, input } : model, streamFn: faux.streamSimple };
}

const deps = (engine: PiEngine | undefined, extra: Partial<AgentHealthDeps> = {}): AgentHealthDeps => ({
	engineFor: () => engine,
	...extra,
});

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	headlessOverride.current = undefined;
});

const EXAMPLE_HTML = `<!doctype html><html><head><title>Example Domain</title></head><body><div>
<h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents. You may use this
domain in literature without prior coordination or asking for permission.</p></div></body></html>`;

function stubExampleFetch(): void {
	globalThis.fetch = (async () =>
		new Response(EXAMPLE_HTML, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
}

describe("agent health check", () => {
	it("knows exactly the three agents and rejects anything else", () => {
		assert.deepEqual([...AGENT_HEALTH_KINDS], ["research", "demo", "visual"]);
		assert.ok(isAgentHealthKind("visual"));
		assert.ok(!isAgentHealthKind("pdf"));
		assert.ok(!isAgentHealthKind(undefined));
	});

	it("fails honestly when no model is configured for the agent's slot", async () => {
		const { result } = await runAgentHealthCheck("research", deps(undefined));
		assert.equal(result.ok, false);
		assert.match(result.detail, /No model configured/);
		assert.match(result.detail, /missing: cheap/);
		assert.equal(result.model, undefined);
	});

	it("fails honestly when the resolved provider's key is gone", async () => {
		const engine = fauxEngine([]);
		const { result } = await runAgentHealthCheck(
			"research",
			deps(engine, { providerKeyMissing: (provider, tier) => providerKeyMissing(provider, [tier]) }),
		);
		assert.equal(result.ok, false);
		assert.ok(result.model, "the failing model is named");
		assert.match(result.detail, /key/i);
	});

	it("refuses the figure agent on a model that cannot read images", async () => {
		const { result } = await runAgentHealthCheck("visual", deps(fauxEngine([], ["text"])));
		assert.equal(result.ok, false);
		assert.match(result.detail, /vision-capable/);
	});

	it("research passes only when the page was fetched and read back", async () => {
		stubExampleFetch();
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://example.com" }, { id: "f1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("## Summary\nThe main heading is \"Example Domain\".")]),
		]);
		const { result, usage } = await runAgentHealthCheck("research", deps(engine));
		assert.equal(result.ok, true, result.detail);
		assert.match(result.detail, /Web search is unavailable/, "no search provider → fetch-only is disclosed, not hidden");
		assert.ok(usage && usage.steps >= 2, "usage folded for pricing");
		assert.ok(result.durationMs >= 0);
	});

	it("research fails when the model answers without ever fetching", async () => {
		const engine = fauxEngine([fauxAssistantMessage([fauxText("The heading is Example Domain.")])]);
		const { result } = await runAgentHealthCheck("research", deps(engine));
		assert.equal(result.ok, false);
		assert.match(result.detail, /never fetched/);
	});

	it("research fails when the fetch came back but the page was not read back", async () => {
		stubExampleFetch();
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://example.com" }, { id: "f1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I could not determine anything.")]),
		]);
		const { result } = await runAgentHealthCheck("research", deps(engine));
		assert.equal(result.ok, false);
		assert.match(result.detail, /heading/);
	});

	it("demo passes when the built demo ran clean in headless Chrome", async () => {
		const clean: DemoRunResult = { ok: true, errors: [], consoleErrors: [], probe: undefined } as unknown as DemoRunResult;
		const fake: HeadlessApi = {
			available: () => true,
			unavailableReason: () => null,
			runDemo: async () => clean,
			renderSvg: async () => Buffer.alloc(0),
			renderPdfPages: async () => [],
		};
		headlessOverride.current = fake;
		const html = "<!doctype html><html><body><button id=b>Click</button><span id=c>Count: 0</span><script>let n=0;b.onclick=()=>{c.textContent='Count: '+(++n)}</script></body></html>";
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("write_demo", { html }, { id: "w1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("run_demo", {}, { id: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Click the button.")]),
		]);
		const { result } = await runAgentHealthCheck("demo", deps(engine));
		assert.equal(result.ok, true, result.detail);
	});

	it("a hung provider is cut off by the caller's abort, reported as cancelled", async () => {
		const hang = ((_ctx: unknown, options: { signal?: AbortSignal } | undefined) =>
			new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true }))) as unknown as FauxResponseStep;
		const controller = new AbortController();
		const run = runAgentHealthCheck("research", deps(fauxEngine([hang])), controller.signal);
		setTimeout(() => controller.abort(), 20);
		const { result } = await run;
		assert.equal(result.ok, false);
		assert.equal(result.detail, "Cancelled.");
	});

	it("the settings view shows pass, fail with the reason, and disables the button while running", async () => {
		const { renderToStaticMarkup } = await import("react-dom/server");
		const { createElement } = await import("react");
		const { AgentHealthView } = await import("../components/settings/agent-health.tsx");
		const html = renderToStaticMarkup(
			createElement(AgentHealthView, {
				onRun: () => {},
				states: {
					research: { kind: "research", ok: true, durationMs: 4200, model: "openrouter:x/y", detail: "Fetched a page.", cost: 0.0123 },
					demo: { kind: "demo", ok: false, durationMs: 900, detail: "No Chrome found." },
					visual: "running",
				},
			}),
		);
		assert.match(html, /data-testid="health-research-detail"/);
		assert.match(html, /No Chrome found\./);
		assert.match(html, /text-red-500/);
		assert.match(html, /4\.2s/);
		assert.match(html, /data-testid="health-run"[^>]*disabled/);
	});
});
