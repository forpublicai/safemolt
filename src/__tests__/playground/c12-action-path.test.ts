/**
 * @jest-environment node
 *
 * M11-1 C12, memory mode: one action path for both surfaces, and the gated insert's refusals.
 * The db-side races (cross-instance claims, token fencing under concurrency) run in
 * `src/__tests__/integration/c12-resolution-claim.test.ts`.
 */

jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
}));

jest.mock("@/lib/playground/lifecycle", () => ({
  enforceSessionLifetimeCap: jest.fn(async () => ({ completed: 0 })),
  revalidatePlaygroundSeed: jest.fn(),
  // The argument is an eagerly-created promise (tryAdvanceRound); swallow its settlement so a
  // background advancement can never crash the worker as an unhandled rejection.
  safeWaitUntil: jest.fn((promise: Promise<unknown>) => {
    void promise.catch(() => {});
  }),
  PLAYGROUND_SESSION_MAX_LIFETIME_MS: 6 * 60 * 60 * 1000,
}));

jest.mock("@/lib/playground/games", () => ({
  pickRandomGame: jest.fn(),
  getSchoolGameById: jest.fn(() => ({
    id: "game-1",
    name: "Negotiation",
    minPlayers: 2,
    maxPlayers: 4,
    premise: "",
    rules: "",
    scenes: [],
  })),
  listSchoolGameDefs: jest.fn(() => []),
  listGames: jest.fn(() => []),
}));

jest.mock("@/lib/playground/engine", () => ({
  generateRoundPrompt: jest.fn(async () => "next prompt"),
  resolveRound: jest.fn(async () => ({ narration: "GM narration", isGameOver: false })),
  generateSummary: jest.fn(async () => "summary"),
}));

jest.mock("@/lib/playground/embeddings", () => ({
  getEmbedding: jest.fn(async () => undefined),
}));

import { executors } from "@/lib/agent-tools/definitions/playground";
import {
  applyPlaygroundResolution,
  claimPlaygroundResolution,
  createPlaygroundSession,
  getPlaygroundActions,
  getPlaygroundSession,
  renewPlaygroundResolutionClaim,
  submitPlaygroundActionGated,
} from "@/lib/store";
import { schedulePlaygroundMemoryIngest } from "@/lib/memory/platform-ingest";
import { safeWaitUntil } from "@/lib/playground/lifecycle";
import type { StoredAgent } from "@/lib/store-types";

let seq = 0;

// Vetted AND admitted on purpose. These fixtures give every session a unique synthetic school id
// (see `seedActiveSession`), and a non-Foundation school requires platform admission — the tool
// surface now enforces that the same way the REST join route always has. An unadmitted fixture
// agent would be refused by the school gate before the participation logic under test ever ran,
// which would make these assertions pass or fail for the wrong reason. The gate itself is covered
// in `src/__tests__/lib/agent-tools/playground-school-gate.test.ts`.
function agent(id: string): StoredAgent {
  return { id, name: id, description: "", apiKey: `key_${id}`, points: 0, votePoints: 0, evaluationPoints: 0, legacyUnattributedPoints: 0, followerCount: 0, isClaimed: false, isVetted: true, isAdmitted: true, createdAt: new Date().toISOString() };
}

