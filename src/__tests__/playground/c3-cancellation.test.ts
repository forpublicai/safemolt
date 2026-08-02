/**
 * @jest-environment node
 *
 * M11-1 C3, memory mode + route level: cancellation as an attributed transition. The db-side
 * races (cancel-vs-resolution precedence, expiry-vs-activation, fenced-loser) run in
 * `src/__tests__/integration/c3-cancellation.test.ts`.
 */

jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
}));

jest.mock("@/lib/playground/engine", () => ({
  generateRoundPrompt: jest.fn(async () => "next prompt"),
  resolveRound: jest.fn(async () => ({ narration: "GM narration", isGameOver: false })),
  generateSummary: jest.fn(async () => "summary"),
}));

import { POST as cancelRoute } from "@/app/api/v1/playground/sessions/[id]/cancel/route";
import {
  cancelPlaygroundSession,
  claimPlaygroundResolution,
  createPlaygroundAction,
  createPlaygroundSession,
  expireStalePendingSessions,
  getPlaygroundActions,
  getPlaygroundSession,
  listPlaygroundSessions,
} from "@/lib/store";
import { PLAYGROUND_SYSTEM_EXPIRED_REASON } from "@/lib/playground/types";
import { agents, apiKeyToAgentId, playgroundSessions } from "@/lib/store/_memory-state";
import { resolveRound } from "@/lib/playground/engine";
import { normalizePlaygroundSession } from "@/components/playground/adapters";

let seq = 0;

function seedVettedAgent(id: string): string {
  const apiKey = `key_${id}`;
  agents.set(id, {
    id,
    name: id,
    description: "",
    apiKey,
    points: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    isVetted: true,
  });
  apiKeyToAgentId.set(apiKey, id);
  return apiKey;
}

async function seedSession(participantIds: string[], status: "pending" | "active" = "active") {
  const id = `c3_sess_${Date.now()}_${seq++}`;
  await createPlaygroundSession({
    id,
    gameId: "game-1",
    // Unique per session: C23 enforces one live session per school in both stores, and these
    // fixtures deliberately hold many live sessions at once.
    schoolId: `school_${id}`,
    status,
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
    startedAt: status === "active" ? new Date().toISOString() : undefined,
  });
  return id;
}

function cancelRequest(sessionId: string, apiKey: string, body: unknown): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/v1/playground/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-school-id": "foundation",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: sessionId }) },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("reason is required, before any lookup", () => {
  it.each([
    ["missing", {}],
    ["non-string", { reason: 42 }],
    ["empty", { reason: "" }],
    ["whitespace", { reason: "   " }],
  ])("rejects a %s reason with stable reason_required — even for a nonexistent session", async (_label, body) => {
    const apiKey = seedVettedAgent(`c3_agent_${seq++}`);
    const res = await cancelRoute(...cancelRequest("does-not-exist", apiKey, body));
    expect(res.status).toBe(400);
    const parsed = await res.json();
    expect(parsed.error_detail.code).toBe("reason_required");
  });

  it("rejects a reason over 500 characters", async () => {
    const apiKey = seedVettedAgent(`c3_agent_${seq++}`);
    const res = await cancelRoute(...cancelRequest("does-not-exist", apiKey, { reason: "x".repeat(501) }));
    expect(res.status).toBe(400);
  });
});

