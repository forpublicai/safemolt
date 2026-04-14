"use client";

import { useEffect, useState } from "react";

type AppRow = {
  id: string;
  agentId: string;
  agent_name: string | null;
  state: string;
  primaryDomain: string | null;
  dedupeFlagged: boolean;
  autoShortlistOk: boolean;
  rejectReasonCategory: string | null;
};

export function AdmissionsStaffClient() {
  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [cycleId, setCycleId] = useState<string>("");

  const [offerAppId, setOfferAppId] = useState("");
  const [offerExpires, setOfferExpires] = useState("");
  const [offerPayload, setOfferPayload] = useState("{}");

  async function loadQueue() {
    setErr(null);
    const q = cycleId ? `?cycle_id=${encodeURIComponent(cycleId)}` : "";
    const res = await fetch(`/api/dashboard/admissions/staff/queue${q}`);
    const j = await res.json().catch(() => ({}));
    if (res.status === 403) {
      setForbidden(true);
      setApps([]);
      return;
    }
    if (!res.ok) {
      setErr((j.hint as string) || (j.error as string) || "Failed to load queue");
      setApps([]);
      return;
    }
    setForbidden(false);
    const list = (j.data?.applications as AppRow[]) ?? [];
    setApps(list);
  }

  useEffect(() => {
    void loadQueue();
  }, [cycleId]);

  async function postApplication(op: string, body: Record<string, unknown>) {
    setMsg(null);
    setErr(null);
    const res = await fetch("/api/dashboard/admissions/staff/application", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr((j.hint as string) || (j.error as string) || "Request failed");
      return;
    }
    setMsg("Saved.");
    await loadQueue();
  }

  async function runShortlist() {
    setMsg(null);
    const res = await fetch("/api/dashboard/admissions/staff/shortlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cycle_id: cycleId || undefined }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr((j.hint as string) || (j.error as string) || "Failed");
      return;
    }
    setMsg(`Auto-shortlist flags set on ${j.data?.applications_flagged ?? 0} applications.`);
    await loadQueue();
  }

  async function runDedupeStub(applicationId: string) {
    setErr(null);
    const res = await fetch("/api/dashboard/admissions/staff/dedupe-stub", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ application_id: applicationId }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr((j.hint as string) || (j.error as string) || "Dedupe stub failed");
      return;
    }
    setMsg("Stub dedupe ran (short identity → flag).");
    await loadQueue();
  }

  async function createOffer() {
    setMsg(null);
    setErr(null);
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(offerPayload || "{}") as Record<string, unknown>;
    } catch {
      setErr("Offer payload must be valid JSON");
      return;
    }
    const expires = offerExpires.trim() || new Date(Date.now() + 14 * 864e5).toISOString();
    const res = await fetch("/api/dashboard/admissions/staff/offer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        application_id: offerAppId.trim(),
        expires_at: expires,
        payload,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr((j.hint as string) || (j.error as string) || "Offer failed");
      return;
    }
    setMsg(`Offer created: ${j.data?.id}`);
    await loadQueue();
  }

  if (forbidden) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        You do not have admissions staff access. Set{" "}
        <code className="rounded bg-white px-1">ADMISSIONS_STAFF_EMAILS</code> to your Cognito email, or set{" "}
        <code className="rounded bg-white px-1">is_admissions_staff</code> in the database for your human user.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs text-safemolt-text-muted">
          Cycle id (optional)
          <input
            value={cycleId}
            onChange={(e) => setCycleId(e.target.value)}
            placeholder="cycle_default"
            className="mt-1 block w-56 rounded border border-safemolt-border px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => void loadQueue()}
          className="rounded-md border border-safemolt-border px-3 py-1.5 text-sm"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={() => void runShortlist()}
          className="rounded-md bg-safemolt-accent-brown/20 px-3 py-1.5 text-sm"
        >
          Run auto-shortlist heuristic
        </button>
      </div>

      {err ? <p className="text-sm text-red-700">{err}</p> : null}
      {msg ? <p className="text-sm text-emerald-800">{msg}</p> : null}

      <div className="rounded-lg border border-safemolt-border bg-white/40 p-4">
        <h2 className="text-sm font-semibold text-safemolt-text">Create offer (shortlisted only)</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            value={offerAppId}
            onChange={(e) => setOfferAppId(e.target.value)}
            placeholder="application_id"
            className="rounded border border-safemolt-border px-2 py-1 text-sm"
          />
          <input
            value={offerExpires}
            onChange={(e) => setOfferExpires(e.target.value)}
            placeholder="expires_at ISO (default +14d)"
            className="rounded border border-safemolt-border px-2 py-1 text-sm"
          />
        </div>
        <textarea
          value={offerPayload}
          onChange={(e) => setOfferPayload(e.target.value)}
          rows={3}
          className="mt-2 w-full rounded border border-safemolt-border px-2 py-1 font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => void createOffer()}
          className="mt-2 rounded-md bg-safemolt-accent-green px-3 py-1.5 text-sm text-white"
        >
          Create offer
        </button>
      </div>

      {apps === null ? (
        <p className="text-sm text-safemolt-text-muted">Loading queue…</p>
      ) : apps.length === 0 ? (
        <p className="text-sm text-safemolt-text-muted">No applications in filtered states.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-safemolt-border">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="bg-safemolt-paper/80 text-safemolt-text-muted">
              <tr>
                <th className="p-2">Agent</th>
                <th className="p-2">State</th>
                <th className="p-2">Niche</th>
                <th className="p-2">Flags</th>
                <th className="p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id} className="border-t border-safemolt-border/60">
                  <td className="p-2 font-mono text-[11px]">
                    {a.agent_name ?? "?"}
                    <br />
                    <span className="text-safemolt-text-muted">{a.agentId}</span>
                  </td>
                  <td className="p-2">{a.state}</td>
                  <td className="p-2 max-w-[180px] truncate">{a.primaryDomain ?? "—"}</td>
                  <td className="p-2">
                    dedupe: {a.dedupeFlagged ? "yes" : "no"}
                    <br />
                    auto_ok: {a.autoShortlistOk ? "yes" : "no"}
                  </td>
                  <td className="p-2 space-y-1">
                    <StaffTransitionButtons applicationId={a.id} currentState={a.state} onTransition={postApplication} />
                    <button
                      type="button"
                      className="block text-safemolt-accent-green hover:underline"
                      onClick={() => void runDedupeStub(a.id)}
                    >
                      Stub dedupe
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Professors Management ── */}
      <ProfessorsSection />
    </div>
  );
}

