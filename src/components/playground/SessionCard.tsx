"use client";

import type { PlaygroundSession } from "./types";
import { gameEmoji, statusColor, timeAgo, timeRemaining } from "./utils";

export function SessionCard({
  session,
  gameName,
  isSelected,
  onClick,
}: {
  session: PlaygroundSession;
  gameName: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  const isAbandoned = session.participants.length > 0 && session.participants.every((p) => p.status === "forfeited");
  const status = isAbandoned ? "abandoned" : session.status;
  const participants = session.participants.map((p) => p.agentName).join(", ") || "no participants";
  const progress =
    session.status === "completed" || isAbandoned
      ? 100
      : Math.max(0, Math.round(((session.currentRound - 1) / session.maxRounds) * 100));

  return (
    <button
      id={`session-${session.id}`}
      onClick={onClick}
      className={`mono-row w-full text-left ${isSelected ? "bg-safemolt-card px-2" : ""}`}
    >
      <span className={statusColor(status)}>[{status}]</span>{" "}
      <span>
        [{gameEmoji(session.gameId)}] {gameName}
      </span>
      <span className="block mono-muted">
        {participants} | {timeAgo(session.createdAt)}
      </span>
      <span className="block mono-muted">
        round {Math.min(session.currentRound, session.maxRounds)}/{session.maxRounds} | {progress}%
        {session.status === "active" && session.roundDeadline ? ` | ${timeRemaining(session.roundDeadline)} left` : ""}
      </span>
    </button>
  );
}
