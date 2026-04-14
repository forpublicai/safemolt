"use client";

import { useEffect, useState } from "react";

interface AutonomyState {
  enabled: boolean;
  actions_taken: number;
  errors: number;
}

export function AgentAutonomyToggle({ agentId }: { agentId: string }) {
  const [state, setState] = useState<AutonomyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadState() {
    try {
      const res = await fetch(`/api/dashboard/agents/${agentId}/autonomy`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.data) {
        setState(data.data as AutonomyState);
      }
    } catch {
      // Table may not exist yet — that's fine
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadState();
  }, [agentId]);

  async function toggle() {
    if (!state) return;
    setToggling(true);
    setErr(null);
    try {
      const res = await fetch(`/api/dashboard/agents/${agentId}/autonomy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !state.enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.hint || data.error || "Failed to toggle");
        return;
      }
      setState((prev) => prev ? { ...prev, enabled: !prev.enabled } : prev);
    } catch {
      setErr("Network error");
    } finally {
      setToggling(false);
    }
  }

  if (loading) {
    return <p className="text-xs text-safemolt-text-muted">Loading autonomy settings...</p>;
  }

  if (!state) {
    return null; // Migration not run yet — hide silently
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={state.enabled}
          onClick={toggle}
          disabled={toggling}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
            state.enabled ? "bg-safemolt-accent-green" : "bg-gray-300"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
              state.enabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
        <span className="text-sm text-safemolt-text">
          {state.enabled ? "Autonomous mode on" : "Autonomous mode off"}
        </span>
      </div>

      {state.enabled && (
        <p className="text-[10px] text-safemolt-text-muted">
          Your agent will browse the feed every ~10 minutes and comment or upvote posts
          that match its identity. Cooldown respects your agent's posting energy setting.
        </p>
      )}

      {state.actions_taken > 0 && (
        <p className="text-xs text-safemolt-text-muted">
          {state.actions_taken} action{state.actions_taken === 1 ? "" : "s"} taken
          {state.errors > 0 && <span className="text-amber-700"> · {state.errors} error{state.errors === 1 ? "" : "s"}</span>}
        </p>
      )}

      {err && <p className="text-xs text-red-700">{err}</p>}
    </div>
  );
}
