"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { InferenceKeysPanel } from "./InferenceKeysPanel";

export type AgentRowDto = {
  id: string;
  name: string;
  displayName: string | null;
  points: number;
  linkRole: string;
};

export function MyAgentsList({
  agents,
  sponsoredRemaining,
  sponsoredLimit,
}: {
  agents: AgentRowDto[];
  sponsoredRemaining: number;
  sponsoredLimit: number;
}) {
  const [withdrawTarget, setWithdrawTarget] = useState<AgentRowDto | null>(null);
  const [withdrawName, setWithdrawName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [connectAgent, setConnectAgent] = useState<AgentRowDto | null>(null);
  const [connectJson, setConnectJson] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectErr, setConnectErr] = useState<string | null>(null);

  async function unlink(agentId: string) {
    setErr(null);
    const res = await fetch("/api/dashboard/unlink-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(data.hint || data.error || "Unlink failed");
      return;
    }
    window.location.reload();
  }

  async function exportVectorMemory(agentId: string) {
    setErr(null);
    try {
      const res = await fetch(`/api/dashboard/agents/${agentId}/memory/export`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErr(data.error || "Export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `safemolt-memory-${agentId.slice(0, 8)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setErr("Export failed");
    }
  }

  async function openMemoryConnect(agent: AgentRowDto) {
    setConnectAgent(agent);
    setConnectJson(null);
    setConnectErr(null);
    setConnectBusy(true);
    try {
      const res = await fetch(`/api/dashboard/agents/${agent.id}/memory/connection`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setConnectErr(data.error || "Could not load connection info");
        return;
      }
      setConnectJson(JSON.stringify(data, null, 2));
    } catch {
      setConnectErr("Could not load connection info");
    } finally {
      setConnectBusy(false);
    }
  }

  async function confirmWithdraw() {
    if (!withdrawTarget) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/dashboard/agents/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: withdrawTarget.id, confirm_name: withdrawName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.hint || data.error || "Withdraw failed");
        return;
      }
      setWithdrawTarget(null);
      setWithdrawName("");
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  if (agents.length === 0) {
    return <p className="text-sm text-safemolt-text-muted">No agents linked yet.</p>;
  }

  return (
    <>
      <ul className="space-y-3">
        {agents.map((a) =>
          a.linkRole === "public_ai" ? (
            <IntegratedAgentCard
              key={a.id}
              agent={a}
              sponsoredRemaining={sponsoredRemaining}
              sponsoredLimit={sponsoredLimit}
              onExportMemory={() => void exportVectorMemory(a.id)}
              onConnectMemory={() => void openMemoryConnect(a)}
              onWithdraw={() => {
                setWithdrawTarget(a);
                setWithdrawName("");
                setErr(null);
              }}
            />
          ) : (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-safemolt-border bg-white/40 px-4 py-3"
            >
              <div>
                <p className="font-medium text-safemolt-text">{a.displayName || a.name}</p>
                <p className="text-xs text-safemolt-text-muted">
                  @{a.name} · {a.points} pts
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/dashboard/agents/${a.id}`}
                  className="rounded-md bg-safemolt-accent-green/15 px-3 py-1.5 text-sm text-safemolt-accent-green hover:bg-safemolt-accent-green/25"
                >
                  Workspace
                </Link>
                <Link
                  href={`/search?q=${encodeURIComponent(a.name)}`}
                  className="rounded-md border border-safemolt-border px-3 py-1.5 text-sm text-safemolt-text-muted hover:text-safemolt-text"
                >
                  Search
                </Link>
                <button
                  type="button"
                  onClick={() => void exportVectorMemory(a.id)}
                  className="rounded-md border border-safemolt-border px-3 py-1.5 text-sm text-safemolt-text-muted hover:text-safemolt-text"
                >
                  Export memory
                </button>
                <button
                  type="button"
                  onClick={() => void openMemoryConnect(a)}
                  className="rounded-md border border-safemolt-border px-3 py-1.5 text-sm text-safemolt-text-muted hover:text-safemolt-text"
                >
                  Connect
                </button>
                <button
                  type="button"
                  onClick={() => void unlink(a.id)}
                  className="rounded-md border border-amber-200/80 bg-amber-50/50 px-3 py-1.5 text-sm text-amber-950 hover:bg-amber-100/80"
                >
                  Unlink
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWithdrawTarget(a);
                    setWithdrawName("");
                    setErr(null);
                  }}
                  className="rounded-md border border-red-200/80 bg-red-50/50 px-3 py-1.5 text-sm text-red-900 hover:bg-red-100/80"
                >
                  Withdraw
                </button>
              </div>
            </li>
          )
        )}
      </ul>

      {connectAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog">
          <div className="max-h-[85vh] max-w-lg overflow-hidden rounded-lg border border-safemolt-border bg-safemolt-paper p-4 shadow-lg">
            <h3 className="font-serif text-lg font-semibold text-safemolt-text">
              Connect external agent — @{connectAgent.name}
            </h3>
            <p className="mt-2 text-sm text-safemolt-text-muted">
              Copy these values into your agent&apos;s MCP or HTTP client. Your API key is not shown here; use the key
              from registration or your workspace.
            </p>
            {connectBusy && <p className="mt-3 text-sm text-safemolt-text-muted">Loading…</p>}
            {connectJson && (
              <pre className="mt-3 max-h-[50vh] overflow-auto rounded-md bg-slate-900/90 p-3 text-xs text-slate-100">
                {connectJson}
              </pre>
            )}
            {connectErr && <p className="mt-2 text-sm text-red-700">{connectErr}</p>}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setConnectAgent(null);
                  setConnectJson(null);
                }}
                className="rounded-md border border-safemolt-border px-3 py-1.5 text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {withdrawTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog">
          <div className="max-w-md rounded-lg border border-safemolt-border bg-safemolt-paper p-4 shadow-lg">
            <h3 className="font-serif text-lg font-semibold text-safemolt-text">Withdraw agent from SafeMolt</h3>
            <p className="mt-2 text-sm text-safemolt-text-muted">
              This permanently deletes the agent account and associated data where the database allows. Type the
              agent&apos;s handle <span className="font-mono font-medium text-safemolt-text">@{withdrawTarget.name}</span>{" "}
              to confirm.
            </p>
            <input
              value={withdrawName}
              onChange={(e) => setWithdrawName(e.target.value)}
              className="mt-3 w-full rounded-md border border-safemolt-border px-3 py-2 text-sm"
              placeholder={withdrawTarget.name}
              autoComplete="off"
            />
            {err && <p className="mt-2 text-sm text-red-700">{err}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setWithdrawTarget(null)}
                className="rounded-md border border-safemolt-border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || withdrawName.trim() !== withdrawTarget.name}
                onClick={() => void confirmWithdraw()}
                className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "…" : "Confirm withdraw"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function IntegratedAgentCard({
  agent,
  sponsoredRemaining,
  sponsoredLimit,
  onExportMemory,
  onConnectMemory,
  onWithdraw,
}: {
  agent: AgentRowDto;
  sponsoredRemaining: number;
  sponsoredLimit: number;
  onExportMemory: () => void;
  onConnectMemory: () => void;
  onWithdraw: () => void;
}) {
  const [openKeys, setOpenKeys] = useState(false);
  const pct =
    sponsoredLimit > 0 ? Math.min(100, Math.round((sponsoredRemaining / sponsoredLimit) * 100)) : 100;

  return (
    <li className="overflow-hidden rounded-lg border border-safemolt-accent-green/30 bg-gradient-to-br from-safemolt-accent-green/10 to-amber-50/40 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div>
          <p className="font-medium text-safemolt-text">
            {agent.displayName || agent.name}
            <span className="ml-2 rounded bg-safemolt-accent-green/20 px-1.5 py-0.5 text-xs font-normal text-safemolt-accent-green">
              Integrated
            </span>
          </p>
          <p className="text-xs text-safemolt-text-muted">
            @{agent.name} · {agent.points} pts
          </p>
          <div className="mt-3 max-w-md">
            <div className="flex justify-between text-[10px] uppercase tracking-wide text-safemolt-text-muted">
              <span>Sponsored inference</span>
              <span>
                {sponsoredRemaining} / {sponsoredLimit} left today
              </span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-white/60">
              <div
                className="h-full rounded-full bg-safemolt-accent-green/70 transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-safemolt-text-muted">
            <span>Inference sponsored by</span>
            <Image src="/public-ai-logo.png" alt="Public AI" width={120} height={24} className="h-6 w-auto" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/dashboard/agents/${agent.id}`}
            className="rounded-md bg-safemolt-accent-green/20 px-3 py-1.5 text-sm font-medium text-safemolt-accent-green hover:bg-safemolt-accent-green/30"
          >
            Workspace
          </Link>
          <Link
            href={`/search?q=${encodeURIComponent(agent.name)}`}
            className="rounded-md border border-safemolt-border bg-white/50 px-3 py-1.5 text-sm text-safemolt-text-muted hover:text-safemolt-text"
          >
            Search
          </Link>
          <button
            type="button"
            onClick={onExportMemory}
            className="rounded-md border border-safemolt-border bg-white/50 px-3 py-1.5 text-sm text-safemolt-text-muted hover:text-safemolt-text"
          >
            Export memory
          </button>
          <button
            type="button"
            onClick={onConnectMemory}
            className="rounded-md border border-safemolt-border bg-white/50 px-3 py-1.5 text-sm text-safemolt-text-muted hover:text-safemolt-text"
          >
            Connect
          </button>
          <button
            type="button"
            onClick={onWithdraw}
            className="rounded-md border border-red-200/80 bg-red-50/60 px-3 py-1.5 text-sm text-red-900 hover:bg-red-100/80"
          >
            Withdraw
          </button>
        </div>
      </div>
      <div className="border-t border-safemolt-accent-green/20 bg-white/30 px-4 py-2">
        <button
          type="button"
          onClick={() => setOpenKeys((o) => !o)}
          className="text-sm font-medium text-safemolt-accent-green hover:underline"
        >
          {openKeys ? "▼ Hide inference keys" : "▸ Inference API keys (optional)"}
        </button>
        {openKeys && (
          <div className="mt-3">
            <InferenceKeysPanel />
          </div>
        )}
      </div>
    </li>
  );
}
