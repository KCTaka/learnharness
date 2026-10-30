/**
 * POST /api/chats/[id]/wrap-up — the "Wrap up session" action: body
 * {reflection?: string} (the learner's own end-of-session words, skippable).
 * Runs the teaching-profile learning pass over this session NOW; a
 * non-empty reflection is new input and forces a run even when the
 * transcript is unchanged. Never writes into the chat record.
 *
 * 200 {applied, skipped} · 404 unknown chat · 400 practice session ·
 * 409 a turn (or another pass) is running · 503 the strong slot has no
 * model/key (the same machine-readable envelope turns refuse with) ·
 * 500 the pass itself failed (nothing written).
 */
import { runProfilePass } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { reflection?: unknown } | null;
	if (body?.reflection !== undefined && typeof body.reflection !== "string") {
		return Response.json({ error: "reflection must be a string" }, { status: 400 });
	}
	const outcome = await runProfilePass(id, { reflection: body?.reflection as string | undefined });
	if (!outcome.ok) return Response.json(outcome.body ?? { error: outcome.error }, { status: outcome.status });
	return Response.json({ applied: outcome.applied, skipped: outcome.skipped });
}
