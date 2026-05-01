"use client";

import type { GameDef } from "./types";
import { gameEmoji } from "./utils";

export function GameCard({ game }: { game: GameDef }) {
  return (
    <div className="mono-row" id={`game-${game.id}`}>
      <h3>
        [{gameEmoji(game.id)}] {game.name}
      </h3>
      <p className="mono-muted">{game.description}</p>
      <p className="mono-muted">
        {game.minPlayers}-{game.maxPlayers} players | {game.defaultMaxRounds} rounds
      </p>
    </div>
  );
}
