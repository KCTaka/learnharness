import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import {
	NONLOCALLY_BASE_URL,
	NONLOCALLY_ENV_VAR,
	NONLOCALLY_PROVIDER_ID,
	nonlocallyProvider,
} from "../src/agent/nonlocally.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function freshModels(env: Record<string, string | undefined>) {
	const models = createModels({ authContext: { env: async (name) => env[name], fileExists: async () => false } });
	models.setProvider(nonlocallyProvider());
	return models;
}

describe("nonlocally provider", () => {
	it("ships a static baseline before any refresh", () => {
		const models = freshModels({});
		const ids = models.getModels(NONLOCALLY_PROVIDER_ID).map((m) => m.id).sort();
		assert.deepEqual(ids, ["deepseek-v4.1-flash", "glm"]);
		for (const m of models.getModels(NONLOCALLY_PROVIDER_ID)) {
			assert.equal(m.api, "openai-completions");
			assert.equal(m.baseUrl, NONLOCALLY_BASE_URL);
			assert.equal(m.contextWindow, 128_000);
			assert.equal(m.reasoning, false);
		}
	});

	it("images: glm yes, deepseek no", () => {
		const models = freshModels({});
		assert.deepEqual(models.getModel(NONLOCALLY_PROVIDER_ID, "glm")?.input, ["text", "image"]);
		assert.deepEqual(models.getModel(NONLOCALLY_PROVIDER_ID, "deepseek-v4.1-flash")?.input, ["text"]);
	});

	it("resolves its key from NONLOCALLY_MODEL_API_KEY", async () => {
		const models = freshModels({ [NONLOCALLY_ENV_VAR]: "nlm_dummy" });
		const auth = await models.getAuth(NONLOCALLY_PROVIDER_ID);
		assert.equal(auth?.source, NONLOCALLY_ENV_VAR);
		assert.equal(auth?.auth.apiKey, "nlm_dummy");
	});

	it("refresh discovers GET /v1/models with a bearer key and maps max_output_tokens", async () => {
		const seen: { url: string; auth: string | null }[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			seen.push({ url: request.url, auth: request.headers.get("authorization") });
			return Response.json({
				data: [
					{ id: "glm", availability: "available", max_output_tokens: 1234 },
					{ id: "future-model", availability: "available", max_output_tokens: 99 },
					{ id: "down-model", availability: "unavailable", max_output_tokens: 5 },
					{ id: "", max_output_tokens: 5 },
				],
			});
		}) as typeof fetch;
		const models = freshModels({ [NONLOCALLY_ENV_VAR]: "nlm_dummy" });
		const result = await models.refresh({ providers: [NONLOCALLY_PROVIDER_ID], force: true });
		assert.equal(result.errors.size, 0);
		assert.deepEqual(seen, [{ url: `${NONLOCALLY_BASE_URL}/models`, auth: "Bearer nlm_dummy" }]);
		const list = models.getModels(NONLOCALLY_PROVIDER_ID);
		// Discovery OVERLAYS the baseline (owner choice): a discovered id is
		// added, the baseline stays pinnable, unavailable/blank ids are dropped.
		assert.deepEqual(list.map((m) => m.id).sort(), ["deepseek-v4.1-flash", "future-model", "glm"]);
		assert.equal(list.find((m) => m.id === "glm")?.maxTokens, 1234);
		assert.equal(list.find((m) => m.id === "glm")?.name, "GLM-5.3-Flash");
		assert.equal(list.find((m) => m.id === "future-model")?.name, "future-model");
	});

	it("a failed refresh keeps the baseline", async () => {
		globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
		const models = freshModels({ [NONLOCALLY_ENV_VAR]: "nlm_dummy" });
		await models.refresh({ providers: [NONLOCALLY_PROVIDER_ID], force: true });
		assert.deepEqual(
			models.getModels(NONLOCALLY_PROVIDER_ID).map((m) => m.id).sort(),
			["deepseek-v4.1-flash", "glm"],
		);
	});
});
