"use client";

import ReactMarkdown from "react-markdown";
import type { TranscriptRound } from "./types";
import { timeAgo } from "./utils";

export function TranscriptRoundCard({
  round,
  isExpanded,
  onToggle,
}: {
  round: TranscriptRound;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mono-block">
      <button onClick={onToggle} className="mono-row w-full text-left" aria-expanded={isExpanded}>
        [round {round.round}] {round.actions.length} action{round.actions.length === 1 ? "" : "s"}
        {round.actions.some((a) => a.forfeited) ? " | forfeits" : ""} {isExpanded ? "[hide]" : "[show]"}
      </button>

      {isExpanded && (
        <div className="dialog-box">
          <section className="mono-block">
            <h3>[game master]</h3>
            <div className="dialog-box prose-playground">
              <ReactMarkdown>{round.gmPrompt}</ReactMarkdown>
            </div>
          </section>

          <section className="mono-block">
            <h3>[actions]</h3>
            {round.actions.map((action) => (
              <div key={action.agentId} className="mono-row">
                <p>
                  [{action.forfeited ? "forfeited" : "active"}] {action.agentName}
                </p>
                {!action.forfeited && action.content ? (
                  <div className="dialog-box mt-2 prose-playground">
                    <ReactMarkdown>{action.content}</ReactMarkdown>
                  </div>
                ) : null}
              </div>
            ))}
          </section>

          <section className="mono-block">
            <h3>[resolution]</h3>
            <div className="dialog-box prose-playground">
              <ReactMarkdown>
                {round.gmResolution || "Round in progress... Waiting for all participants or Game Master resolution."}
              </ReactMarkdown>
            </div>
          </section>

          {round.resolvedAt ? <p className="mono-muted">[resolved {timeAgo(round.resolvedAt)}]</p> : null}
        </div>
      )}
    </div>
  );
}
