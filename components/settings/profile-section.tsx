"use client";
/**
 * The Teaching profile section: what the app has learned about how YOU are
 * best taught. A plain list of sentences (optionally tagged with a subject),
 * each badged with where it came from — inferred from a session, from your
 * end-of-session reflection, or written by you. Edit, delete, add, clear;
 * every change is logged below. The teacher reads this list; you own it.
 * Data: /api/profile (GET/POST/PUT/DELETE) — refetched after each mutation.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ProfileChange, ProfileEntry, ProfileOrigin } from "@/src/core";
import { SettingsGroup } from "./controls.tsx";

const ORIGIN_LABEL: Record<ProfileOrigin, string> = {
	inferred: "inferred",
	reflection: "your reflection",
	manual: "written by you",
};

interface ProfileBody {
	entries: ProfileEntry[];
	changes: ProfileChange[];
}

export function ProfileView({
	profile,
	error,
	editingId,
	confirmingClear,
	onAdd,
	onStartEdit,
	onCancelEdit,
	onSaveEdit,
	onDelete,
	onAskClear,
	onCancelClear,
	onClear,
}: {
	profile: ProfileBody | null;
	error: string | null;
	editingId: string | null;
	confirmingClear: boolean;
	onAdd: (text: string, subject: string) => void;
	onStartEdit: (id: string) => void;
	onCancelEdit: () => void;
	onSaveEdit: (id: string, text: string, subject: string) => void;
	onDelete: (id: string) => void;
	onAskClear: () => void;
	onCancelClear: () => void;
	onClear: () => void;
}) {
	return (
		<div data-testid="profile-section">
			<SettingsGroup label="What the app knows about how you learn" testid="group-profile">
				{error && (
					<p data-testid="profile-error" className="text-xs text-red-500">
						{error}
					</p>
				)}
				{profile === null && !error && <p className="text-xs text-muted-foreground">Loading…</p>}
				{profile && profile.entries.length === 0 && (
					<p data-testid="profile-empty" className="text-sm text-muted-foreground">
						Nothing yet. It fills in as you work through sessions — or add a line yourself below.
					</p>
				)}
				{profile?.entries.map((entry) =>
					editingId === entry.id ? (
						<EntryEditor key={entry.id} entry={entry} onCancel={onCancelEdit} onSave={onSaveEdit} />
					) : (
						<div key={entry.id} data-testid={`profile-entry-${entry.id}`} className="flex items-start justify-between gap-3 py-1">
							<span className="min-w-0">
								<span className="block font-prose text-(length:--lh-prose-size)">{entry.text}</span>
								<span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground/70">
									{entry.subject && (
										<span data-testid="profile-subject" className="rounded border border-border px-1.5 py-px">
											{entry.subject}
										</span>
									)}
									<span data-testid="profile-origin">{ORIGIN_LABEL[entry.origin]}</span>
								</span>
							</span>
							<span className="flex shrink-0 gap-1">
								<Button variant="ghost" size="xs" data-testid={`profile-edit-${entry.id}`} onClick={() => onStartEdit(entry.id)}>
									Edit
								</Button>
								<Button variant="ghost" size="xs" data-testid={`profile-delete-${entry.id}`} onClick={() => onDelete(entry.id)}>
									Delete
								</Button>
							</span>
						</div>
					),
				)}
			</SettingsGroup>

			<SettingsGroup label="Add a line" testid="group-profile-add">
				<AddForm onAdd={onAdd} />
			</SettingsGroup>

			{profile && profile.entries.length > 0 && (
				<SettingsGroup label="Clear" testid="group-profile-clear">
					{confirmingClear ? (
						<div className="flex items-center justify-between gap-3">
							<span className="text-sm text-muted-foreground">Remove every line from your profile?</span>
							<span className="flex gap-1">
								<Button variant="ghost" size="sm" onClick={onCancelClear}>
									Cancel
								</Button>
								<Button variant="destructive" size="sm" data-testid="profile-clear-confirm" onClick={onClear}>
									Clear profile
								</Button>
							</span>
						</div>
					) : (
						<div className="flex justify-end">
							<Button variant="outline" size="sm" data-testid="profile-clear" onClick={onAskClear}>
								Clear profile…
							</Button>
						</div>
					)}
				</SettingsGroup>
			)}

			{profile && profile.changes.length > 0 && (
				<SettingsGroup label="Change log" testid="group-profile-log">
					<details data-testid="profile-log">
						<summary className="cursor-pointer text-xs text-muted-foreground">
							{profile.changes.length} change{profile.changes.length === 1 ? "" : "s"}
						</summary>
						<ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
							{[...profile.changes].reverse().map((c, i) => (
								<li key={`${c.at}-${c.entryId}-${i}`}>
									<span className="uppercase tracking-wide">{c.kind}</span> · {new Date(c.at).toLocaleString()} ·{" "}
									{ORIGIN_LABEL[c.origin]} — {c.text}
								</li>
							))}
						</ul>
					</details>
				</SettingsGroup>
			)}
		</div>
	);
}

function EntryEditor({
	entry,
	onCancel,
	onSave,
}: {
	entry: ProfileEntry;
	onCancel: () => void;
	onSave: (id: string, text: string, subject: string) => void;
}) {
	const [text, setText] = useState(entry.text);
	const [subject, setSubject] = useState(entry.subject ?? "");
	return (
		<div data-testid={`profile-editor-${entry.id}`} className="flex flex-col gap-2 py-1">
			<textarea
				value={text}
				onChange={(e) => setText(e.target.value)}
				rows={2}
				className="w-full resize-none rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring"
			/>
			<div className="flex items-center gap-2">
				<input
					value={subject}
					onChange={(e) => setSubject(e.target.value)}
					placeholder="Subject (optional)"
					className="min-w-0 flex-1 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus-visible:border-ring"
				/>
				<Button variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button variant="outline" size="sm" disabled={text.trim() === ""} onClick={() => onSave(entry.id, text, subject)}>
					Save
				</Button>
			</div>
		</div>
	);
}

function AddForm({ onAdd }: { onAdd: (text: string, subject: string) => void }) {
	const [text, setText] = useState("");
	const [subject, setSubject] = useState("");
	return (
		<div className="flex flex-col gap-2">
			<textarea
				data-testid="profile-add-text"
				value={text}
				onChange={(e) => setText(e.target.value)}
				rows={2}
				placeholder="e.g. I follow a worked example much better than a definition."
				className="w-full resize-none rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring"
			/>
			<div className="flex items-center gap-2">
				<input
					data-testid="profile-add-subject"
					value={subject}
					onChange={(e) => setSubject(e.target.value)}
					placeholder="Subject (optional)"
					className="min-w-0 flex-1 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus-visible:border-ring"
				/>
				<Button
					variant="outline"
					size="sm"
					data-testid="profile-add"
					disabled={text.trim() === ""}
					onClick={() => {
						onAdd(text, subject);
						setText("");
						setSubject("");
					}}
				>
					Add
				</Button>
			</div>
		</div>
	);
}

export function ProfileSection() {
	const [profile, setProfile] = useState<ProfileBody | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [confirmingClear, setConfirmingClear] = useState(false);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/profile");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setProfile((await res.json()) as ProfileBody);
			setError(null);
		} catch (err) {
			setError(`Couldn’t load your profile: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/** One mutation: the server's reply is the new truth (or its error line). */
	const mutate = useCallback(async (url: string, init: RequestInit) => {
		try {
			const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
			const body = (await res.json()) as ProfileBody & { error?: string };
			if (!res.ok) {
				setError(body.error ?? `Request failed (${res.status})`);
				return;
			}
			setProfile(body);
			setError(null);
			setEditingId(null);
			setConfirmingClear(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	return (
		<ProfileView
			profile={profile}
			error={error}
			editingId={editingId}
			confirmingClear={confirmingClear}
			onAdd={(text, subject) => void mutate("/api/profile", { method: "POST", body: JSON.stringify({ text, subject }) })}
			onStartEdit={setEditingId}
			onCancelEdit={() => setEditingId(null)}
			onSaveEdit={(id, text, subject) => void mutate("/api/profile", { method: "PUT", body: JSON.stringify({ id, text, subject }) })}
			onDelete={(id) => void mutate("/api/profile", { method: "DELETE", body: JSON.stringify({ id }) })}
			onAskClear={() => setConfirmingClear(true)}
			onCancelClear={() => setConfirmingClear(false)}
			onClear={() => void mutate("/api/profile?all=true", { method: "DELETE" })}
		/>
	);
}
