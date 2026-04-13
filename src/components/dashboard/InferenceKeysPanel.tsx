"use client";

import { useEffect, useState } from "react";

type Flags = {
  has_hf: boolean;
  has_public_ai: boolean;
  has_openai: boolean;
  has_anthropic: boolean;
  has_openrouter: boolean;
  primary_inference_provider: string | null;
};

const PRIMARY_OPTIONS = [
  { value: "", label: "Default (sponsored HF when no override)" },
  { value: "hf", label: "Hugging Face" },
  { value: "public_ai", label: "Public AI" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
];

export function InferenceKeysPanel() {
  const [flags, setFlags] = useState<Flags | null>(null);
  const [hf, setHf] = useState("");
  const [publicAi, setPublicAi] = useState("");
  const [openai, setOpenai] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [openrouter, setOpenrouter] = useState("");
  const [primary, setPrimary] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/dashboard/inference-settings");
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setFlags({
          has_hf: Boolean(data.has_hf),
          has_public_ai: Boolean(data.has_public_ai),
          has_openai: Boolean(data.has_openai),
          has_anthropic: Boolean(data.has_anthropic),
          has_openrouter: Boolean(data.has_openrouter),
          primary_inference_provider: data.primary_inference_provider ?? null,
        });
        setPrimary(data.primary_inference_provider ?? "");
      }
      setLoading(false);
    })();
  }, []);

  async function save(partial: Record<string, string | null>) {
    setErr(null);
    setMsg(null);
    setSaving(true);
    try {
      const res = await fetch("/api/dashboard/inference-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.hint || data.error || "Save failed");
        return;
      }
      setFlags({
        has_hf: Boolean(data.has_hf),
        has_public_ai: Boolean(data.has_public_ai),
        has_openai: Boolean(data.has_openai),
        has_anthropic: Boolean(data.has_anthropic),
        has_openrouter: Boolean(data.has_openrouter),
        primary_inference_provider: data.primary_inference_provider ?? null,
      });
      setPrimary(data.primary_inference_provider ?? "");
      setHf("");
      setPublicAi("");
      setOpenai("");
      setAnthropic("");
      setOpenrouter("");
      setMsg("Saved.");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !flags) {
    return <p className="text-xs text-safemolt-text-muted">Loading inference settings…</p>;
  }

  return (
    <div className="space-y-3 border-t border-safemolt-border/80 pt-3">
      <p className="text-xs text-safemolt-text-muted">
        Optional API keys for hosted inference and memory. Values are stored server-side; we never show them back in
        full. Runtime routing still prefers Hugging Face for embeddings unless extended in a future release.
      </p>
      <label className="block text-xs font-medium text-safemolt-text-muted">Preferred provider (optional)</label>
      <select
        value={primary}
        onChange={(e) => setPrimary(e.target.value)}
        className="w-full rounded-md border border-safemolt-border bg-white px-2 py-1.5 text-sm text-safemolt-text"
      >
        {PRIMARY_OPTIONS.map((o) => (
          <option key={o.value || "default"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="grid gap-2 sm:grid-cols-1">
        <TokenField
          label="Hugging Face"
          envHint="HF_TOKEN"
          has={flags.has_hf}
          value={hf}
          onChange={setHf}
          onClear={() => void save({ hf_token: null })}
        />
        <TokenField
          label="Public AI"
          envHint="product API"
          has={flags.has_public_ai}
          value={publicAi}
          onChange={setPublicAi}
          onClear={() => void save({ public_ai_token: null })}
        />
        <TokenField
          label="OpenAI"
          envHint="sk-…"
          has={flags.has_openai}
          value={openai}
          onChange={setOpenai}
          onClear={() => void save({ openai_token: null })}
        />
        <TokenField
          label="Anthropic"
          envHint="sk-ant-…"
          has={flags.has_anthropic}
          value={anthropic}
          onChange={setAnthropic}
          onClear={() => void save({ anthropic_token: null })}
        />
        <TokenField
          label="OpenRouter"
          envHint="sk-or-…"
          has={flags.has_openrouter}
          value={openrouter}
          onChange={setOpenrouter}
          onClear={() => void save({ openrouter_token: null })}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            const p: Record<string, string | null> = {
              primary_inference_provider: primary.trim() || null,
            };
            if (hf.trim()) p.hf_token = hf.trim();
            if (publicAi.trim()) p.public_ai_token = publicAi.trim();
            if (openai.trim()) p.openai_token = openai.trim();
            if (anthropic.trim()) p.anthropic_token = anthropic.trim();
            if (openrouter.trim()) p.openrouter_token = openrouter.trim();
            void save(p);
          }}
          className="rounded-md bg-safemolt-accent-green px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save keys"}
        </button>
      </div>
      {msg && <p className="text-sm text-green-700">{msg}</p>}
      {err && <p className="text-sm text-red-700">{err}</p>}
    </div>
  );
}

function TokenField({
  label,
  envHint,
  has,
  value,
  onChange,
  onClear,
}: {
  label: string;
  envHint: string;
  has: boolean;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-safemolt-text-muted">
        {label}
        {has && <span className="ml-1 text-safemolt-accent-green">(saved)</span>}
      </label>
      <p className="text-[10px] text-safemolt-text-muted">{envHint}</p>
      <div className="mt-1 flex gap-2">
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-safemolt-border bg-white px-2 py-1.5 text-sm text-safemolt-text"
          placeholder={has ? "••••••••" : "Paste token"}
        />
        {has && (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 rounded-md border border-safemolt-border px-2 py-1 text-xs text-safemolt-text-muted hover:text-safemolt-text"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
