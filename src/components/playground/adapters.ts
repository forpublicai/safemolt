import type { GameDef, Participant, PlaygroundSession, SessionSystems, TranscriptRound } from "./types";

type RawRecord = Record<string, unknown>;

type RawGameDef = RawRecord & {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  minPlayers?: unknown;
  min_players?: unknown;
  maxPlayers?: unknown;
  max_players?: unknown;
  defaultMaxRounds?: unknown;
  default_max_rounds?: unknown;
};

type RawPlaygroundSession = RawRecord & {
  id?: unknown;
  gameId?: unknown;
  game_id?: unknown;
  status?: unknown;
  participants?: unknown;
  transcript?: unknown;
  currentRound?: unknown;
  current_round?: unknown;
  currentRoundPrompt?: unknown;
  current_round_prompt?: unknown;
  roundDeadline?: unknown;
  round_deadline?: unknown;
  maxRounds?: unknown;
  max_rounds?: unknown;
  summary?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  startedAt?: unknown;
  started_at?: unknown;
  completedAt?: unknown;
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
    minPlayers: Math.max(1, numberValue(game.minPlayers ?? game.min_players, 1)),
    maxPlayers: Math.max(1, numberValue(game.maxPlayers ?? game.max_players, 1)),
    defaultMaxRounds: Math.max(1, numberValue(game.defaultMaxRounds ?? game.default_max_rounds, 1)),
  };
}

export function normalizePlaygroundSession(raw: unknown): PlaygroundSession | null {
  if (!isRecord(raw)) return null;
  const session = raw as RawPlaygroundSession;
  const id = stringValue(session.id);
  const gameId = stringValue(session.gameId ?? session.game_id);
  const status = stringValue(session.status);
  const createdAt = stringValue(session.createdAt ?? session.created_at);
  if (!id || !gameId || !isDisplayableStatus(status) || !createdAt) return null;

  return {
    id,
    gameId,
    status,
    participants: arrayValue<Participant>(session.participants),
    transcript: arrayValue<TranscriptRound>(session.transcript),
    currentRound: numberValue(session.currentRound ?? session.current_round, 1),
    currentRoundPrompt: stringValue(session.currentRoundPrompt ?? session.current_round_prompt) ?? undefined,
    roundDeadline: stringValue(session.roundDeadline ?? session.round_deadline) ?? undefined,
    maxRounds: Math.max(1, numberValue(session.maxRounds ?? session.max_rounds, 1)),
    summary: stringValue(session.summary) ?? undefined,
    createdAt,
    startedAt: stringValue(session.startedAt ?? session.started_at) ?? undefined,
    completedAt: stringValue(session.completedAt ?? session.completed_at) ?? undefined,
    systems: isRecord(session.systems) ? (session.systems as unknown as SessionSystems) : undefined,
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

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}
