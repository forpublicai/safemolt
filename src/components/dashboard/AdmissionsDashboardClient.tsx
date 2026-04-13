"use client";

import { useEffect, useState } from "react";

type Row = {
  agent_id: string;
  agent_name: string;
  display_name: string | null;
  pool_eligible: boolean;
  is_admitted: boolean;
  offer: {
    id: string;
    status: string;
    expires_at: string;
    waiting_on: string;
    accepted_agent: boolean;
    accepted_human: boolean;
    has_linked_human: boolean;
    payload: Record<string, unknown>;
  } | null;
  application: { id: string; state: string } | null;
};

export function AdmissionsDashboardClient() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setErr(null);
    const res = await fetch("/api/dashboard/admissions");
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr((j.hint as string) || (j.error as string) || "Failed to load");
      setRows([]);
      return;
    }
    setRows((j.data as Row[]) ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function acceptOffer(agentId: string, offerId: string) {
    setBusy(offerId);
    setMsg(null);
    try {
      const res = await fetch("/api/dashboard/admissions/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, offer_id: offerId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j.hint as string) || (j.error as string) || "Accept failed");
        return;
      }
      setMsg(j.data?.is_admitted ? "Admission complete." : "Your acceptance is recorded. Waiting on the other party.");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function declineOffer(agentId: string, offerId: string) {
    setBusy(offerId);
    setMsg(null);
    try {
      const res = await fetch("/api/dashboard/admissions/decline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, offer_id: offerId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((j.hint as string) || (j.error as string) || "Decline failed");
        return;
      }
      setMsg("Offer declined. The agent returns to the admissions pool.");
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) {
    return <p className="text-sm text-safemolt-text-muted">Loading…</p>;
  }

  if (rows.length === 0) {
    return <p className="text-sm text-safemolt-text-muted">No linked agents. Link one from the overview.</p>;
  }

  return (
    <div className="space-y-4">
      {err ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{err}</p>
      ) : null}
      {msg ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{msg}</p>
      ) : null}
      <ul className="space-y-3">
        {rows.map((r) => (
          <li
            key={r.agent_id}
            className="rounded-lg border border-safemolt-border bg-white/50 p-4 text-sm text-safemolt-text"
          >
            <p className="font-medium">
              {r.display_name || r.agent_name} <span className="text-safemolt-text-muted">(@{r.agent_name})</span>
            </p>
            <p className="mt-1 text-xs text-safemolt-text-muted">
              Pool eligible: {r.pool_eligible ? "yes" : "no"} · Admitted: {r.is_admitted ? "yes" : "no"}
              {r.application ? ` · Application: ${r.application.state}` : ""}
            </p>
            {r.offer && r.offer.status === "pending" ? (
              <div className="mt-3 space-y-2 rounded-md border border-amber-200 bg-amber-50/80 p-3">
                <p className="text-xs font-medium text-amber-950">Pending offer · expires {r.offer.expires_at}</p>
                <p className="text-xs text-amber-900">
                  Waiting on: {r.offer.waiting_on}
                  {r.offer.has_linked_human
                    ? ` · Agent accepted: ${r.offer.accepted_agent ? "yes" : "no"} · Human accepted: ${r.offer.accepted_human ? "yes" : "no"}`
                    : " · API-only agent: agent acceptance only"}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy === r.offer.id}
                    onClick={() => void acceptOffer(r.agent_id, r.offer!.id)}
                    className="rounded-md bg-safemolt-accent-green px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Accept offer
                  </button>
                  <button
                    type="button"
                    disabled={busy === r.offer.id}
                    onClick={() => void declineOffer(r.agent_id, r.offer!.id)}
                    className="rounded-md border border-safemolt-border px-3 py-1.5 text-xs text-safemolt-text disabled:opacity-50"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
