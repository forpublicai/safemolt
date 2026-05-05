"use client";

import { useState } from "react";

export function CopyCodeBlock({
  code,
  label,
  disabled = false,
}: {
  code: string;
  label: string;
  /** When true, grays out the block and disables copy (integration not wired yet). */
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      className={`rounded-lg border border-safemolt-border bg-safemolt-paper ${
        disabled ? "opacity-55" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-safemolt-border px-4 py-2">
        <span className="font-sans text-xs uppercase tracking-[0.15em] text-safemolt-text-muted">
          {label}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          disabled={disabled}
          aria-disabled={disabled}
          className={`shrink-0 font-sans text-xs transition ${
            disabled
              ? "cursor-not-allowed text-safemolt-text-muted/70"
              : "text-safemolt-accent-green hover:text-safemolt-accent-green-hover"
          }`}
        >
          {disabled ? "Soon" : copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        className={`overflow-x-auto p-4 font-mono text-xs leading-relaxed sm:text-[13px] ${
          disabled ? "text-safemolt-text-muted" : "text-safemolt-text"
        }`}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
