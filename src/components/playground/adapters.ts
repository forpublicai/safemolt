import type { PlaygroundGame, PlaygroundSession as StorePlaygroundSession } from "@/lib/playground/types";
import type { GameDef, Participant, PlaygroundSession, SessionSystems, TranscriptRound } from "./types";

type RawRecord = Record<string, unknown>;

// The playground APIs emit one canonical snake_case shape (M9/C13); these raw
// types mirror that contract — no camelCase fallbacks.
type RawGameDef = RawRecord & {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  min_players?: unknown;
  max_players?: unknown;
  default_max_rounds?: unknown;
};

type RawPlaygroundSession = RawRecord & {
  id?: unknown;
  game_id?: unknown;
  status?: unknown;
  participants?: unknown;
  transcript?: unknown;
  current_round?: unknown;
  current_round_prompt?: unknown;
  round_deadline?: unknown;
  max_rounds?: unknown;
  summary?: unknown;
  created_at?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  systems?: unknown;
};

const displayableStatuses = new Set<PlaygroundSession["status"]>(["pending", "active", "completed"]);

export function normalizeGameDef(raw: unknown): GameDef | null {
  if (!isRecord(raw)) return null;
  const game = raw as RawGameDef;
  const id = stringValue(game.id);
  const name = stringValue(game.name);
  if (!id || !name) return null;

  return {
    id,
    name,
    description: stringValue(game.description) ?? "",
    minPlayers: Math.max(1, numberValue(game.min_players, 1)),
    maxPlayers: Math.max(1, numberValue(game.max_players, 1)),
    defaultMaxRounds: Math.max(1, numberValue(game.default_max_rounds, 1)),
  };
}

export function normalizePlaygroundSession(raw: unknown): PlaygroundSession | null {
  if (!isRecord(raw)) return null;
  const session = raw as RawPlaygroundSession;
  const id = stringValue(session.id);
  const gameId = stringValue(session.game_id);
  const status = stringValue(session.status);
  const createdAt = stringValue(session.created_at);
  if (!id || !gameId || !isDisplayableStatus(status) || !createdAt) return null;

  return {
    id,
    gameId,
    status,
    participants: arrayValue<Participant>(session.participants),
    transcript: arrayValue<TranscriptRound>(session.transcript),
    currentRound: numberValue(session.current_round, 1),
    currentRoundPrompt: stringValue(session.current_round_prompt) ?? undefined,
    roundDeadline: stringValue(session.round_deadline) ?? undefined,
    maxRounds: Math.max(1, numberValue(session.max_rounds, 1)),
    summary: stringValue(session.summary) ?? undefined,
    createdAt,
    startedAt: stringValue(session.started_at) ?? undefined,
    completedAt: stringValue(session.completed_at) ?? undefined,
    systems: isRecord(session.systems) ? (session.systems as unknown as SessionSystems) : undefined,
  };
}

/**
 * Project an in-process store game definition to the client shape. The SSR
 * seed uses this; only true wire payloads go through the unknown-typed
 * normalizers above.
 */
export function clientGameDefFromStoreGameDef(game: PlaygroundGame): GameDef {
  return {
    id: game.id,
    name: game.name,
    description: game.description,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    defaultMaxRounds: game.defaultMaxRounds,
  };
}

/**
 * Project an in-process store session (camelCase entity) to the client shape.
 * The SSR seed uses this; only true wire payloads go through the unknown-typed
 * normalizers above.
 */
export function clientSessionFromStoreSession(session: StorePlaygroundSession): PlaygroundSession | null {
  if (!isDisplayableStatus(session.status)) return null;
  return {
    id: session.id,
    gameId: session.gameId,
    status: session.status,
    participants: session.participants as Participant[],
    transcript: session.transcript as TranscriptRound[],
    currentRound: session.currentRound,
    currentRoundPrompt: session.currentRoundPrompt ?? undefined,
    roundDeadline: session.roundDeadline ?? undefined,
    maxRounds: session.maxRounds,
    summary: session.summary ?? undefined,
    createdAt: session.createdAt,
    startedAt: session.startedAt ?? undefined,
    completedAt: session.completedAt ?? undefined,
  };
}

export function normalizeGameDefs(raw: unknown): GameDef[] {
  return arrayValue<unknown>(raw).map(normalizeGameDef).filter(isPresent);
}

export function normalizePlaygroundSessions(raw: unknown): PlaygroundSession[] {
  return arrayValue<unknown>(raw).map(normalizePlaygroundSession).filter(isPresent);
}

function isDisplayableStatus(status: string | undefined): status is PlaygroundSession["status"] {
  return Boolean(status && displayableStatuses.has(status as PlaygroundSession["status"]));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function arrayValue<T>(value: unknown): T[] {
  // Playground list/detail APIs own item-level shape validation; this adapter is intentionally lenient.
  return Array.isArray(value) ? (value as T[]) : [];
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}
