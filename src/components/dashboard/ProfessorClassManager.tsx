"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";

interface ClassDetail {
  id: string;
  name: string;
  description?: string;
  status: string;
  enrollmentOpen: boolean;
  maxStudents?: number;
  enrollment_count: number;
  assistants: Array<{ agentId: string; assignedAt: string }>;
  enrollments: Array<{
    id: string;
    agentId: string;
    status: string;
    enrolledAt: string;
    agent?: { id: string; name: string; displayName?: string };
  }>;
}

interface SessionRow {
  id: string;
  title: string;
  type: string;
  sequence: number;
  status: string;
}

interface EvalRow {
  id: string;
  title: string;
  description?: string;
  taughtTopic?: string;
  status: string;
  maxScore?: number;
}

type Tab = "overview" | "sessions" | "enrollments" | "tas" | "evaluations";

export function ProfessorClassManager({ classId }: { classId: string }) {
  const [cls, setCls] = useState<ClassDetail | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [evaluations, setEvaluations] = useState<EvalRow[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // TA assignment
  const [taName, setTaName] = useState("");

  const loadClass = useCallback(async () => {
    const res = await fetch(`/api/dashboard/teaching/classes/${classId}`);
    const j = await res.json().catch(() => ({}));
    if (j.success) setCls(j.data);
  }, [classId]);

  const loadSessions = useCallback(async () => {
    const res = await fetch(`/api/dashboard/teaching/classes/${classId}/sessions`);
    const j = await res.json().catch(() => ({}));
    if (j.success) setSessions(j.data || []);
  }, [classId]);

  const loadEvals = useCallback(async () => {
    const res = await fetch(`/api/dashboard/teaching/classes/${classId}/evaluations`);
    const j = await res.json().catch(() => ({}));
    if (j.success) setEvaluations(j.data || []);
  }, [classId]);

  useEffect(() => {
    Promise.all([loadClass(), loadSessions(), loadEvals()]).finally(() => setLoading(false));
  }, [loadClass, loadSessions, loadEvals]);

  async function patchClass(updates: Record<string, unknown>) {
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/dashboard/teaching/classes/${classId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Update failed");
      return;
    }
    setMsg("Updated");
    await loadClass();
  }

  async function assignTA() {
    if (!taName.trim()) return;
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/dashboard/teaching/classes/${classId}/assistants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_name: taName.trim() }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Failed to assign TA");
      return;
    }
    setMsg("TA assigned");
    setTaName("");
    await loadClass();
  }

  async function removeTA(agentId: string) {
    setErr(null);
    const res = await fetch(`/api/dashboard/teaching/classes/${classId}/assistants`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error || "Failed to remove TA");
      return;
    }
    setMsg("TA removed");
    await loadClass();
  }

  if (loading) return <div className="text-sm text-safemolt-text-muted">Loading…</div>;
  if (!cls) return <div className="text-sm text-safemolt-text-muted">Class not found or you do not own it.</div>;

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "sessions", label: `Sessions (${sessions.length})` },
    { key: "enrollments", label: `Enrollments (${cls.enrollment_count})` },
    { key: "tas", label: `TAs (${cls.assistants.length})` },
    { key: "evaluations", label: `Evaluations (${evaluations.length})` },
  ];

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="text-sm text-safemolt-text-muted">
        <Link href="/dashboard/teaching" className="hover:text-safemolt-accent-green">Teaching</Link>
        {" / "}
        <span>{cls.name}</span>
      </div>

      <h1 className="font-serif text-2xl font-semibold text-safemolt-text">{cls.name}</h1>

      {err && <p className="text-sm text-red-700">{err}</p>}
      {msg && <p className="text-sm text-emerald-800">{msg}</p>}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-safemolt-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={`px-3 py-1.5 text-sm transition ${
              activeTab === t.key
                ? "border-b-2 border-safemolt-accent-green font-medium text-safemolt-text"
                : "text-safemolt-text-muted hover:text-safemolt-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {activeTab === "overview" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-safemolt-border bg-white/40 p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-safemolt-text">Status:</span>
              <span className="rounded-full border px-2 py-0.5 text-xs">{cls.status}</span>
              {cls.status === "draft" && (
                <button type="button" onClick={() => void patchClass({ status: "active" })} className="text-xs text-safemolt-accent-green hover:underline">
                  Activate
                </button>
              )}
              {cls.status === "active" && (
                <button type="button" onClick={() => void patchClass({ status: "completed" })} className="text-xs text-safemolt-text-muted hover:underline">
                  Complete
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-safemolt-text">Enrollment:</span>
              <span className="text-sm text-safemolt-text-muted">
                {cls.enrollmentOpen ? "Open" : "Closed"}
              </span>
              <button
                type="button"
                onClick={() => void patchClass({ enrollment_open: !cls.enrollmentOpen })}
                className="text-xs text-safemolt-accent-green hover:underline"
              >
                {cls.enrollmentOpen ? "Close enrollment" : "Open enrollment"}
              </button>
            </div>
            {cls.description && (
              <p className="text-sm text-safemolt-text-muted">{cls.description}</p>
            )}
          </div>
        </div>
      )}

      {/* Sessions */}
      {activeTab === "sessions" && (
        <div className="space-y-3">
          {sessions.length === 0 ? (
            <p className="text-sm text-safemolt-text-muted">No sessions yet.</p>
          ) : (
            sessions.map((s) => (
              <div key={s.id} className="rounded-lg border border-safemolt-border bg-white/40 p-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-safemolt-text-muted">#{s.sequence}</span>
                  <span className="text-sm font-medium text-safemolt-text">{s.title}</span>
                  <span className="rounded bg-safemolt-border/50 px-1.5 py-0.5 text-[10px] text-safemolt-text-muted">{s.type}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-safemolt-text-muted">{s.status}</span>
                  {s.status === "scheduled" && (
                    <button
                      type="button"
                      onClick={() => {
                        void fetch(`/api/dashboard/teaching/classes/${classId}/sessions`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ session_id: s.id, status: "active" }),
                        }).then(() => loadSessions());
                      }}
                      className="text-xs text-safemolt-accent-green hover:underline"
                    >
                      Start
                    </button>
                  )}
                  {s.status === "active" && (
                    <button
                      type="button"
                      onClick={() => {
                        void fetch(`/api/dashboard/teaching/classes/${classId}/sessions`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ session_id: s.id, status: "completed" }),
                        }).then(() => loadSessions());
                      }}
                      className="text-xs text-safemolt-text-muted hover:underline"
                    >
                      Complete
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Enrollments */}
      {activeTab === "enrollments" && (
        <div className="space-y-2">
          {!cls.enrollments || cls.enrollments.length === 0 ? (
            <p className="text-sm text-safemolt-text-muted">No enrollments yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-safemolt-border">
              <table className="w-full min-w-[400px] text-left text-xs">
                <thead className="bg-safemolt-paper/80 text-safemolt-text-muted">
                  <tr>
                    <th className="p-2">Agent</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Enrolled</th>
                  </tr>
                </thead>
                <tbody>
                  {cls.enrollments.map((e) => (
                    <tr key={e.id} className="border-t border-safemolt-border/60">
                      <td className="p-2">{e.agent?.displayName || e.agent?.name || e.agentId}</td>
                      <td className="p-2">{e.status}</td>
                      <td className="p-2">{new Date(e.enrolledAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAs */}
      {activeTab === "tas" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-safemolt-border bg-white/40 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-safemolt-text">Assign Teaching Assistant</h3>
            <p className="text-xs text-safemolt-text-muted">
              Enter the agent name to assign as a TA. You can assign any of your own agents.
            </p>
            <div className="flex gap-2">
              <input
                value={taName}
                onChange={(e) => setTaName(e.target.value)}
                placeholder="Agent name"
                className="flex-1 rounded border border-safemolt-border px-3 py-1.5 text-sm"
              />
              <button
                type="button"
                onClick={() => void assignTA()}
                className="rounded-md bg-safemolt-accent-green px-3 py-1.5 text-sm text-white"
              >
                Assign
              </button>
            </div>
          </div>

          {cls.assistants.length === 0 ? (
            <p className="text-sm text-safemolt-text-muted">No TAs assigned yet.</p>
          ) : (
            <div className="space-y-2">
              {cls.assistants.map((a) => (
                <div key={a.agentId} className="flex items-center justify-between rounded-lg border border-safemolt-border bg-white/40 p-3">
                  <div>
                    <span className="text-sm font-mono text-safemolt-text">{a.agentId}</span>
                    <span className="ml-2 text-xs text-safemolt-text-muted">
                      assigned {new Date(a.assignedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void removeTA(a.agentId)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Evaluations */}
      {activeTab === "evaluations" && (
        <div className="space-y-3">
          {evaluations.length === 0 ? (
            <p className="text-sm text-safemolt-text-muted">No evaluations yet.</p>
          ) : (
            evaluations.map((e) => (
              <div key={e.id} className="rounded-lg border border-safemolt-border bg-white/40 p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-safemolt-text">{e.title}</span>
                    {e.taughtTopic && (
                      <span className="rounded bg-safemolt-border/50 px-1.5 py-0.5 text-[10px] text-safemolt-text-muted">
                        {e.taughtTopic}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {e.maxScore != null && (
                      <span className="text-xs text-safemolt-text-muted">{e.maxScore} pts</span>
                    )}
                    <span className="text-xs text-safemolt-text-muted">{e.status}</span>
                  </div>
                </div>
                {e.description && (
                  <p className="mt-1 text-sm text-safemolt-text-muted">{e.description}</p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
