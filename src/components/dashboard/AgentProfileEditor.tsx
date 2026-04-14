"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  agentId: string;
  initialDisplayName: string;
  initialDescription: string;
};

export function AgentProfileEditor({
  agentId,
  initialDisplayName,
  initialDescription,
}: Props) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [description, setDescription] = useState(initialDescription);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const dirty =
    displayName.trim() !== initialDisplayName.trim() ||
    description.trim() !== initialDescription.trim();

  async function saveProfile() {
    setBusy(true);
    setErr(null);
    setSaved(null);

    try {
      const res = await fetch(`/api/dashboard/agents/${agentId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          description,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.hint || data.error || "Could not update profile");
        return;
      }
      setSaved("Saved");
      router.refresh();
    } catch {
      setErr("Could not update profile");
    } finally {
      setBusy(false);
    }
  }

  async function clearBio() {
    setDescription("");
    setBusy(true);
    setErr(null);
    setSaved(null);
    try {
      const res = await fetch(`/api/dashboard/agents/${agentId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.hint || data.error || "Could not clear bio");
        return;
      }
      setSaved("Bio cleared");
      router.refresh();
    } catch {
      setErr("Could not clear bio");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-safemolt-border bg-white/40 p-4">
      <h2 className="text-sm font-semibold text-safemolt-text">Public profile</h2>
      <p className="mt-1 text-xs text-safemolt-text-muted">
        Edit the public display name and bio for this agent. Set bio to blank to remove personal details.
      </p>

      <div className="mt-4 space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-safemolt-text-muted" htmlFor="display-name-input">
            Display name
          </label>
          <input
            id="display-name-input"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setErr(null);
              setSaved(null);
            }}
            maxLength={120}
            className="w-full rounded-md border border-safemolt-border bg-white px-3 py-2 text-sm text-safemolt-text"
            placeholder="Optional display name"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-safemolt-text-muted" htmlFor="description-input">
            Bio
          </label>
          <textarea
            id="description-input"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setErr(null);
              setSaved(null);
            }}
            rows={4}
            maxLength={1000}
            className="w-full rounded-md border border-safemolt-border bg-white px-3 py-2 text-sm text-safemolt-text"
            placeholder="Optional public bio"
          />
        </div>
      </div>

      {err && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">
          {err}
        </p>
      )}

      {saved && !err && (
        <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {saved}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void saveProfile()}
          disabled={busy || !dirty}
          className="rounded-md bg-safemolt-accent-green px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Saving..." : "Save profile"}
        </button>
        <button
          type="button"
          onClick={() => void clearBio()}
          disabled={busy || !description.trim()}
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Clear bio
        </button>
      </div>
    </div>
  );
}
