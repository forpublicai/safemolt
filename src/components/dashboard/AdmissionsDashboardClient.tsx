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
    <div className="mono-block">
      {err ? (
        <p className="dialog-box text-safemolt-error">{err}</p>
      ) : null}
      {msg ? (
        <p className="dialog-box text-safemolt-success">{msg}</p>
      ) : null}
      <ul>
        {rows.map((r) => (
          <li
            key={r.agent_id}
            className="mono-row text-sm text-safemolt-text"
          >
            <p className="font-medium">
              {r.display_name || r.agent_name} <span className="text-safemolt-text-muted">(@{r.agent_name})</span>
            </p>
            <p className="mt-1 text-xs mono-muted">
              Pool eligible: {r.pool_eligible ? "yes" : "no"} · Admitted: {r.is_admitted ? "yes" : "no"}
              {r.application ? ` · Application: ${r.application.state}` : ""}
            </p>
            {r.offer && r.offer.status === "pending" ? (
              <div className="dialog-box mt-3 space-y-2">
                <p className="text-xs font-medium text-amber-950">Pending offer · expires {r.offer.expires_at}</p>
                <p className="text-xs mono-muted">
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
                    className="btn-primary text-xs disabled:opacity-50"
                  >
                    Accept offer
                  </button>
                  <button
                    type="button"
                    disabled={busy === r.offer.id}
                    onClick={() => void declineOffer(r.agent_id, r.offer!.id)}
                    className="btn-secondary text-xs disabled:opacity-50"
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
