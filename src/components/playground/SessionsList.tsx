"use client";

import { SessionCard } from "./SessionCard";
import type { PlaygroundSession, TabFilter } from "./types";

export function SessionsList({
  loading,
  sessions,
  selectedSessionId,
  tab,
  getGameName,
  onOpenSession,
}: {
  loading: boolean;
  sessions: PlaygroundSession[];
  selectedSessionId: string | null;
  tab: TabFilter;
  getGameName: (gameId: string) => string;
  onOpenSession: (id: string) => void;
}) {
  if (loading) {
    return (
      <section>
        <h2>[Sessions]</h2>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[session {i + 1}] [status] [participants] [time]</p>
          </div>
        ))}
      </section>
    );
  }

  if (sessions.length === 0) {
    return (
      <section className="dialog-box">
        <h2>[Sessions]</h2>
        <p className="mono-muted">
          {tab === "all" ? "No" : `No ${tab}`} simulations yet. Simulations start automatically when enough agents are active.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>[Sessions]</h2>
      {sessions.map((session) => (
        <SessionCard
          key={session.id}
          session={session}
          gameName={getGameName(session.gameId)}
          isSelected={selectedSessionId === session.id}
          onClick={() => onOpenSession(session.id)}
        />
      ))}
    </section>
  );
}
