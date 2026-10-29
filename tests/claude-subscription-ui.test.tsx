import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { TurnUsage } from "../src/core/index.ts";
import { StatsBar } from "../components/stats-bar.tsx";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement | undefined;
const step = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined };
const turn = (model: string, id: string): TurnUsage => ({ id, messageId: id, at: "2026-10-24T00:00:00Z", model, steps: [step] });
async function unmount() { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; }
async function statsLinks(turns: TurnUsage[]) {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<StatsBar turns={turns} />));
	const toggle = host.querySelector<HTMLElement>("[aria-expanded]"); assert(toggle);
	await act(async () => toggle.click());
	return [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="stats-detail"] a')].map((a) => [a.textContent, a.getAttribute("href")]);
}
afterEach(unmount);

test("Claude subscription turns link to Claude usage; API-key Claude and other subscriptions do not", async () => {
	assert.deepEqual(await statsLinks([turn("anthropic-subscription:claude-sonnet-4-5", "claude")]), [["Manage Claude usage", "https://claude.ai/settings/usage"]]);
	await unmount();
	assert.deepEqual(await statsLinks([turn("anthropic:claude-sonnet-4-5", "api"), turn("xai-subscription:grok", "grok")]), []);
});