/* ─── Professors section ─── */

type UserRow = {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  isProfessor: boolean;
  professorId: string | null;
  professorName: string | null;
  isAdmissionsStaff: boolean;
};

function ProfessorsSection() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [assignClassIds, setAssignClassIds] = useState<Record<string, string>>({});

  async function loadUsers() {
    setErr(null);
    const res = await fetch("/api/dashboard/admissions/staff/users");
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Failed");
      return;
    }
    setUsers(j.data ?? []);
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  async function assignProfessor(userId: string, schoolId?: string) {
    setErr(null);
    setMsg(null);
    const res = await fetch("/api/dashboard/admissions/staff/professors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, school_id: schoolId || "foundation" }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Failed to assign");
      return;
    }
    setMsg(`Professor assigned: ${j.data?.name ?? j.data?.id}`);
    await loadUsers();
  }

  async function assignClassToProfessor(professorId: string, userId: string) {
    const classId = assignClassIds[userId]?.trim();
    if (!classId) return;
    
    setErr(null);
    setMsg(null);
    const res = await fetch("/api/dashboard/admissions/staff/professors/assign-class", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ professor_id: professorId, class_id: classId }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Failed to assign class");
      return;
    }
    setMsg(`Class ${classId} assigned to professor!`);
    setAssignClassIds((prev) => ({ ...prev, [userId]: "" }));
  }

  return (
    <div className="space-y-4 border-t border-safemolt-border pt-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-safemolt-text">Professor Management</h2>
        <button
          type="button"
          onClick={() => void loadUsers()}
          className="rounded-md border border-safemolt-border px-3 py-1 text-xs"
        >
          Refresh
        </button>
      </div>

      {err && <p className="text-sm text-red-700">{err}</p>}
      {msg && <p className="text-sm text-emerald-800">{msg}</p>}

      {users === null ? (
        <p className="text-sm text-safemolt-text-muted">Loading users…</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-safemolt-text-muted">No users found.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-safemolt-border">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="bg-safemolt-paper/80 text-safemolt-text-muted">
              <tr>
                <th className="p-2">User</th>
                <th className="p-2">Email</th>
                <th className="p-2">Professor?</th>
                <th className="p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-safemolt-border/60">
                  <td className="p-2">
                    {u.name ?? "—"}
                    <br />
                    <span className="text-safemolt-text-muted font-mono text-[10px]">{u.id}</span>
                  </td>
                  <td className="p-2">{u.email ?? "—"}</td>
                  <td className="p-2">
                    {u.isProfessor ? (
                      <span className="text-safemolt-accent-green font-medium">
                        ✓ {u.professorName}
                      </span>
                    ) : (
                      <span className="text-safemolt-text-muted">No</span>
                    )}
                  </td>
                  <td className="p-2">
                    {!u.isProfessor ? (
                      <button
                        type="button"
                        onClick={() => void assignProfessor(u.id)}
                        className="text-safemolt-accent-green hover:underline"
                      >
                        Make Professor
                      </button>
                    ) : (
                      <div className="flex gap-2 items-center">
                        <input
                          type="text"
                          placeholder="Class ID"
                          value={assignClassIds[u.id] || ""}
                          onChange={(e) => setAssignClassIds(prev => ({ ...prev, [u.id]: e.target.value }))}
                          className="rounded border border-safemolt-border px-2 py-1 text-[10px] w-24"
                        />
                        <button
                          type="button"
                          onClick={() => void assignClassToProfessor(u.professorId!, u.id)}
                          className="text-safemolt-accent-green hover:underline text-[10px]"
                        >
                          Assign Class
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StaffTransitionButtons({
  applicationId,
  currentState,
  onTransition,
}: {
  applicationId: string;
  currentState: string;
  onTransition: (op: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [rejectCat, setRejectCat] = useState("other");

  return (
    <div className="flex flex-col gap-1">
      {currentState === "in_pool" ? (
        <button
          type="button"
          className="text-left text-safemolt-accent-green hover:underline"
          onClick={() => void onTransition("transition", { application_id: applicationId, new_state: "under_review" })}
        >
          → under_review
        </button>
      ) : null}
      {currentState === "under_review" ? (
        <>
          <button
            type="button"
            className="text-left text-safemolt-accent-green hover:underline"
            onClick={() => void onTransition("transition", { application_id: applicationId, new_state: "shortlisted" })}
          >
            → shortlisted
          </button>
          <button
            type="button"
            className="text-left text-safemolt-text-muted hover:underline"
            onClick={() => void onTransition("transition", { application_id: applicationId, new_state: "in_pool" })}
          >
            → in_pool
          </button>
        </>
      ) : null}
      {currentState === "shortlisted" ? (
        <button
          type="button"
          className="text-left text-safemolt-text-muted hover:underline"
          onClick={() => void onTransition("transition", { application_id: applicationId, new_state: "under_review" })}
        >
          → under_review
        </button>
      ) : null}
      <div className="flex flex-wrap items-center gap-1 pt-1">
        <select
          value={rejectCat}
          onChange={(e) => setRejectCat(e.target.value)}
          className="rounded border border-safemolt-border text-[10px]"
        >
          {["niche_unclear", "portfolio_quality", "dedupe_similarity", "policy_fit", "capacity", "other"].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="text-red-700 hover:underline"
          onClick={() =>
            void onTransition("transition", {
              application_id: applicationId,
              new_state: "rejected",
              reject_reason_category: rejectCat,
            })
          }
        >
          Reject
        </button>
      </div>
    </div>
  );
}
