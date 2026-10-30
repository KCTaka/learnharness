/**
 * POST /api/agents/health — settings → Agent → "Test agents". Body
 * {kind: "research"|"demo"|"visual"}: runs that sub-agent once on a tiny
 * canned task (a LIVE model call — it bills a few cents) and returns an
 * AgentHealthResult. One kind per request so the UI shows each agent's
 * progress on its own and can run them side by side. Nothing is persisted:
 * no job record, no steer, no chat. A client disconnect aborts the run.
 */
import { checkAgentHealth, isAgentHealthKind } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const kind = (body as { kind?: unknown } | null)?.kind;
	if (!isAgentHealthKind(kind)) {
		return Response.json({ error: "kind must be research, demo or visual" }, { status: 400 });
	}
	return Response.json(await checkAgentHealth(kind, req.signal));
}
