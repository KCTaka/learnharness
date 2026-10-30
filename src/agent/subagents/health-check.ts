import type { Usage } from "@earendil-works/pi-ai";
import {
	accumulateJobUsage,
	isSubagentFailure,
	piUsageToStep,
	type AgentHealthKind,
	type AgentHealthResult,
	type DemoResult,
	type JobKind,
	type JobUsage,
	type ResearchResult,
	type VisualResult,
} from "../../core/contracts.ts";
import { ROLE_SLOT, modelsNotConfigured, type ModelSlotName, type ProviderKeyMissing } from "../../core/settings.ts";
import type { SearchProvider } from "../../core/search.ts";
import type { ModelRole } from "../../../config.ts";
import type { PiEngine } from "../models.ts";
import { runDemoBuilder } from "./demo-builder.ts";
import { runResearcherAgent } from "./researcher.ts";
import { runVisualMaker } from "./visual-maker.ts";

/**
 * The agent health check (settings → Agent → "Test agents"): each sub-agent
 * runs ONE tiny canned task end-to-end through the same loop a real job
 * uses — the real engine from the user's slots, the real tools, the real
 * headless verification — and the outcome is checked, not assumed.
 *
 * A health check is NOT a job: no JobRecord, no steer, no chat, nothing
 * persisted. Dependencies arrive by injection (the agent layer never
 * imports the key store or the settings store) — the server composition
 * (src/server/agent-health.ts) supplies them.
 */

export interface AgentHealthDeps {
	/** Settings-resolved engine per role, read fresh; undefined = chain empty. */
	engineFor: (role: ModelRole) => PiEngine | undefined;
	/** Key-presence gate, same contract as the job runner's. */
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
	/** The live search provider; null = honestly unavailable. */
	searchProvider?: () => SearchProvider | null;
}

export interface AgentHealthRun {
	result: AgentHealthResult;
	/** Folded model usage — the server prices it (the agent layer has no price table). */
	usage?: JobUsage;
}

const KIND_ROLE: Record<AgentHealthKind, ModelRole> = {
	research: "researcher",
	demo: "demoBuilder",
	visual: "visualMaker",
};

/** Hard ceiling per smoke test — a hung provider must not hang the button. */
export const HEALTH_TIMEOUT_MS = 180_000;

/** The research probe: a page whose content is fixed and well known, so a
 *  pass proves the fetch tool worked AND the model read the page. */
const EXAMPLE_URL = "https://example.com";
const EXAMPLE_MARKER = /example domain/i;

