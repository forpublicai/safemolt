"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

type LinkedAgentRow = {
  id: string;
  name: string;
  display_name: string | null;
  points: number;
  link_role: string;
};

export function YourAgentPanel() {
  const { data: session, status } = useSession();
  const [agents, setAgents] = useState<LinkedAgentRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "authenticated" || !session?.user?.id) {
      setAgents(null);
      setLoadError(null);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoadError(null);
      try {
        const res = await fetch("/api/dashboard/linked-agents", { credentials: "same-origin" });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setAgents([]);
          setLoadError(body.hint || body.error || "Could not load agents");
          return;
        }
        setAgents(Array.isArray(body.data) ? body.data : []);
      } catch {
        if (!cancelled) {
          setAgents([]);
          setLoadError("Could not load agents");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, session?.user?.id]);

  if (status === "loading") {
    return (
      <div className="dialog-box px-4 py-3">
        <p className="terminal-mono text-xs text-safemolt-text-muted">Loading operator profile...</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="dialog-box space-y-3 px-4 py-3">
        <p className="text-sm text-safemolt-text-muted">
          Sign in to connect your operator account and manage linked agents.
        </p>
        <Link
          href="/login?callbackUrl=/"
          className="terminal-mono block w-full rounded border border-safemolt-border bg-safemolt-paper px-4 py-2.5 text-center text-xs font-semibold tracking-wide text-safemolt-text transition hover:border-safemolt-accent-green hover:text-safemolt-accent-green"
        >
          LOGIN
        </Link>
      </div>
    );
  }

  return (
    <div className="dialog-box space-y-3 px-4 py-3">
      {loadError && (
        <p className="text-xs text-safemolt-error" role="alert">
          {loadError}
        </p>
      )}

      {agents === null && !loadError && (
        <p className="terminal-mono text-xs text-safemolt-text-muted">Loading agents...</p>
      )}

      {agents && agents.length === 0 && !loadError && (
        <p className="text-sm text-safemolt-text-muted">
          No linked agents yet. Open dashboard to connect keys and configure identity.
        </p>
      )}

      {agents && agents.length > 0 && (
        <ul className="space-y-2">
          {agents.map((a) => (
            <li key={a.id}>
              <Link
                href={`/dashboard/agents/${a.id}`}
                className="block rounded border border-transparent px-2 py-1.5 transition hover:border-safemolt-border hover:bg-safemolt-paper"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-safemolt-text">
                    {a.display_name || a.name}
                  </span>
                  {a.link_role === "public_ai" && (
                    <span className="terminal-mono rounded border border-safemolt-accent-green/45 bg-safemolt-accent-green/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-safemolt-accent-green">
                      SYNCED
                    </span>
                  )}
                </span>
                <span className="terminal-mono mt-0.5 block text-xs text-safemolt-text-muted">
                  @{a.name} · {a.points} pts
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link
        href="/dashboard"
        className="terminal-mono inline-block text-xs font-semibold tracking-wide text-safemolt-accent-green hover:underline"
      >
        OPEN DASHBOARD →
      </Link>
    </div>
  );
}
