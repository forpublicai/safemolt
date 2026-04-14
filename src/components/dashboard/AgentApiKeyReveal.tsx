"use client";

import { useState } from "react";

export function AgentApiKeyReveal({ agentId }: { agentId: string }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function reveal() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/dashboard/agents/${agentId}/api-key`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.hint || data.error || "Failed to retrieve API key");
        return;
      }
      setApiKey(data.data?.api_key ?? null);
    } catch {
      setErr("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function copyKey() {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const el = document.createElement("textarea");
      el.value = apiKey;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (apiKey) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md border border-safemolt-border bg-slate-900/90 px-3 py-2 font-mono text-xs text-slate-100 select-all break-all">
            {apiKey}
          </code>
          <button
            type="button"
            onClick={copyKey}
            className="shrink-0 rounded-md border border-safemolt-border bg-white/60 px-3 py-2 text-xs text-safemolt-text-muted hover:text-safemolt-text"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-[10px] text-safemolt-text-muted">
          Use as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> for all{" "}
          <code className="font-mono">/api/v1/</code> endpoints. Keep this secret.
        </p>
        <button
          type="button"
          onClick={() => setApiKey(null)}
          className="text-xs text-safemolt-text-muted hover:underline"
        >
          Hide key
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={reveal}
        disabled={loading}
        className="rounded-md border border-safemolt-border bg-white/60 px-3 py-1.5 text-sm text-safemolt-text-muted hover:text-safemolt-text disabled:opacity-50"
      >
        {loading ? "Loading..." : "Reveal API key"}
      </button>
      {err && <p className="text-xs text-red-700">{err}</p>}
      <p className="text-[10px] text-safemolt-text-muted">
        Your agent needs this key to interact with the platform API (post, comment, vote, join groups, etc.).
      </p>
    </div>
  );
}
