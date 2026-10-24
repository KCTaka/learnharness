import {
	createProvider,
	envApiKeyAuth,
	type Model,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * The Nonlocally central-GPU provider: an OpenAI-compatible Chat Completions
 * endpoint (mit.nonlocally.org) that is not in pi-ai's builtin catalogs, so
 * it is declared here with createProvider() and registered in piModels().
 *
 * The key (an `nlm_…` model key, NOT the sk- website key) rides in the same
 * auth seam as every other provider — NONLOCALLY_MODEL_API_KEY, the name
 * Nonlocally's own client setup uses — and the model list is discovered from
 * GET /v1/models, OVERLAID on a static baseline (pi-ai merges by id) so the
 * models stay pinnable at boot and offline. Trade-off, chosen by the owner:
 * a key scoped to fewer models than the baseline still lists the rest.
 */

export const NONLOCALLY_PROVIDER_ID = "nonlocally";
export const NONLOCALLY_ENV_VAR = "NONLOCALLY_MODEL_API_KEY";
export const NONLOCALLY_BASE_URL = "https://mit.nonlocally.org/v1";

/** /v1/models reports only id + max_output_tokens; the rest is assumed.
 *  128k is a deliberate floor (the server does not report its window). Both
 *  models always reason server-side (reasoning_content comes back
 *  regardless) but ignore `reasoning_effort` — measured 2026-10-24 — so
 *  reasoning stays false: pi sends no effort param and the thinking picker
 *  honestly offers only "off". */
const ASSUMED_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 32_000;

/** Image input measured per model (2026-10-24): glm accepts images,
 *  deepseek-v4.1-flash answers "vision not enabled". Unknown ids are text. */
const IMAGE_MODEL_IDS: ReadonlySet<string> = new Set(["glm"]);

const BASELINE: ReadonlyArray<{ id: string; name: string; maxTokens: number }> = [
	{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", maxTokens: 65_536 },
	{ id: "glm", name: "GLM-5.3-Flash", maxTokens: 131_072 },
];

function nonlocallyModel(id: string, name: string, maxTokens: number): Model<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: NONLOCALLY_PROVIDER_ID,
		baseUrl: NONLOCALLY_BASE_URL,
		reasoning: false,
		input: IMAGE_MODEL_IDS.has(id) ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: ASSUMED_CONTEXT_WINDOW,
		maxTokens,
		// A vLLM-style server, not OpenAI: no `store`, no developer role, no
		// reasoning_effort, `max_tokens`; streaming usage verified.
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
		},
	};
}

interface ModelsListResponse {
	data?: Array<{ id?: unknown; max_output_tokens?: unknown; availability?: unknown }>;
}

/** GET /v1/models → the key's usable models. Throws on any failure (pi-ai
 *  keeps the previous list and reports the error from refresh()). */
async function fetchNonlocallyModels({
	credential,
	signal,
}: RefreshModelsContext): Promise<Model<"openai-completions">[]> {
	const key = credential?.type === "api_key" ? credential.key : undefined;
	if (!key) throw new Error("Nonlocally model discovery needs an API key");
	const res = await fetch(`${NONLOCALLY_BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${key}` },
		signal,
	});
	if (!res.ok) throw new Error(`Nonlocally GET /models failed: HTTP ${res.status}`);
	const body = (await res.json()) as ModelsListResponse;
	const baselineNames = new Map(BASELINE.map((m) => [m.id, m.name]));
	const models: Model<"openai-completions">[] = [];
	for (const entry of body.data ?? []) {
		if (typeof entry.id !== "string" || entry.id === "") continue;
		if (entry.availability !== undefined && entry.availability !== "available") continue;
		const maxTokens =
			typeof entry.max_output_tokens === "number" && entry.max_output_tokens > 0
				? entry.max_output_tokens
				: FALLBACK_MAX_TOKENS;
		models.push(nonlocallyModel(entry.id, baselineNames.get(entry.id) ?? entry.id, maxTokens));
	}
	return models;
}

export function nonlocallyProvider(): Provider {
	return createProvider({
		id: NONLOCALLY_PROVIDER_ID,
		name: "Nonlocally",
		baseUrl: NONLOCALLY_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Nonlocally model API key", [NONLOCALLY_ENV_VAR]) },
		models: BASELINE.map((m) => nonlocallyModel(m.id, m.name, m.maxTokens)),
		fetchModels: fetchNonlocallyModels,
		api: openAICompletionsApi(),
	}) as Provider;
}
