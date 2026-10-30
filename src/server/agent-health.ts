import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { runAgentHealthCheck } from "../agent/subagents/health-check.ts";
import type { ModelRole } from "../../config.ts";
import { AGENT_HEALTH_KINDS, type AgentHealthKind, type AgentHealthResult } from "../core/contracts.ts";
import { providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { providerKeyPresent } from "./keys.ts";
import { jobCost } from "./pricing.ts";
import { searchProvider } from "./search.ts";
import { stores } from "./stores.ts";

/**
 * The agent health check's server composition: the same engine resolution,
 * key gate and search seam the job runner is wired with (chat-handler.ts),
 * read fresh per run, plus the price table the agent layer may not touch.
 */

export function isAgentHealthKind(value: unknown): value is AgentHealthKind {
	return typeof value === "string" && (AGENT_HEALTH_KINDS as readonly string[]).includes(value);
}

/** Settings-resolved engine for a role, read fresh (undefined = chain empty). */
export function resolveEngine(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	return spec ? piEngineForSpec(spec) : undefined;
}

export async function checkAgentHealth(kind: AgentHealthKind, signal?: AbortSignal): Promise<AgentHealthResult> {
	const { result, usage } = await runAgentHealthCheck(
		kind,
		{
			engineFor: resolveEngine,
			providerKeyMissing: (provider, tier) =>
				providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
			searchProvider,
		},
		signal,
	);
	return { ...result, cost: usage ? jobCost({ usage }) : undefined };
}
