"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import type { ChatListItem } from "@/src/core";

/**
 * "Wrap up session" — the explicit end-of-session reflection (teaching
 * profile). One skippable free-text box: what helped, what didn't. Submitting
 * runs the profile learning pass over this session NOW, with the reflection
 * as explicit evidence (POST /api/chats/[id]/wrap-up); nothing is written
 * into the transcript. Same portal/Esc/backdrop shape as the delete dialog.
 *
 * Failures render honestly with the server's own line and keep the dialog
 * open (409 a turn is running · 503 no strong-slot model/key).
 */

export const WRAP_UP_COPY = {
	title: "Wrap up session",
	body: "The app learns how you’re best taught from how a session went. Tell it what helped and what didn’t — or skip, and it will go by your answers alone.",
	placeholder: "What helped? What didn’t?",
};

export function WrapUpDialog({
	chat,
	onClose,
}: {
	/** The session being wrapped up; null = closed. */
	chat: Pick<ChatListItem, "id" | "title"> | null;
	onClose: () => void;
}) {
	const [reflection, setReflection] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});

	useEffect(() => {
		if (!chat) {
			setReflection("");
			setBusy(false);
			setFailure(null);
			setDone(null);
		}
	}, [chat]);

	useEffect(() => {
		if (!chat) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				if (!busy) onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [chat, busy, onClose]);

	const run = async () => {
		if (!chat || busy) return;
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/chats/${chat.id}/wrap-up`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reflection }),
			});
			const body = (await res.json().catch(() => ({}))) as { error?: string; applied?: number; skipped?: string | null };
			if (!res.ok) {
				setFailure(body.error ?? `Wrap-up failed (${res.status})`);
				setBusy(false);
				return;
			}
			setDone(
				body.skipped === "unchanged"
					? "Nothing new since the last update."
					: body.skipped === "no_checks"
						? "No answered checks yet — nothing to learn from."
						: `Done — ${body.applied ?? 0} profile update${body.applied === 1 ? "" : "s"}.`,
			);
			setBusy(false);
		} catch {
			setFailure("Wrap-up failed — network error. Try again.");
			setBusy(false);
		}
	};

	if (!chat) return null;

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<WrapUpBody
				chat={chat}
				reflection={reflection}
				busy={busy}
				failure={failure}
				done={done}
				onReflection={setReflection}
				onClose={onClose}
				onRun={() => void run()}
			/>
		</div>,
		document.body,
	);
}

/** The dialog's pure body — exported for SSR pins. */
export function WrapUpBody({
	chat,
	reflection,
	busy,
	failure,
	done,
	onReflection,
	onClose,
	onRun,
}: {
	chat: Pick<ChatListItem, "id" | "title">;
	reflection: string;
	busy: boolean;
	failure: string | null;
	done: string | null;
	onReflection: (next: string) => void;
	onClose: () => void;
	onRun: () => void;
}) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={WRAP_UP_COPY.title}
			data-testid="wrap-up-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold">{WRAP_UP_COPY.title}</h2>
			<div className="mt-1.5">
				<code className="font-mono text-sm text-foreground">{chat.title}</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">{WRAP_UP_COPY.body}</p>
			<textarea
				data-testid="wrap-up-reflection"
				value={reflection}
				onChange={(e) => onReflection(e.target.value)}
				disabled={busy || done !== null}
				rows={4}
				placeholder={WRAP_UP_COPY.placeholder}
				className="mt-3 w-full resize-none rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring"
			/>
			{failure && (
				<div data-testid="wrap-up-failure" className="mt-3 rounded-lg border border-destructive/40 px-3 py-2 text-xs text-destructive">
					{failure}
				</div>
			)}
			{done && (
				<div data-testid="wrap-up-done" className="mt-3 text-xs text-muted-foreground">
					{done}
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="wrap-up-cancel"
					onClick={onClose}
					disabled={busy}
					className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
				>
					{done ? "Close" : "Cancel"}
				</button>
				{!done && (
					<button
						type="button"
						data-testid="wrap-up-submit"
						onClick={onRun}
						disabled={busy}
						className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
					>
						{busy ? "Updating…" : reflection.trim() ? "Wrap up" : "Skip reflection & wrap up"}
					</button>
				)}
			</div>
		</div>
	);
}
