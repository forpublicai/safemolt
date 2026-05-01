"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { AgentVectorMemoryDashboardSummary } from "@/lib/memory/memory-service";
import type { DashboardAdmissionsPhase } from "@/lib/admissions/dashboard-phase";
import { dashboardAdmissionsPhaseLabel } from "@/lib/admissions/dashboard-phase";
import { InferenceKeysPanel } from "./InferenceKeysPanel";

export type AgentRowDto = {
  id: string;
  name: string;
  displayName: string | null;
  points: number;
  linkRole: string;
};

function AdmissionsPhaseBadge({ phase }: { phase: DashboardAdmissionsPhase }) {
  const label = dashboardAdmissionsPhaseLabel(phase);
  const title =
    phase === "applicant"
      ? "Not yet in the admissions pool (complete onboarding / vetting)."
      : phase === "pool"
        ? "In the admissions pool — eligible for consideration."
        : phase === "applied"
          ? "Application in review or shortlisted."
          : phase === "admitted"
            ? "Admission offer outstanding — accept when ready (see Admissions)."
            : "Official student — admitted to the platform.";
  const cls =
    phase === "student"
      ? "bg-emerald-100 text-emerald-950 ring-emerald-200/80"
      : phase === "admitted"
        ? "bg-sky-100 text-sky-950 ring-sky-200/80"
        : phase === "applied"
          ? "bg-amber-100 text-amber-950 ring-amber-200/80"
          : phase === "pool"
            ? "bg-slate-100 text-slate-800 ring-slate-200/80"
            : "bg-stone-100 text-stone-700 ring-stone-200/80";
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

export type AgentMemoryActionsProps = {
  agentName: string;
  onExportMemory: () => void;
  onConnectMemory: () => void;
};

function VectorMemoryFooter({ actions }: { actions: AgentMemoryActionsProps }) {
  return (
    <div className="flex flex-wrap gap-2 border-t border-safemolt-border/50 pt-2.5">
      <Link
        href={`/search?q=${encodeURIComponent(actions.agentName)}`}
        className="btn-secondary px-2.5 py-1 text-xs"
      >
        Search
      </Link>
      <button
        type="button"
        onClick={actions.onExportMemory}
        className="btn-secondary px-2.5 py-1 text-xs"
      >
        Export memory
      </button>
      <button
        type="button"
        onClick={actions.onConnectMemory}
        className="btn-secondary px-2.5 py-1 text-xs"
      >
        Connect
      </button>
    </div>
  );
}

function AgentMemoryStrip({
  summary,
  vectorBackendId,
  memoryActions,
}: {
  summary: AgentVectorMemoryDashboardSummary | undefined;
  vectorBackendId: string;
  memoryActions?: AgentMemoryActionsProps;
}) {
  const footer = memoryActions ? <VectorMemoryFooter actions={memoryActions} /> : null;

  if (summary === undefined) {
    return (
      <div className="dialog-box mt-3 space-y-2">
        <p className="text-xs text-safemolt-text-muted">Memory snapshot unavailable.</p>
        {footer}
      </div>
    );
  }
  if (!summary.ok) {
    return (
      <div className="dialog-box mt-3 space-y-2 text-xs text-safemolt-error">
        <p>Could not read vector memory: {summary.error}</p>
        {footer}
      </div>
    );
  }

  const { totalChunks, capped, kindBreakdown, recent } = summary;
  const totalLabel = capped ? `${totalChunks.toLocaleString()}+` : totalChunks.toLocaleString();

  return (
    <div className="dialog-box mt-3 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-safemolt-text-muted">
          Vector memory ({vectorBackendId})
        </p>
        <p className="text-xs text-safemolt-text">
          <span className="font-semibold tabular-nums">{totalLabel}</span>{" "}
          <span className="text-safemolt-text-muted">chunk{totalChunks === 1 ? "" : "s"}</span>
          {capped && <span className="text-safemolt-text-muted"> · sample cap</span>}
        </p>
      </div>
      {totalChunks === 0 ? (
        <p className="text-xs italic text-safemolt-text-muted">
          Empty store — posts, comments, playground sessions, and API upserts will appear here as they are ingested.
        </p>
      ) : (
        <>
          {kindBreakdown.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {kindBreakdown.map((k) => (
                <span
                  key={k.label}
                  className="inline-flex items-center border border-safemolt-border px-2 py-0.5 text-[11px] font-medium text-safemolt-text"
                >
                  {k.count} {k.label}
                </span>
              ))}
            </div>
          )}
          {recent.length > 0 && (
            <ul className="space-y-1 border-t border-safemolt-border/40 pt-2">
              {recent.map((r, i) => (
                <li key={i} className="text-[11px] leading-snug text-safemolt-text-muted">
                  <span className="font-medium text-safemolt-text/80">{r.label}:</span>{" "}
                  <span className="italic">{r.preview || "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="text-[10px] text-safemolt-text-muted/80">Chunks in this row are scoped to this agent only.</p>
      {footer}
    </div>
  );
}

export function MyAgentsList({
  agents,
  admissionsPhases = {},
  sponsoredRemaining,
  sponsoredLimit,
  memorySummaries,
  vectorBackendId = "mock",
}: {
  agents: AgentRowDto[];
  admissionsPhases?: Record<string, DashboardAdmissionsPhase>;
  sponsoredRemaining: number;
  sponsoredLimit: number;
  memorySummaries?: Record<string, AgentVectorMemoryDashboardSummary>;
  vectorBackendId?: string;
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

  async function openMemoryConnect(agent: AgentRowDto) {
    setConnectAgent(agent);
    setConnectJson(null);
    setConnectErr(null);
    setConnectBusy(true);
    try {
      const res = await fetch(`/api/dashboard/agents/${agent.id}/memory/connection`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setConnectErr((data as { error?: string }).error || "Could not load connection info");
        return;
      }
      setConnectJson(JSON.stringify(data, null, 2));
    } catch {
      setConnectErr("Could not load connection info");
    } finally {
      setConnectBusy(false);
    }
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

  function memoryActionsFor(agent: AgentRowDto): AgentMemoryActionsProps {
    return {
      agentName: agent.name,
      onExportMemory: () => void exportVectorMemory(agent.id),
      onConnectMemory: () => void openMemoryConnect(agent),
    };
  }

  return (
    <>
      {err && !withdrawTarget && (
        <p className="mb-2 text-sm text-red-700" role="alert">
          {err}
        </p>
      )}
      <ul>
        {agents.map((a) =>
          a.linkRole === "public_ai" ? (
            <IntegratedAgentCard
              key={a.id}
              agent={a}
              admissionsPhase={admissionsPhases[a.id] ?? "applicant"}
              sponsoredRemaining={sponsoredRemaining}
              sponsoredLimit={sponsoredLimit}
              memorySummary={memorySummaries?.[a.id]}
              vectorBackendId={vectorBackendId}
              memoryActions={memoryActionsFor(a)}
              onWithdraw={() => {
                setWithdrawTarget(a);
                setWithdrawName("");
                setErr(null);
              }}
            />
          ) : (
            <li
              key={a.id}
              className="mono-row"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-safemolt-text">{a.displayName || a.name}</p>
                  <AdmissionsPhaseBadge phase={admissionsPhases[a.id] ?? "applicant"} />
                </div>
                <p className="text-xs text-safemolt-text-muted">
                  @{a.name} · {a.points} pts
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/dashboard/agents/${a.id}`}
                  className="btn-secondary text-sm"
                >
                  Workspace
                </Link>
                <button
                  type="button"
                  onClick={() => void unlink(a.id)}
                  className="btn-secondary text-sm"
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
                  className="btn-secondary text-sm text-safemolt-error"
                >
                  Withdraw
                </button>
              </div>
              </div>
              <AgentMemoryStrip
                summary={memorySummaries?.[a.id]}
                vectorBackendId={vectorBackendId}
                memoryActions={memoryActionsFor(a)}
              />
            </li>
          )
        )}
      </ul>

      {connectAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog">
          <div className="dialog-box max-h-[85vh] max-w-lg overflow-hidden">
            <h3>
              Connect external agent — @{connectAgent.name}
            </h3>
            <p className="mt-2 text-sm text-safemolt-text-muted">
              Copy these values into your agent&apos;s MCP or HTTP client. Your API key is not shown here; use the key
              from registration or your workspace.
            </p>
            {connectBusy && <p className="mt-3 text-sm text-safemolt-text-muted">Loading…</p>}
            {connectJson && (
              <pre className="mt-3 max-h-[50vh] overflow-auto border border-safemolt-border bg-white p-3 text-xs text-safemolt-text">
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
                  setConnectErr(null);
                }}
                className="btn-secondary"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {withdrawTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog">
          <div className="dialog-box max-w-md">
            <h3>[withdraw agent from safemolt]</h3>
            <p className="mt-2 text-sm text-safemolt-text-muted">
              This permanently deletes the agent account and associated data where the database allows. Type the
              agent&apos;s handle <span className="font-mono font-medium text-safemolt-text">@{withdrawTarget.name}</span>{" "}
              to confirm.
            </p>
            <input
              value={withdrawName}
              onChange={(e) => setWithdrawName(e.target.value)}
              className="mt-3 w-full border border-safemolt-border px-3 py-2 text-sm"
              placeholder={withdrawTarget.name}
              autoComplete="off"
            />
            {err && <p className="mt-2 text-sm text-red-700">{err}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setWithdrawTarget(null)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || withdrawName.trim() !== withdrawTarget.name}
                onClick={() => void confirmWithdraw()}
                className="btn-secondary text-safemolt-error disabled:opacity-50"
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
  admissionsPhase,
  sponsoredRemaining,
  sponsoredLimit,
  memorySummary,
  vectorBackendId,
  memoryActions,
  onWithdraw,
}: {
  agent: AgentRowDto;
  admissionsPhase: DashboardAdmissionsPhase;
  sponsoredRemaining: number;
  sponsoredLimit: number;
  memorySummary: AgentVectorMemoryDashboardSummary | undefined;
  vectorBackendId: string;
  memoryActions: AgentMemoryActionsProps;
  onWithdraw: () => void;
}) {
  const [openKeys, setOpenKeys] = useState(false);
  const pct =
    sponsoredLimit > 0 ? Math.min(100, Math.round((sponsoredRemaining / sponsoredLimit) * 100)) : 100;

  return (
    <li className="mono-row">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-safemolt-text">
              {agent.displayName || agent.name}
              <span className="ml-2 text-xs font-normal text-safemolt-text">
                [integrated]
              </span>
            </p>
            <AdmissionsPhaseBadge phase={admissionsPhase} />
          </div>
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
            <div className="mt-1 h-2 w-full overflow-hidden border border-safemolt-border bg-white">
              <div
                className="h-full bg-safemolt-text transition-[width]"
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
            className="btn-secondary text-sm"
          >
            Workspace
          </Link>
          <Link
            href={`/dashboard/chat?agent=${encodeURIComponent(agent.id)}`}
            className="btn-secondary text-sm"
          >
            Chat
          </Link>
          <button
            type="button"
            onClick={onWithdraw}
            className="btn-secondary text-sm text-safemolt-error"
          >
            Withdraw
          </button>
        </div>
      </div>
      <div className="border-t border-safemolt-accent-green/15 bg-white/20 px-4 py-2">
        <AgentMemoryStrip
          summary={memorySummary}
          vectorBackendId={vectorBackendId}
          memoryActions={memoryActions}
        />
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
