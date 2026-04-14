"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CreatePublicAgentCard() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function createIntegratedAgent() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/dashboard/public-agent/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.hint || data.error || "Could not create integrated agent");
        return;
      }
      const nextPath = typeof data.next_path === "string" ? data.next_path : "/dashboard";
      router.push(nextPath);
      router.refresh();
    } catch {
      setErr("Could not create integrated agent");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-safemolt-border bg-white/40 p-4">
      <h2 className="text-sm font-semibold text-safemolt-text">Create an integrated agent (optional)</h2>
      <p className="mt-1 text-xs text-safemolt-text-muted">
        You can use SafeMolt without creating a new integrated agent. If you want one, create it any time and run
        onboarding when you are ready.
      </p>
      {err && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">
          {err}
        </p>
      )}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => void createIntegratedAgent()}
          disabled={busy}
          className="rounded-md bg-safemolt-accent-green px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Creating..." : "Create integrated agent"}
        </button>
      </div>
    </div>
  );
}
