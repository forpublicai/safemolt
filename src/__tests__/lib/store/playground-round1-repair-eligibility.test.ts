/**
 * M11-2 u5 lane C (P3.2) — the ROUND-1 PROMPT REPAIR's eligibility query.
 *
 * A crashed activation continuation leaves a session active on round 1 with no prompt and — since
 * this chunk — no deadline either, so nothing else in the system will ever touch it: every
 * deadline-scanning path keys off `roundDeadline` being set at all, which is exactly what makes a
 * promptless round un-expirable rather than silently forfeited. The repair sweep is the only path
 * that can free it, so its query carries the same three properties the lifetime cap's does
 * (`playground-cap-eligibility.test.ts` states the reasoning at length):
 *
 *  1. **The age predicate is IN the query**, so no fixed window can hide a stuck session.
 *  2. **The order is oldest-first**, so a bounded run always takes the sessions that have waited
 *     longest — a page bound becomes a delay rather than starvation.
 *  3. **`currentRoundPrompt` is part of the predicate**, so a repaired row leaves the candidate set
 *     and a page cannot re-return it.
 *
 * The db twin runs the same predicate in SQL; the integration suite proves it against Postgres.
 *
 * @jest-environment node
 */
import { listSessionsNeedingRound1PromptRepair } from "@/lib/store/playground/memory";
import { playgroundSessions } from "@/lib/store/_memory-state";
import type { PlaygroundSession } from "@/lib/playground/types";

const MINUTE = 60 * 1000;
const GRACE = 2 * MINUTE;

function seed(id: string, overrides: Partial<PlaygroundSession> = {}): PlaygroundSession {
  const session: PlaygroundSession = {
    id,
    gameId: "pub-debate",
    schoolId: `school_${id}`,
    status: "active",
    participants: [],
    transcript: [],
    currentRound: 1,
    maxRounds: 6,
    createdAt: new Date(Date.now() - 60 * MINUTE).toISOString(),
    startedAt: new Date(Date.now() - 60 * MINUTE).toISOString(),
    ...overrides,
  };
  playgroundSessions.set(id, session);
  return session;
}

beforeEach(() => {
  playgroundSessions.clear();
});

describe("listSessionsNeedingRound1PromptRepair", () => {
  it("answers only the sessions past the grace, oldest first", async () => {
    seed("fresh", { startedAt: new Date(Date.now() - 30_000).toISOString() });
    seed("oldest", { startedAt: new Date(Date.now() - 600 * MINUTE).toISOString() });
    seed("middling", { startedAt: new Date(Date.now() - 10 * MINUTE).toISOString() });

    const stuck = await listSessionsNeedingRound1PromptRepair(GRACE, 50);
    expect(stuck.map((session) => session.id)).toEqual(["oldest", "middling"]);
  });

  /** The starvation case, at the store: one stuck session behind fifty younger active ones. */
  it("finds the one stuck session behind fifty younger ones", async () => {
    seed("stuck", { startedAt: new Date(Date.now() - 600 * MINUTE).toISOString() });
    for (let i = 0; i < 50; i += 1) {
      seed(`fresh${i}`, {
        startedAt: new Date(Date.now() - i * 1000).toISOString(),
        currentRoundPrompt: "already prompted",
      });
    }

    const stuck = await listSessionsNeedingRound1PromptRepair(GRACE, 50);
    expect(stuck.map((session) => session.id)).toEqual(["stuck"]);
  });

  /**
   * `undefined`, not falsy. This domain's type is `string | undefined`, and the SQL predicate is
   * `current_round_prompt IS NULL` — a falsy test would also call an empty-string prompt missing and
   * republish over it, which the statement would not.
   */
  it("excludes a session that already carries a prompt, empty string included", async () => {
    seed("prompted", { currentRoundPrompt: "a prompt" });
    seed("empty-prompt", { currentRoundPrompt: "" });
    seed("stuck");

    const stuck = await listSessionsNeedingRound1PromptRepair(GRACE, 50);
    expect(stuck.map((session) => session.id)).toEqual(["stuck"]);
  });

  it("excludes every round but the first", async () => {
    seed("round2", { currentRound: 2 });
    seed("round1");

    const stuck = await listSessionsNeedingRound1PromptRepair(GRACE, 50);
    expect(stuck.map((session) => session.id)).toEqual(["round1"]);
  });

  it("excludes every non-active status", async () => {
    seed("pending", { status: "pending" });
    seed("cancelled", { status: "cancelled" });
    seed("completed", { status: "completed" });
    seed("active");

    const stuck = await listSessionsNeedingRound1PromptRepair(GRACE, 50);
    expect(stuck.map((session) => session.id)).toEqual(["active"]);
  });

  it("falls back to createdAt when a session never recorded a start", async () => {
    seed("no-start", {
      startedAt: undefined,
      createdAt: new Date(Date.now() - 10 * MINUTE).toISOString(),
    });

    const stuck = await listSessionsNeedingRound1PromptRepair(GRACE, 50);
    expect(stuck.map((session) => session.id)).toEqual(["no-start"]);
  });

  it("caps the page at the requested size, keeping the oldest", async () => {
    for (let i = 0; i < 5; i += 1) {
      seed(`stuck${i}`, { startedAt: new Date(Date.now() - (60 - i) * MINUTE).toISOString() });
    }

    const stuck = await listSessionsNeedingRound1PromptRepair(GRACE, 2);
    expect(stuck.map((session) => session.id)).toEqual(["stuck0", "stuck1"]);
  });
});
