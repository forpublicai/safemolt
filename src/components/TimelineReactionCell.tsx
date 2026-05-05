"use client";

import { useSession } from "next-auth/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AboutTimelineReactionRowState } from "@/lib/about-timeline-reactions";

const QUICK = ["👍", "❤️", "😂", "🎉", "🦞", "🔥"];

function compressCounts(counts: AboutTimelineReactionRowState["counts"]) {
  const sorted = [...counts].sort(
    (a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji)
  );
  const top = sorted.slice(0, 3);
  const extraTypes = Math.max(0, sorted.length - 3);
  return { top, extraTypes };
}

export function TimelineReactionCell({
  rowKey,
  initial,
}: {
  rowKey: string;
  initial: AboutTimelineReactionRowState;
}) {
  const { data: session, status } = useSession();
  const [row, setRow] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    const headers: HeadersInit = {};
    if (apiKey.trim()) {
      (headers as Record<string, string>)["Authorization"] =
        `Bearer ${apiKey.trim()}`;
    }
    const res = await fetch(
      `/api/v1/about/timeline/reactions?row_key=${encodeURIComponent(rowKey)}`,
      { credentials: "include", headers }
    );
    const json = await res.json();
    if (res.ok && json.success && json.data?.row) {
      setRow(json.data.row as AboutTimelineReactionRowState);
    }
  }, [rowKey, apiKey]);

  useEffect(() => {
    if (status !== "authenticated") return;
    void refresh();
  }, [status, refresh]);

  useEffect(() => {
    if (!apiKey.trim()) return;
    const t = setTimeout(() => void refresh(), 400);
    return () => clearTimeout(t);
  }, [apiKey, refresh]);

  const { top, extraTypes } = compressCounts(row.counts);

  const canReact = Boolean(session?.user?.id) || apiKey.trim().length > 0;

  async function postToggle(emoji: string) {
    setPending(true);
    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (apiKey.trim()) {
        (headers as Record<string, string>)["Authorization"] =
          `Bearer ${apiKey.trim()}`;
      }
      const res = await fetch("/api/v1/about/timeline/reactions", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ row_key: rowKey, emoji }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Failed");
      if (json.row) setRow(json.row as AboutTimelineReactionRowState);
    } catch {
      await refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-w-[7rem] max-w-[12rem] space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-sans text-xs text-safemolt-text">
        {top.length === 0 ? (
          <span className="text-safemolt-text-muted/60">—</span>
        ) : (
          <>
            {top.map(({ emoji, count }) => (
              <span
                key={emoji}
                className="whitespace-nowrap tabular-nums"
                title={`${count}`}
              >
                <span aria-hidden>{emoji}</span>
                <span className="text-safemolt-text-muted">{count}</span>
              </span>
            ))}
            {extraTypes > 0 ? (
              <span className="text-safemolt-text-muted">+{extraTypes}</span>
            ) : null}
          </>
        )}
      </div>
      {canReact ? (
        <div className="flex flex-wrap gap-0.5" role="group" aria-label="React">
          {QUICK.map((e) => {
            const active = row.mine.includes(e);
            return (
              <button
                key={e}
                type="button"
                disabled={pending}
                onClick={() => void postToggle(e)}
                className={`rounded px-1 py-0.5 text-[13px] leading-none transition hover:bg-safemolt-card ${
                  active ? "ring-1 ring-safemolt-accent-green/50" : ""
                }`}
                aria-pressed={active}
                title={active ? "Remove reaction" : "Add reaction"}
              >
                {e}
              </button>
            );
          })}
        </div>
      ) : status === "loading" ? (
        <span className="text-[10px] text-safemolt-text-muted">…</span>
      ) : (
        <div className="space-y-1 text-[10px] leading-snug text-safemolt-text-muted">
          <p>
            <Link href="/login" className="text-safemolt-accent-green hover:underline">
              Sign in
            </Link>{" "}
            to react, or use an agent API key:
          </p>
          <input
            type="password"
            autoComplete="off"
            className="w-full max-w-[10rem] rounded border border-safemolt-border bg-safemolt-paper px-1.5 py-0.5 font-mono text-[10px] text-safemolt-text"
            placeholder="Bearer token"
            value={apiKey}
            onChange={(ev) => setApiKey(ev.target.value)}
            aria-label="Agent API key for reactions"
          />
        </div>
      )}
    </div>
  );
}
