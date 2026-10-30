"use client";
/**
 * The agent health check (Agent settings → "Test agents"): runs the
 * research, demo and figure agents once each on a tiny canned task — LIVE
 * model calls through POST /api/agents/health, one request per agent — and
 * shows pass/fail, duration, cost and the honest error line. Nothing is
 * persisted: the point is to find a broken agent here, not mid-lesson.
 */

import { useCallback, useRef, useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { formatUsd, prettyModel } from "@/components/usage-format";
import { AGENT_HEALTH_KINDS, type AgentHealthKind, type AgentHealthResult } from "@/src/core";
import { SettingsGroup, SettingsRow } from "./controls.tsx";

const LABEL: Record<AgentHealthKind, string> = {
	research: "Research agent",
	demo: "Demo agent",
	visual: "Figure agent",
};

const HINT: Record<AgentHealthKind, string> = {
	research: "Fetches a known page and reads it back",
	demo: "Builds a tiny demo and runs it in headless Chrome",
	visual: "Draws an SVG, renders it and inspects the render",
};

/** idle = never run this visit; running; or the finished outcome. */
export type AgentHealthState = "idle" | "running" | AgentHealthResult;

export function healthDetailLine(result: AgentHealthResult): string {
	const bits = [
		`${(result.durationMs / 1000).toFixed(1)}s`,
		result.model ? prettyModel(result.model, true) : null,
		typeof result.cost === "number" ? formatUsd(result.cost) : null,
	].filter(Boolean);
	return bits.join(" · ");
}

export function AgentHealthView({
	states,
	onRun,
}: {
	states: Record<AgentHealthKind, AgentHealthState>;
	onRun: () => void;
}) {
	const anyRunning = AGENT_HEALTH_KINDS.some((k) => states[k] === "running");
	return (
		<SettingsGroup label="Agent health" testid="group-health">
			{AGENT_HEALTH_KINDS.map((kind) => {
				const state = states[kind];
				return (
					<SettingsRow key={kind} label={LABEL[kind]} hint={HINT[kind]} testid={`health-${kind}`}>
						<span className="flex items-center gap-2 text-xs text-muted-foreground">
							{state === "running" && <BrailleSpinner label={`${LABEL[kind]} testing`} />}
							{state !== "idle" && state !== "running" && (
								<>
									{state.ok ? (
										<CheckIcon className="size-3.5 text-green-500" aria-label="passed" />
									) : (
										<XIcon className="size-3.5 text-red-500" aria-label="failed" />
									)}
									<span>{healthDetailLine(state)}</span>
								</>
							)}
						</span>
					</SettingsRow>
				);
			})}
			{AGENT_HEALTH_KINDS.map((kind) => {
				const state = states[kind];
				if (state === "idle" || state === "running") return null;
				return (
					<p
						key={kind}
						data-testid={`health-${kind}-detail`}
						className={`text-xs ${state.ok ? "text-muted-foreground/70" : "text-red-500"}`}
					>
						{LABEL[kind]}: {state.detail}
					</p>
				);
			})}
			<div className="flex items-center justify-between gap-4 pt-1">
				<span className="text-xs text-muted-foreground/70">
					Runs each agent on a small real task — uses your models and costs a few cents.
				</span>
				<Button variant="outline" size="sm" data-testid="health-run" disabled={anyRunning} onClick={onRun}>
					{anyRunning ? "Testing…" : "Test agents"}
				</Button>
			</div>
		</SettingsGroup>
	);
}

const IDLE: Record<AgentHealthKind, AgentHealthState> = { research: "idle", demo: "idle", visual: "idle" };

export function AgentHealthGroup() {
	const [states, setStates] = useState<Record<AgentHealthKind, AgentHealthState>>(IDLE);
	const runId = useRef(0);

	const run = useCallback(() => {
		const id = ++runId.current;
		setStates({ research: "running", demo: "running", visual: "running" });
		for (const kind of AGENT_HEALTH_KINDS) {
			void (async () => {
				let outcome: AgentHealthResult;
				try {
					const res = await fetch("/api/agents/health", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ kind }),
					});
					outcome = res.ok
						? ((await res.json()) as AgentHealthResult)
						: { kind, ok: false, durationMs: 0, detail: `The health check request failed (HTTP ${res.status}).` };
				} catch (err) {
					outcome = {
						kind,
						ok: false,
						durationMs: 0,
						detail: err instanceof Error ? err.message : "The health check request failed.",
					};
				}
				if (runId.current === id) setStates((prev) => ({ ...prev, [kind]: outcome }));
			})();
		}
	}, []);

	return <AgentHealthView states={states} onRun={run} />;
}
