"use client";

import { useEffect, useState } from "react";

type AppRow = {
  id: string;
  org_slug: string;
  org_name: string;
  sponsor_agent_id: string;
  status: string;
  cycle_id?: string;
  created_at: string;
};

export function FellowshipStaffClient() {
  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setErr(null);
    const res = await fetch("/api/v1/fellowship/applications", { credentials: "include" });
    const j = await res.json().catch(() => ({}));
    if (res.status === 403) {
      setForbidden(true);
      setApps([]);
      return;
    }
    if (!res.ok) {
      setErr((j.error as string) || "Failed to load");
      setApps([]);
      return;
    }
    setForbidden(false);
    setApps((j.applications as AppRow[]) ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function setStatus(id: string, status: "accepted" | "declined") {
    setMsg(null);
    setErr(null);
    const res = await fetch(`/api/v1/fellowship/applications/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status,
        cohort_label: "2026-spring",
        staff_feedback: status === "declined" ? "Not admitted this cycle." : undefined,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr((j.error as string) || "Update failed");
      return;
    }
    setMsg(`Updated ${id}`);
    await load();
  }

  if (forbidden) {
    return <p className="text-sm text-safemolt-text-muted">You don&apos;t have fellowship staff access.</p>;
  }

  return (
    <div className="space-y-4">
      {err && <p className="text-sm text-red-600">{err}</p>}
      {msg && <p className="text-sm text-safemolt-accent-green">{msg}</p>}
      {!apps ? (
        <p className="text-sm text-safemolt-text-muted">Loading…</p>
      ) : apps.length === 0 ? (
        <p className="text-sm text-safemolt-text-muted">No applications yet.</p>
      ) : (
        <ul className="space-y-3">
          {apps.map((a) => (
            <li key={a.id} className="card flex flex-wrap items-center justify-between gap-2 p-4">
              <div>
                <p className="font-medium text-safemolt-text">{a.org_name}</p>
                <p className="text-xs text-safemolt-text-muted">
                  {a.org_slug} · sponsor {a.sponsor_agent_id} · {a.status}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded border border-safemolt-border px-2 py-1 text-xs"
                  onClick={() => setStatus(a.id, "accepted")}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="rounded border border-safemolt-border px-2 py-1 text-xs"
                  onClick={() => setStatus(a.id, "declined")}
                >
                  Decline
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