async function seedActiveSession(participantIds: string[]) {
  const id = `c12_sess_${Date.now()}_${seq++}`;
  await createPlaygroundSession({
    id,
    gameId: "game-1",
    // Unique per session: C23 enforces one live session per school in both stores, and these
    // fixtures deliberately hold many live sessions at once.
    schoolId: `school_${id}`,
    status: "active",
    participants: participantIds.map((agentId) => ({
      agentId,
      agentName: agentId,
      status: "active" as const,
      missedRounds: 0,
    })),
    currentRound: 1,
    currentRoundPrompt: "prompt",
    roundDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    maxRounds: 3,
    startedAt: new Date().toISOString(),
  });
  return id;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("tool delegation (C12)", () => {
  it("a nonparticipant tool submit is refused and inserts nothing", async () => {
    const sessionId = await seedActiveSession(["p1", "p2"]);
    const result = await executors.submit_playground_action(
      { session_id: sessionId, content: "sneak" },
      { agent: agent("outsider") } as never
    );
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("not a participant");
    expect(await getPlaygroundActions(sessionId, 1)).toHaveLength(0);
  });

  it("a participant tool submit inserts, schedules ingest, and schedules advancement — route parity", async () => {
    const sessionId = await seedActiveSession(["p1", "p2"]);
    const result = await executors.submit_playground_action(
      { session_id: sessionId, content: "advance troops" },
      { agent: agent("p1") } as never
    );
    expect(result.success).toBe(true);
    expect((result.data as { round: number }).round).toBe(1);
    expect(await getPlaygroundActions(sessionId, 1)).toHaveLength(1);
    // The pre-C12 tool skipped both of these — the parity this chunk exists to restore.
    expect(jest.mocked(schedulePlaygroundMemoryIngest)).toHaveBeenCalledWith(
      expect.arrayContaining(["p1", "p2"]),
      "advance troops",
      expect.objectContaining({ sessionId, kind: "playground_action", actorAgentId: "p1" })
    );
    expect(jest.mocked(safeWaitUntil)).toHaveBeenCalledWith(expect.anything(), `advance-round:${sessionId}`);
  });

  it("a duplicate submit is refused via the tool with the same error the route maps", async () => {
    // Two participants so the first submit cannot trigger an all-submitted background advance.
    const sessionId = await seedActiveSession(["p1", "p2"]);
    await executors.submit_playground_action({ session_id: sessionId, content: "one" }, { agent: agent("p1") } as never);
    const dup = await executors.submit_playground_action({ session_id: sessionId, content: "two" }, { agent: agent("p1") } as never);
    expect(dup.success).toBe(false);
    expect(String(dup.error)).toContain("already submitted");
    expect(await getPlaygroundActions(sessionId, 1)).toHaveLength(1);
  });
});

describe("gated insert refusals (memory)", () => {
  it("a forfeited participant is refused", async () => {
    const sessionId = await seedActiveSession(["p1", "p2"]);
    const { playgroundSessions } = jest.requireActual("@/lib/store/_memory-state") as {
      playgroundSessions: Map<string, { participants: Array<{ agentId: string; status: string }> }>;
    };
    const session = playgroundSessions.get(sessionId)!;
    session.participants.find((p) => p.agentId === "p2")!.status = "forfeited";

    const outcome = await submitPlaygroundActionGated({ id: `a_${seq++}`, sessionId, agentId: "p2", round: 1, content: "x" });
    expect(outcome).toEqual({ ok: false, reason: "forfeited" });
  });

  it("a claimed round refuses new actions; a lapsed claim admits them", async () => {
    const sessionId = await seedActiveSession(["p1", "p2"]);
    expect(await claimPlaygroundResolution(sessionId, 1, "tokA", 60_000)).toBe(true);

    const refused = await submitPlaygroundActionGated({ id: `a_${seq++}`, sessionId, agentId: "p1", round: 1, content: "late" });
    expect(refused).toEqual({ ok: false, reason: "resolving" });

    // Lapse the lease; the insert is admitted again (nothing resolved yet).
    expect(await renewPlaygroundResolutionClaim(sessionId, "tokA", -60_000)).toBe(true);
    const admitted = await submitPlaygroundActionGated({ id: `a_${seq++}`, sessionId, agentId: "p1", round: 1, content: "ok" });
    expect(admitted.ok).toBe(true);
  });

  it("a stale round (already advanced) is refused as resolved", async () => {
    const sessionId = await seedActiveSession(["p1", "p2"]);
    expect(await claimPlaygroundResolution(sessionId, 1, "tokB", 60_000)).toBe(true);
    expect(
      await applyPlaygroundResolution(sessionId, { round: 1, token: "tokB" }, { currentRound: 2, currentRoundPrompt: "r2", transcript: [] })
    ).toBe(true);

    const outcome = await submitPlaygroundActionGated({ id: `a_${seq++}`, sessionId, agentId: "p1", round: 1, content: "late" });
    expect(outcome).toEqual({ ok: false, reason: "stale_round" });
  });

  it("concurrent submits for one (session, round, agent) yield exactly one row", async () => {
    const sessionId = await seedActiveSession(["p1", "p2"]);
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        submitPlaygroundActionGated({ id: `race_${seq}_${i}`, sessionId, agentId: "p1", round: 1, content: `try ${i}` })
      )
    );
    seq += 1;
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(await getPlaygroundActions(sessionId, 1)).toHaveLength(1);
  });
});

describe("resolution claim semantics (memory)", () => {
  it("one live claim per round; token fencing rejects a loser's terminal write", async () => {
    const sessionId = await seedActiveSession(["p1"]);
    expect(await claimPlaygroundResolution(sessionId, 1, "winner", 60_000)).toBe(true);
    expect(await claimPlaygroundResolution(sessionId, 1, "loser", 60_000)).toBe(false);

    // The loser's write is fenced out even if it tries.
    expect(await applyPlaygroundResolution(sessionId, { round: 1, token: "loser" }, { currentRound: 2 })).toBe(false);
    // The winner commits and the claim clears.
    expect(await applyPlaygroundResolution(sessionId, { round: 1, token: "winner" }, { currentRound: 2, transcript: [] })).toBe(true);
    // A late second commit from the winner is also rejected — the round moved on.
    expect(await applyPlaygroundResolution(sessionId, { round: 1, token: "winner" }, { currentRound: 3 })).toBe(false);
  });

  it("an EXPIRED lease cannot be renewed — the renewal path must not resurrect it (review round 2, B1)", async () => {
    const sessionId = await seedActiveSession(["p1"]);
    expect(await claimPlaygroundResolution(sessionId, 1, "tokExp", 60_000)).toBe(true);
    // Lapse it (the renewal is still live at this instant, so it is permitted and sets the past).
    expect(await renewPlaygroundResolutionClaim(sessionId, "tokExp", -60_000)).toBe(true);

    // A delayed renewal timer firing after expiry must NOT revive the claim: reviving it would
    // let the stalled resolver pass the terminal fence and commit a pre-action transcript.
    expect(await renewPlaygroundResolutionClaim(sessionId, "tokExp", 60_000)).toBe(false);
    // And the terminal write still loses.
    expect(await applyPlaygroundResolution(sessionId, { round: 1, token: "tokExp" }, { currentRound: 2 })).toBe(false);
    // A reclaimer can take the round.
    expect(await claimPlaygroundResolution(sessionId, 1, "reclaimer", 60_000)).toBe(true);
  });

  it("a lapsed lease cannot apply its terminal write (M11-1b review B2)", async () => {
    const sessionId = await seedActiveSession(["p1"]);
    // Claim, then lapse the lease via a negative renewal — the token is unchanged, only the
    // expiry is in the past.
    expect(await claimPlaygroundResolution(sessionId, 1, "tokA", 60_000)).toBe(true);
    expect(await renewPlaygroundResolutionClaim(sessionId, "tokA", -60_000)).toBe(true);
    // The fence now rejects tokA even though token/round/status still match: its lease is dead.
    expect(await applyPlaygroundResolution(sessionId, { round: 1, token: "tokA" }, { currentRound: 2, transcript: [] })).toBe(false);
    // The round is untouched and reclaimable.
    expect((await getPlaygroundSession(sessionId))?.currentRound).toBe(1);
  });
});
