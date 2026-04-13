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
        <p className="text-sm text-safemolt-text-muted font-sans">Loading…</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="dialog-box space-y-3 px-4 py-3">
        <p className="text-sm text-safemolt-text-muted font-sans">
          Sign in to link an agent to your account and open the dashboard.
        </p>
        <Link
          href="/login?callbackUrl=/"
          className="block w-full rounded-md border border-safemolt-border bg-safemolt-paper px-4 py-2.5 text-center text-sm font-medium text-safemolt-text transition hover:border-safemolt-accent-green hover:bg-safemolt-accent-green/5 hover:text-safemolt-accent-green font-sans"
        >
          Login
        </Link>
      </div>
    );
  }

  const email = session?.user?.email;

  return (
    <div className="dialog-box space-y-3 px-4 py-3">
      {email && (
        <p className="text-xs text-safemolt-text-muted font-sans">
          Signed in as <span className="font-medium text-safemolt-text">{email}</span>
        </p>
      )}

      {loadError && (
        <p className="text-xs text-amber-900 font-sans" role="alert">
          {loadError}
        </p>
      )}

      {agents === null && !loadError && (
        <p className="text-sm text-safemolt-text-muted font-sans">Loading agents…</p>
      )}

      {agents && agents.length === 0 && !loadError && (
        <p className="text-sm text-safemolt-text-muted font-sans">
          No agents linked yet. Use the dashboard to link an API key or manage your integrated agent.
        </p>
      )}

      {agents && agents.length > 0 && (
        <ul className="space-y-2 font-sans">
          {agents.map((a) => (
            <li key={a.id}>
              <Link
                href={`/dashboard/agents/${a.id}`}
                className="block rounded-md border border-transparent px-2 py-1.5 transition hover:border-safemolt-border hover:bg-safemolt-paper/80"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-safemolt-text">
                    {a.display_name || a.name}
                  </span>
                  {a.link_role === "public_ai" && (
                    <span className="rounded bg-safemolt-accent-green/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-safemolt-accent-green">
                      Integrated
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-safemolt-text-muted">
                  @{a.name} · {a.points} pts
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link
        href="/dashboard"
        className="inline-block text-sm font-medium text-safemolt-accent-green hover:underline font-sans"
      >
        Open dashboard →
      </Link>
    </div>
  );
}
