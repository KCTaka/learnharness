/**
 * /api/profile — the learner's teaching profile (settings → Teaching profile).
 * GET reads it; POST {text, subject?} adds an entry; PUT {id, text, subject?}
 * edits one; DELETE {id} removes one; DELETE ?all=true clears every entry.
 * Every write here is origin "manual" and lands in the change log. The
 * `learned` bookkeeping never leaves the server. The post-session learning
 * pass writes through the same server module, not through this route.
 */
import { applyManualOps, clearProfile, readProfile } from "@/src/server";
import type { ProfileOp, TeachingProfile } from "@/src/core";

export const dynamic = "force-dynamic";

function view(profile: TeachingProfile) {
	return { entries: profile.entries, changes: profile.changes };
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
	const parsed = (await req.json().catch(() => null)) as unknown;
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

function mutate(op: ProfileOp): Response {
	try {
		return Response.json(view(applyManualOps([op])));
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
	}
}

export async function GET() {
	return Response.json(view(readProfile()));
}

export async function POST(req: Request) {
	const b = await body(req);
	if (typeof b?.text !== "string") return Response.json({ error: "text must be a string" }, { status: 400 });
	return mutate({ op: "add", text: b.text, ...(typeof b.subject === "string" ? { subject: b.subject } : {}) });
}

export async function PUT(req: Request) {
	const b = await body(req);
	if (typeof b?.id !== "string" || typeof b.text !== "string") {
		return Response.json({ error: "id and text must be strings" }, { status: 400 });
	}
	return mutate({ op: "edit", id: b.id, text: b.text, ...(typeof b.subject === "string" ? { subject: b.subject } : {}) });
}

export async function DELETE(req: Request) {
	if (new URL(req.url).searchParams.get("all") === "true") return Response.json(view(clearProfile()));
	const b = await body(req);
	if (typeof b?.id !== "string") return Response.json({ error: "id must be a string (or pass ?all=true to clear)" }, { status: 400 });
	return mutate({ op: "remove", id: b.id });
}
