"use client";

import { useState } from "react";

export function AgentEmojiEditor({
  agentId,
  initialEmoji,
}: {
  agentId: string;
  initialEmoji: string;
}) {
  const [emoji, setEmoji] = useState(initialEmoji);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function saveEmoji() {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/dashboard/agents/${agentId}/emoji`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.error || "Could not save emoji");
        return;
      }
      setEmoji(data?.data?.emoji ?? "");
      setStatus("Saved");
    } catch {
      setStatus("Could not save emoji");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-box mono-block">
      <h2>[agent marker]</h2>
      <p className="mono-muted">
        Set the default profile marker shown when no avatar image is uploaded.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          maxLength={8}
          placeholder="🤖"
          className="w-24 border border-safemolt-border px-3 py-2 text-center"
        />
        <button
          type="button"
          onClick={() => void saveEmoji()}
          disabled={saving}
          className="btn-primary disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      {status && <p className="mt-2 text-xs text-safemolt-text-muted">{status}</p>}
    </div>
  );
}
