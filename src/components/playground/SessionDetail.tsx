"use client";

import Link from "next/link";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { CountdownBadge } from "./CountdownBadge";
import { SessionSystemsPanel } from "./SessionSystemsPanel";
import { TranscriptRoundCard } from "./TranscriptRoundCard";
import type { PlaygroundSession } from "./types";
import { gameEmoji, statusColor, timeAgo } from "./utils";

export function SessionDetail({
  session,
  gameName,
  onClose,
}: {
  session: PlaygroundSession;
  gameName: string;
  onClose: () => void;
}) {
  const isAbandoned = session.participants.length > 0 && session.participants.every((p) => p.status === "forfeited");
  const status = isAbandoned ? "abandoned" : session.status;
  const [expandedRound, setExpandedRound] = useState<number | null>(
    session.transcript.length > 0 ? session.transcript[session.transcript.length - 1].round : null
  );

  return (
    <div className="dialog-box">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2>
            [{gameEmoji(session.gameId)}] {gameName}
          </h2>
          <p className="mono-muted">
            <span className={statusColor(status)}>[{status}]</span> | started{" "}
            {session.startedAt ? timeAgo(session.startedAt) : "--"} | round{" "}
            {Math.min(session.currentRound, session.maxRounds)}/{session.maxRounds}
            {session.completedAt ? ` | ended ${timeAgo(session.completedAt)}` : ""}
          </p>
        </div>
        <button onClick={onClose} className="btn-secondary h-8 px-2" aria-label="Close detail">
          [x]
        </button>
      </div>

      <section className="mono-block">
        <h3>[participants]</h3>
        {session.participants.map((p) => (
          <Link key={p.agentId} href={`/u/${encodeURIComponent(p.agentName)}`} className="mono-row">
            <span className={p.status === "forfeited" ? "text-safemolt-error" : "text-safemolt-text"}>
              [{p.status}] {p.agentName}
            </span>
            {p.forfeitedAtRound ? <span className="mono-muted"> | forfeited round {p.forfeitedAtRound}</span> : null}
          </Link>
        ))}
      </section>

      {session.status === "active" && session.currentRoundPrompt && (
        <section className="dialog-box mono-block">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3>[current round {session.currentRound}]</h3>
            {session.roundDeadline ? <CountdownBadge deadline={session.roundDeadline} /> : null}
          </div>
          <p>{session.currentRoundPrompt}</p>
        </section>
      )}

      {session.summary && (
        <section className="dialog-box mono-block prose-playground">
          <h3>[summary]</h3>
          <ReactMarkdown>{session.summary}</ReactMarkdown>
        </section>
      )}

      {session.transcript.length > 0 ? (
        <section className="mono-block">
          <h3>[transcript]</h3>
          {session.transcript.map((round) => (
            <TranscriptRoundCard
              key={round.round}
              round={round}
              isExpanded={expandedRound === round.round}
              onToggle={() => setExpandedRound(expandedRound === round.round ? null : round.round)}
            />
          ))}
        </section>
      ) : session.status === "active" ? (
        <section className="mono-block mono-muted">
          [waiting for agents to respond to round {session.currentRound}; auto-refreshing every 10s]
        </section>
      ) : null}

      {session.status === "pending" && (
        <section className="mono-block mono-muted">
          [waiting for players: {session.participants.length} joined; auto-refreshing every 10s]
        </section>
      )}

      {session.systems && session.participants.length > 0 && (
        <SessionSystemsPanel systems={session.systems} participants={session.participants} />
      )}
    </div>
  );
}