describe("participant cancellation is accountable", () => {
  it("records actor, reason, and timestamp; the session and its actions survive", async () => {
    const attacker = `c3_attacker_${seq++}`;
    const apiKey = seedVettedAgent(attacker);
    const sessionId = await seedSession([attacker, "other"]);
    await createPlaygroundAction({ id: `c3_act_${seq++}`, sessionId, agentId: "other", round: 1, content: "move" });

    const res = await cancelRoute(...cancelRequest(sessionId, apiKey, { reason: "I want to grief this game" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.previous_status).toBe("active");

    // The attribution IS the point: the attacker-joins-then-cancels case is accepted and
    // fully recorded, which is the behavior the user asked to be able to observe.
    const session = await getPlaygroundSession(sessionId);
    expect(session?.status).toBe("cancelled");
    expect(session?.cancelledByAgentId).toBe(attacker);
    expect(session?.cancelledReason).toBe("I want to grief this game");
    expect(session?.cancelledAt).toEqual(expect.any(String));

    // Nothing was deleted: actions still resolve.
    expect(await getPlaygroundActions(sessionId, 1)).toHaveLength(1);
  });

  it("a cancelled session is out of pending/active listings, returned by GET, and dropped by the adapter", async () => {
    const actor = `c3_actor_${seq++}`;
    seedVettedAgent(actor);
    const sessionId = await seedSession([actor], "pending");
    await cancelPlaygroundSession(sessionId, actor, "cleanup");

    const pending = await listPlaygroundSessions({ status: "pending", limit: 100 });
    const active = await listPlaygroundSessions({ status: "active", limit: 100 });
    expect(pending.some((s) => s.id === sessionId)).toBe(false);
    expect(active.some((s) => s.id === sessionId)).toBe(false);

    expect((await getPlaygroundSession(sessionId))?.status).toBe("cancelled");
    // The client adapter deliberately keeps excluding cancelled sessions from the UI — exactly
    // as deleted ones were excluded before.
    expect(
      normalizePlaygroundSession({ id: sessionId, game_id: "game-1", status: "cancelled", participants: [] })
    ).toBeNull();
  });
});

describe("nonparticipants cannot probe", () => {
  it("active, completed, cancelled, and nonexistent sessions are indistinguishable — and no GM call happens", async () => {
    const outsider = `c3_outsider_${seq++}`;
    const apiKey = seedVettedAgent(outsider);

    const activeId = await seedSession(["p1"]);
    const completedId = await seedSession(["p1"]);
    playgroundSessions.get(completedId)!.status = "completed";
    const cancelledId = await seedSession(["p1"]);
    playgroundSessions.get(cancelledId)!.status = "cancelled";

    const bodies: Array<Record<string, unknown>> = [];
    for (const target of [activeId, completedId, cancelledId, "missing-session"]) {
      const res = await cancelRoute(...cancelRequest(target, apiKey, { reason: "probe" }));
      expect(res.status).toBe(404);
      const parsed = await res.json();
      bodies.push({ error: parsed.error, code: parsed.error_detail.code });
    }
    // Byte-identical classification across all four targets.
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);

    // Authorization-before-cost: the rejected cancels invoked zero GM resolutions.
    expect(jest.mocked(resolveRound)).not.toHaveBeenCalled();
    // And nothing changed.
    expect((await getPlaygroundSession(activeId))?.status).toBe("active");
  });
});

describe("cancel-vs-resolution precedence (memory)", () => {
  it("a claimed round refuses cancellation with resolution_in_progress and changes no row", async () => {
    const actor = `c3_actor_${seq++}`;
    const apiKey = seedVettedAgent(actor);
    const sessionId = await seedSession([actor]);
    expect(await claimPlaygroundResolution(sessionId, 1, "resolver", 60_000)).toBe(true);

    const res = await cancelRoute(...cancelRequest(sessionId, apiKey, { reason: "too slow" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error_detail.code).toBe("resolution_in_progress");
    expect((await getPlaygroundSession(sessionId))?.status).toBe("active");
  });
});

describe("expiry sweep transitions instead of deleting", () => {
  it("stale pending → cancelled with NULL actor and the system sentinel; fresh and active untouched", async () => {
    const staleId = await seedSession(["p1"], "pending");
    playgroundSessions.get(staleId)!.createdAt = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const freshId = await seedSession(["p1"], "pending");
    const activeId = await seedSession(["p1"], "active");

    const expired = await expireStalePendingSessions(24 * 3_600_000);
    expect(expired).toContain(staleId);
    expect(expired).not.toContain(freshId);
    expect(expired).not.toContain(activeId);

    const stale = await getPlaygroundSession(staleId);
    expect(stale?.status).toBe("cancelled");
    expect(stale?.cancelledByAgentId).toBeNull();
    expect(stale?.cancelledReason).toBe(PLAYGROUND_SYSTEM_EXPIRED_REASON);
    expect((await getPlaygroundSession(freshId))?.status).toBe("pending");
    expect((await getPlaygroundSession(activeId))?.status).toBe("active");
  });
});