export async function runAgentHealthCheck(
	kind: AgentHealthKind,
	deps: AgentHealthDeps,
	signal?: AbortSignal,
): Promise<AgentHealthRun> {
	const started = Date.now();
	const fail = (detail: string, model?: string, usage?: JobUsage): AgentHealthRun => ({
		result: { kind, ok: false, durationMs: Date.now() - started, model, detail, steps: usage?.steps },
		usage,
	});

	const role = KIND_ROLE[kind];
	const tier = ROLE_SLOT[role];
	const engine = deps.engineFor(role);
	if (!engine) {
		return fail(`${modelsNotConfigured([tier]).error} (missing: ${tier})`);
	}
	const model = `${engine.model.provider}:${engine.model.id}`;
	const keyRefusal = deps.providerKeyMissing?.(engine.model.provider, tier) ?? null;
	if (keyRefusal) return fail(keyRefusal.error, model);
	if (kind === "visual" && !engine.model.input.includes("image")) {
		return fail(`${model} cannot read images — the figure agent looks at its own renders and needs a vision-capable model in the vision slot.`, model);
	}

	// One controller: the caller's abort and the ceiling both kill the run
	// mid-model-call.
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, HEALTH_TIMEOUT_MS);

	let usage: JobUsage | undefined;
	const onUsage = (u: Usage) => {
		usage = accumulateJobUsage(usage, model, piUsageToStep(u));
	};

	try {
		const verdict =
			kind === "research"
				? await checkResearch(engine, deps, controller.signal, onUsage)
				: kind === "demo"
					? await checkDemo(engine, controller.signal, onUsage)
					: await checkVisual(engine, controller.signal, onUsage);
		return {
			result: {
				kind,
				ok: verdict.ok,
				durationMs: Date.now() - started,
				model,
				detail: verdict.detail,
				steps: usage?.steps,
			},
			usage,
		};
	} catch (err) {
		if (signal?.aborted) return fail("Cancelled.", model, usage);
		if (timedOut) return fail(`Timed out after ${HEALTH_TIMEOUT_MS / 1000}s with no result.`, model, usage);
		return fail(err instanceof Error ? err.message : String(err), model, usage);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

interface Verdict {
	ok: boolean;
	detail: string;
}

async function checkResearch(
	engine: PiEngine,
	deps: AgentHealthDeps,
	abortSignal: AbortSignal,
	onUsage: (u: Usage) => void,
): Promise<Verdict> {
	const searchLive = (deps.searchProvider?.() ?? null) !== null;
	const tools: string[] = [];
	const prompt = [
		searchLive
			? `Research question: Use web_search to find the IANA-maintained example domain page, then web_fetch ${EXAMPLE_URL} and report the page's main heading verbatim.`
			: `Research question: web_fetch ${EXAMPLE_URL} and report the page's main heading verbatim.`,
		"Context: this is a connectivity self-test; keep the brief to a few lines.",
		"Produce your final brief in the required format.",
	].join("\n\n");
	const brief = await runResearcherAgent(prompt, {
		engine,
		search: deps.searchProvider,
		abortSignal,
		onUsage,
		onToolStart: (name) => tools.push(name),
	});
	const result: ResearchResult = { brief: brief.trim(), sources: [] };
	if (!result.brief) return { ok: false, detail: "The researcher produced no text." };
	if (!tools.includes("web_fetch")) {
		return { ok: false, detail: `The researcher never fetched the page (tools used: ${tools.join(", ") || "none"}) — it may not be calling tools.` };
	}
	if (!EXAMPLE_MARKER.test(result.brief)) {
		return { ok: false, detail: "The researcher answered but did not report the fetched page's heading — the fetch may have failed." };
	}
	return {
		ok: true,
		detail: searchLive
			? "Searched and fetched a page, then reported its content."
			: "Fetched a page and reported its content. Web search is unavailable (no search key) — research runs fetch-only.",
	};
}

async function checkDemo(
	engine: PiEngine,
	abortSignal: AbortSignal,
	onUsage: (u: Usage) => void,
): Promise<Verdict> {
	const result: DemoResult = await runDemoBuilder(
		{
			title: "Health check",
			brief: "One button labelled 'Click' and, beside it, the text 'Count: 0' that increments by one on every click. Plain, minimal, no libraries.",
		},
		{ engine, abortSignal, onUsage },
	);
	if (isSubagentFailure("demo" satisfies JobKind, result)) {
		return { ok: false, detail: result.notes ?? "The demo builder returned no HTML." };
	}
	return { ok: true, detail: "Built a demo and ran it in headless Chrome without errors." };
}

async function checkVisual(
	engine: PiEngine,
	abortSignal: AbortSignal,
	onUsage: (u: Usage) => void,
): Promise<Verdict> {
	const result: VisualResult = await runVisualMaker(
		{ brief: "A 100x100 viewBox with a red filled circle of radius 30 centered at (50, 50) and the label 'ok' in black, centered under the circle." },
		{ engine, abortSignal, onUsage },
	);
	if (isSubagentFailure("visual" satisfies JobKind, result) || !/<svg[\s>]/i.test(result.svg)) {
		return { ok: false, detail: result.notes ?? "The figure maker returned no SVG." };
	}
	return { ok: true, detail: "Drew an SVG, rendered it, and inspected the render." };
}
