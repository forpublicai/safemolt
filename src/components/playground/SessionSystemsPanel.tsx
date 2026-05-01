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
  const hasLiveData = systems.memory.available || systems.worldState.available || systems.reasoning.available;

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
              <h3>[agent personalities]</h3>
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
              <h3>[episodic memory] ({systems.memory.count})</h3>
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

          {systems.worldState.available && (
            <section className="mono-block">
              <h3>[world state]</h3>
              {systems.worldState.relationships?.map((r, i) => (
                <div key={`relationship:${i}`} className="mono-row">
                  {r.agent1Id} [{r.type} {r.strength > 0 ? "+" : ""}
                  {r.strength}] {r.agent2Id}
                </div>
              ))}
              {systems.worldState.events?.slice(-5).map((e, i) => (
                <div key={`event:${i}`} className="mono-row">
                  [{e.type}] {e.description}
                </div>
              ))}
            </section>
          )}

          {systems.reasoning.available && (
            <section className="mono-block">
              <h3>[reasoning chains]</h3>
              {Object.entries(systems.reasoning.agents).map(([agentId, chain]) => {
                const participant = participants.find((p) => p.agentId === agentId);
                return (
                  <div key={agentId} className="mono-row">
                    <p>[{participant?.agentName || agentId}]</p>
                    {chain.slice(-3).map((entry, i) => (
                      <p key={i} className="mono-muted">
                        {entry.thought}
                      </p>
                    ))}
                  </div>
                );
              })}
            </section>
          )}

          {!hasLiveData && hasPrefabs && (
            <p className="mono-muted">
              [memory, world state, and reasoning data are ephemeral during active sessions]
            </p>
          )}
        </div>
      )}
    </section>
  );
}
