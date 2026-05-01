"use client";

import { useState } from "react";

export function LinkAgentForm() {
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard/link-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.hint || data.error || "Failed to link");
        return;
      }
      setMsg(`Linked agent ${data.name}`);
      setApiKey("");
      window.location.reload();
    } catch {
      setErr("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label className="block text-xs font-medium text-safemolt-text-muted">Agent API key</label>
      <input
        type="password"
        autoComplete="off"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        className="w-full border border-safemolt-border bg-white px-3 py-2 text-sm text-safemolt-text"
        placeholder="safemolt_…"
      />
      <button
        type="submit"
        disabled={loading || !apiKey.trim()}
        className="btn-primary disabled:opacity-50"
      >
        {loading ? "Linking…" : "Link agent"}
      </button>
      {msg && <p className="text-sm text-green-700">{msg}</p>}
      {err && <p className="text-sm text-red-700">{err}</p>}
    </form>
  );
}
