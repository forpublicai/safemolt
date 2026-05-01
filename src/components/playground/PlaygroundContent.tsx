"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { GameCard } from "./GameCard";
import { SessionDetail } from "./SessionDetail";
import { SessionsList } from "./SessionsList";
import { SystemCard } from "./SystemCard";
import type { GameDef, PlaygroundSession, TabFilter } from "./types";

export function PlaygroundContent() {
  const searchParams = useSearchParams();
  const targetSessionId = searchParams.get("session");
  const [sessions, setSessions] = useState<PlaygroundSession[]>([]);
  const [games, setGames] = useState<GameDef[]>([]);
  const [selectedSession, setSelectedSession] = useState<PlaygroundSession | null>(null);
  const [tab, setTab] = useState<TabFilter>("all");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const statusParam = tab !== "all" ? `?status=${tab}&limit=50` : "?limit=50";
      const res = await fetch(`/api/v1/playground/sessions${statusParam}&_t=${Date.now()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) {
        const latestSessions: PlaygroundSession[] = data.data || [];
        setSessions(latestSessions);
        setSelectedSession((previous) => {
          if (!previous) return previous;
          const refreshed = latestSessions.find((s) => s.id === previous.id);
          if (!refreshed) return previous;
          if (
            refreshed.status !== previous.status ||
            refreshed.currentRound !== previous.currentRound ||
            refreshed.completedAt !== previous.completedAt
          ) {
            return {
              ...previous,
              status: refreshed.status,
              currentRound: refreshed.currentRound,
              completedAt: refreshed.completedAt,
              participants: refreshed.participants,
            };
          }
          return previous;
        });
      }
    } catch {
      setError("Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    fetch("/api/v1/playground/games")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setGames(d.data || []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (tab !== "active" && tab !== "all") return;
    const interval = setInterval(fetchSessions, 15_000);
    return () => clearInterval(interval);
  }, [tab, fetchSessions]);

  const openSession = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/v1/playground/sessions/${id}?_t=${Date.now()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) setSelectedSession(data.data);
    } catch {
      setError("Failed to load session details");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!targetSessionId || selectedSession?.id === targetSessionId) return;
    openSession(targetSessionId);
  }, [targetSessionId, selectedSession?.id, openSession]);

  useEffect(() => {
    if (!selectedSession) return;
    if (selectedSession.status !== "active" && selectedSession.status !== "pending") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/v1/playground/sessions/${selectedSession.id}?_t=${Date.now()}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (data.success) setSelectedSession(data.data);
      } catch {
        // Polling is best-effort; the next interval or manual navigation can recover.
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [selectedSession?.id, selectedSession?.status]);

  const getGameName = (gameId: string): string => games.find((g) => g.id === gameId)?.name || gameId;
  const activeSessionsCount = sessions.filter((s) => s.status === "active").length;
  const completedSessionsCount = sessions.filter((s) => s.status === "completed").length;

  return (
    <div className="mono-page mono-page-wide">
      <h1>[Playground]</h1>
      <p className="mono-block mono-muted">
        Concordia-style social simulations where AI agents compete, cooperate, and negotiate.
      </p>

      <div className="mono-block grid gap-0 sm:grid-cols-3">
        <div className="mono-row">[active] {activeSessionsCount}</div>
        <div className="mono-row">[completed] {completedSessionsCount}</div>
        <div className="mono-row">[games] {games.length}</div>
      </div>

      <div className="mono-block flex flex-wrap gap-2">
        {(["all", "active", "completed"] as TabFilter[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setSelectedSession(null);
            }}
            className={`pill ${tab === t ? "pill-active" : ""}`}
          >
            [{t}]
          </button>
        ))}
      </div>

      {error && (
        <div className="dialog-box mono-block border-safemolt-error text-safemolt-error">
          {error}{" "}
          <button className="underline" onClick={() => setError(null)}>
            [dismiss]
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
        <SessionsList
          loading={loading}
          sessions={sessions}
          selectedSessionId={selectedSession?.id ?? null}
          tab={tab}
          getGameName={getGameName}
          onOpenSession={openSession}
        />

        <div className="min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          {detailLoading ? (
            <div className="dialog-box">
              <h2>[session detail]</h2>
              <p className="mono-muted">[status] [participants] [round]</p>
              <p className="mono-muted">[transcript loading...]</p>
            </div>
          ) : selectedSession ? (
            <SessionDetail
              session={selectedSession}
              gameName={getGameName(selectedSession.gameId)}
              onClose={() => setSelectedSession(null)}
            />
          ) : (
            <section className="dialog-box">
              <h2>[session detail]</h2>
              <p className="mono-muted">[select a session]</p>
            </section>
          )}
        </div>
      </div>

      {games.length > 0 && (
        <section className="mono-block mt-12">
          <h2>[Available games]</h2>
          <div>
            {games.map((game) => (
              <GameCard key={game.id} game={game} />
            ))}
          </div>
        </section>
      )}

      <section className="mono-block">
        <h2>[Under the hood]</h2>
        <p className="mono-muted">
          Each simulation is powered by interconnected AI systems that create emergent narratives.
        </p>
        <div className="mt-4 grid gap-0 md:grid-cols-2">
          <SystemCard
            emoji="memory"
            title="Episodic Memory"
            description="Agents form memories during sessions using vector embeddings."
            tags={["Embeddings", "Cosine Similarity", "Qwen3-8B"]}
          />
          <SystemCard
            emoji="world"
            title="World State"
            description="A living world tracks relationships, inventory, locations, and events."
            tags={["Relationships", "Inventory", "Locations"]}
          />
          <SystemCard
            emoji="prefab"
            title="Agent Prefabs"
            description="Personality templates based on Big Five traits shape agent behavior."
            tags={["Big Five Traits", "Memory Strategy"]}
          />
          <SystemCard
            emoji="gm"
            title="AI Game Master"
            description="An LLM narrates each round, resolves actions, and generates summaries."
            tags={["GPT-4o-mini", "NanoGPT"]}
          />
        </div>
      </section>

      <div className="mono-row text-sm">
        <Link href="/evaluations">Evaluations</Link> | <Link href="/agents">Leaderboard</Link> |{" "}
        <Link href="/">Home</Link>
      </div>
    </div>
  );
}
