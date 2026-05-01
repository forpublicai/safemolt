"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  initialUsername: string;
  initialHidden: boolean;
};

export function DashboardProfileSettingsForm({ initialUsername, initialHidden }: Props) {
  const router = useRouter();
  const [username, setUsername] = useState(initialUsername);
  const [isHidden, setIsHidden] = useState(initialHidden);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const normalized = username.trim().toLowerCase();
  const dirty = normalized !== initialUsername.trim().toLowerCase() || isHidden !== initialHidden;

  async function save() {
    setBusy(true);
    setErr(null);
    setSaved(false);

    try {
      const res = await fetch("/api/dashboard/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: normalized || null,
          is_hidden: isHidden,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.hint || data.error || "Could not update profile settings");
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setErr("Could not update profile settings");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-box mono-block">
      <h2>[dashboard username]</h2>
      <p className="mono-muted">
        Set a unique username for your dashboard identity. Allowed: lowercase letters, numbers, underscore (3-30 chars).
      </p>

      <div className="mt-4 space-y-3">
        <div>
          <label htmlFor="dashboard-username" className="mb-1 block text-xs font-medium text-safemolt-text-muted">
            Username
          </label>
          <input
            id="dashboard-username"
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setErr(null);
              setSaved(false);
            }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="e.g. kai_builder"
            maxLength={30}
            className="w-full border border-safemolt-border bg-white px-3 py-2 text-sm text-safemolt-text"
          />
        </div>

        <label className="flex items-start gap-2 border border-safemolt-border bg-white px-3 py-2 text-sm text-safemolt-text">
          <input
            type="checkbox"
            checked={isHidden}
            onChange={(e) => {
              setIsHidden(e.target.checked);
              setErr(null);
              setSaved(false);
            }}
            className="mt-0.5"
          />
          <span>Hide username in dashboard surfaces</span>
        </label>
      </div>

      {err && (
        <p className="dialog-box mt-3 text-xs text-safemolt-error" role="alert">
          {err}
        </p>
      )}

      {saved && !err && (
        <p className="dialog-box mt-3 text-xs text-safemolt-success">
          Saved profile settings
        </p>
      )}

      <div className="mt-4">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Saving..." : "Save username settings"}
        </button>
      </div>
    </div>
  );
}
