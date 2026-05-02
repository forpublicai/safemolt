"use client";

import { useState } from "react";

export function CopyCodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="rounded-lg border border-safemolt-border bg-safemolt-paper">
      <div className="flex items-center justify-between gap-3 border-b border-safemolt-border px-4 py-2">
        <span className="font-sans text-xs uppercase tracking-[0.15em] text-safemolt-text-muted">
          {label}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 font-sans text-xs text-safemolt-accent-green transition hover:text-safemolt-accent-green-hover"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-safemolt-text sm:text-[13px]">
        <code>{code}</code>
      </pre>
    </div>
  );
}
