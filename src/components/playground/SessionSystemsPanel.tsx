"use client";

import { useState } from "react";
import { TraitBar } from "./TraitBar";
import type { Participant, SessionSystems } from "./types";

export function SessionSystemsPanel({
  systems,
  participants,
}: {
  systems: SessionSystems;
  participants: Participant[];
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasPrefabs = Object.keys(systems.prefabs).length > 0;
  const hasLiveData = systems.memory.available;

  if (!hasPrefabs && !hasLiveData) return null;

  return (
    <section className="mono-block">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="mono-row w-full text-left"
        aria-expanded={isExpanded}
      >
        [under the hood] {hasLiveData ? "[live]" : "[prefabs]"} {isExpanded ? "[hide]" : "[show]"}
      </button>

      {isExpanded && (
        <div className="dialog-box">
          {hasPrefabs && (
            <section className="mono-block">
              <h3>Agent personalities</h3>
              {participants.map((p) => {
                const prefab = systems.prefabs[p.agentId];
                if (!prefab) return null;
                return (
                  <div key={p.agentId} className="mono-row">
                    <p>
                      [{p.agentName}] as {prefab.name} | {prefab.memoryStrategy}
                    </p>
                    <p className="mono-muted">{prefab.description}</p>
                    <div className="mt-2 space-y-1">
                      <TraitBar label="O" value={prefab.traits.openness} />
                      <TraitBar label="C" value={prefab.traits.conscientiousness} />
                      <TraitBar label="E" value={prefab.traits.extraversion} />
                      <TraitBar label="A" value={prefab.traits.agreeableness} />
                      <TraitBar label="N" value={prefab.traits.neuroticism} />
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {systems.memory.available && (
            <section className="mono-block">
              <h3>Episodic memory ({systems.memory.count})</h3>
              {systems.memory.entries.map((m, i) => (
                <div key={`${m.agentId}:${m.roundCreated}:${i}`} className="mono-row">
                  <p>
                    [{m.importance}] {m.agentName} | round {m.roundCreated}
                  </p>
                  <p className="mono-muted">{m.content}</p>
                </div>
              ))}
            </section>
          )}

          {!hasLiveData && hasPrefabs && (
            <p className="mono-muted">
              [memory data is ephemeral during active sessions]
            </p>
          )}
        </div>
      )}
    </section>
  );
}
