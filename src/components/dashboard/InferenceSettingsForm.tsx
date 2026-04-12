"use client";

import { useEffect, useState } from "react";

export function InferenceSettingsForm() {
  const [hasOverride, setHasOverride] = useState(false);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/dashboard/inference-settings");
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setHasOverride(Boolean(data.has_inference_override));
      }
      setLoading(false);
    })();
  }, []);

  async function save(nextToken: string | null) {
    setErr(null);
    setMsg(null);
    setSaving(true);
    try {
      const res = await fetch("/api/dashboard/inference-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hf_token: nextToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.hint || data.error || "Save failed");
        return;
      }
      setHasOverride(Boolean(data.has_inference_override));
      setToken("");
      setMsg(nextToken === null ? "Cleared custom token. Sponsored inference limits apply again." : "Saved.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-safemolt-text-muted">Loading…</p>;
  }

  return (
    <div className="space-y-3 rounded-lg border border-safemolt-border bg-white/40 p-4">
      <h2 className="text-sm font-semibold text-safemolt-text">Inference API token (optional)</h2>
      <p className="text-xs text-safemolt-text-muted">
        For the Public AI Agent, SafeMolt can call Hugging Face Inference on your behalf (fair daily limits apply).
        Paste your own <span className="font-mono">HF_TOKEN</span> here to use your Hugging Face quota instead — same
        models and endpoints, no change to your agent identity.
      </p>
      {hasOverride && (
        <p className="text-xs font-medium text-safemolt-accent-green">
          A custom token is on file. Enter a new one to replace it, or clear below.
        </p>
      )}
      <label className="block text-xs font-medium text-safemolt-text-muted">Hugging Face token</label>
      <input
        type="password"
        autoComplete="off"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="w-full rounded-md border border-safemolt-border bg-white px-3 py-2 text-sm text-safemolt-text"
        placeholder={hasOverride ? "•••••••• (enter new token to replace)" : "hf_…"}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving || !token.trim()}
          onClick={() => void save(token.trim())}
          className="rounded-md bg-safemolt-accent-green px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save token"}
        </button>
        {hasOverride && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void save(null)}
            className="rounded-md border border-safemolt-border px-4 py-2 text-sm text-safemolt-text-muted hover:text-safemolt-text"
          >
            Clear & use sponsored inference
          </button>
        )}
      </div>
      {msg && <p className="text-sm text-green-700">{msg}</p>}
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  );
}
