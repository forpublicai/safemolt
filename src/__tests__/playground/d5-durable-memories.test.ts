/**
 * @jest-environment node
 *
 * M11-1b D5, memory mode: the durable-memory facade's semantics, the CAS-coupled write, the
 * cancellation/agent-deletion sweeps, and the actor-keyed ingest chunk id. Cross-instance
 * persistence and the db-side fence run in `src/__tests__/integration/d5-playground-memories.test.ts`.
 */

jest.mock("@/lib/playground/embeddings", () => ({
  getEmbedding: jest.fn(async () => undefined),
}));

// The GM transport, captured so the prompt's memory context can be read back.
const chatCalls: Array<Array<{ role: string; content: string }>> = [];
jest.mock("@/lib/playground/llm", () => ({
  chatCompletion: jest.fn(async (messages: Array<{ role: string; content: string }>) => {
    chatCalls.push(messages);
    return "generated prompt";
  }),
}));
const lastChatMessages = () => chatCalls[chatCalls.length - 1].map((m) => m.content).join("\n");

// The vector sink, captured so the chunk-id derivation can be asserted directly.
const capturedChunkBatches: Array<{ id: string }[]> = [];
jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async (_agentId: string, chunks: { id: string }[]) => {
    capturedChunkBatches.push(chunks);
  }),
  pruneIngestedVectorsForAgent: jest.fn(async () => undefined),
  deleteVectorsForAgent: jest.fn(async () => undefined),
  listVectorIdsForAgentByMetadata: jest.fn(async () => []),
  putContextAndMaybeIndex: jest.fn(async () => ({ path: "x" })),
}));

import {
  clearAgentMemories,
  clearSessionMemories,
  getAllSessionMemories,
  getMemoriesForAgent,
  prepareResolutionMemory,
  retrieveMemories,
  storeMemory,
} from "@/lib/playground/memory";
import {
  applyPlaygroundResolution,
  cancelPlaygroundSession,
  claimPlaygroundResolution,
  createPlaygroundSession,
  getPlaygroundSession,
} from "@/lib/store";
import { generateRoundPrompt } from "@/lib/playground/engine";
import { ingestPlaygroundSnippetForParticipants } from "@/lib/memory/platform-ingest";
import { agents, playgroundAgentMemories } from "@/lib/store/_memory-state";

let seq = 0;

async function seedSession(participantIds: string[], status: "pending" | "active" = "active") {
  const id = `d5_sess_${Date.now()}_${seq++}`;
  // Participants are registered agents. Memory mode has no FK, but the CAS-coupled write checks
  // the agent map for the same reason db mode joins `agents` — so the fixture must be honest, or
  // it would assert a behaviour real participants never see.
  for (const agentId of participantIds) {
    agents.set(agentId, { id: agentId, name: agentId } as never);
  }
  await createPlaygroundSession({
    id,
    gameId: "game-1",
    schoolId: `school_${id}`,
    status,
    participants: participantIds.map((agentId) => ({
      agentId,
      agentName: agentId,
      status: "active" as const,
      missedRounds: 0,
    })),
    currentRound: 1,
    maxRounds: 3,
    startedAt: new Date().toISOString(),
  });
  return id;
}

describe("durable memory semantics (memory mode)", () => {
  it("keeps ONE record per (agent, session), overwritten each round", async () => {
    const sessionId = await seedSession(["a1"]);
    await storeMemory({ agentId: "a1", agentName: "a1", sessionId, content: "round 1", importance: "low", roundCreated: 1 });
    await storeMemory({ agentId: "a1", agentName: "a1", sessionId, content: "round 2", importance: "high", roundCreated: 2 });

    const all = await getAllSessionMemories(sessionId);
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("round 2");
    expect(all[0].importance).toBe("high");
    expect(all[0].roundCreated).toBe(2);
    expect((await getMemoriesForAgent(sessionId, "a1"))?.content).toBe("round 2");
  });

  it("round-trips every field, including the importance label and the embedding", async () => {
    const sessionId = await seedSession(["a2"]);
    await storeMemory({
      agentId: "a2",
      agentName: "Agent Two",
      sessionId,
      content: "remembered",
      importance: "critical",
      roundCreated: 3,
      embedding: [0.5, 0.25],
    });
    const stored = await getMemoriesForAgent(sessionId, "a2");
    expect(stored).toMatchObject({
      agentId: "a2",
      agentName: "Agent Two",
      sessionId,
      content: "remembered",
      importance: "critical",
      roundCreated: 3,
      embedding: [0.5, 0.25],
    });
    expect(stored?.createdAt).toEqual(expect.any(String));
  });

  it("retrieval still scores over the stored rows", async () => {
    const sessionId = await seedSession(["a3", "a4"]);
    await storeMemory({ agentId: "a3", agentName: "a3", sessionId, content: "the treaty was signed", importance: "medium", roundCreated: 1 });
    await storeMemory({ agentId: "a4", agentName: "a4", sessionId, content: "nothing happened", importance: "low", roundCreated: 1 });

    const results = await retrieveMemories({ sessionId, query: "treaty", limit: 5 });
    expect(results[0].memory.agentId).toBe("a3");

    const scoped = await retrieveMemories({ sessionId, agentId: "a4", query: "treaty", limit: 5 });
    expect(scoped.every((r) => r.memory.agentId === "a4")).toBe(true);
  });
});

describe("the CAS-coupled write (D5 atomic follow-up)", () => {
  const memory = (agentId: string, sessionId: string, content: string) =>
    prepareResolutionMemory({ agentId, agentName: agentId, sessionId, content, importance: "high", roundCreated: 1 });

  it("a resolver that loses the CAS writes NO memory; the winner writes them with the advance", async () => {
    const sessionId = await seedSession(["p1", "p2"]);
    expect(await claimPlaygroundResolution(sessionId, 1, "live_tok", 60_000)).toBe(true);

    // Wrong token: not the winner. The session does not advance AND no memory lands.
    expect(
      await applyPlaygroundResolution(sessionId, { round: 1, token: "stale_tok" }, { currentRound: 2 }, [
        memory("p1", sessionId, "loser"),
      ])
    ).toBe(false);
    expect(await getAllSessionMemories(sessionId)).toHaveLength(0);

    // Wrong round: the round already advanced.
    expect(
      await applyPlaygroundResolution(sessionId, { round: 99, token: "live_tok" }, { currentRound: 100 }, [
        memory("p1", sessionId, "stale round"),
      ])
    ).toBe(false);
    expect(await getAllSessionMemories(sessionId)).toHaveLength(0);

    // The live claimant advances the round and writes EVERY participant's memory in the same step.
    expect(
      await applyPlaygroundResolution(sessionId, { round: 1, token: "live_tok" }, { currentRound: 2 }, [
        memory("p1", sessionId, "winner p1"),
        memory("p2", sessionId, "winner p2"),
      ])
    ).toBe(true);
    const stored = await getAllSessionMemories(sessionId);
    expect(stored.map((m) => m.content).sort()).toEqual(["winner p1", "winner p2"]);
    expect((await getPlaygroundSession(sessionId))!.currentRound).toBe(2);
  });

  it("REFUSES THE ADVANCE when any one memory row is unwritable — the db's rollback, in memory mode", async () => {
    // Db mode gets this from the statement boundary: a NULL in a NOT NULL column aborts the insert
    // and takes the advance with it. Memory mode has no constraints, so it validates the whole
    // payload before touching either map. Without that the two modes disagree on exactly the case
    // the db-side rollback gate pins.
    const sessionId = await seedSession(["ok", "broken"]);
    expect(await claimPlaygroundResolution(sessionId, 1, "rb_tok", 60_000)).toBe(true);

    await expect(
      applyPlaygroundResolution(sessionId, { round: 1, token: "rb_tok" }, { currentRound: 2 }, [
        memory("ok", sessionId, "would have landed"),
        { ...memory("broken", sessionId, "unwritable"), content: null as unknown as string },
      ])
    ).rejects.toThrow();

    expect(await getAllSessionMemories(sessionId)).toHaveLength(0);
    const session = (await getPlaygroundSession(sessionId))!;
    expect(session.currentRound).toBe(1);
    expect(session.resolveClaimToken).toBe("rb_tok"); // retryable: nothing was consumed
  });

  it("writes one row per agent even when a participant is listed twice", async () => {
    // `participants` is unvalidated JSONB. Two rows for one agent make the db's coupled upsert
    // raise 21000, which would wedge the session — so the builder dedupes and both stores must
    // agree on the result.
    const sessionId = await seedSession(["dup"]);
    expect(await claimPlaygroundResolution(sessionId, 1, "dup_tok", 60_000)).toBe(true);
    expect(
      await applyPlaygroundResolution(sessionId, { round: 1, token: "dup_tok" }, { currentRound: 2 }, [
        memory("dup", sessionId, "first"),
        memory("dup", sessionId, "second"),
      ])
    ).toBe(true);
    const stored = await getAllSessionMemories(sessionId);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("second");
  });

  it("a deleted participant's memory cannot VETO the advance", async () => {
    // Db mode enforces this with an FK that must never be allowed to raise; memory mode has no FK,
    // so it checks the agent map for the same observable behaviour. Either way the advance wins.
    const sessionId = await seedSession(["known", "vanished"]);
    agents.delete("vanished"); // deleted mid-session; still listed as a participant
    expect(await claimPlaygroundResolution(sessionId, 1, "veto_tok", 60_000)).toBe(true);

    expect(
      await applyPlaygroundResolution(sessionId, { round: 1, token: "veto_tok" }, { currentRound: 2 }, [
        memory("known", sessionId, "still here"),
        memory("vanished", sessionId, "gone"),
      ])
    ).toBe(true);

    expect((await getAllSessionMemories(sessionId)).map((m) => m.content)).toEqual(["still here"]);
    expect((await getPlaygroundSession(sessionId))!.currentRound).toBe(2);
  });

  it("an empty memory payload is a won CAS, not a lost one (the all-forfeited path)", async () => {
    const sessionId = await seedSession(["p3"]);
    expect(await claimPlaygroundResolution(sessionId, 1, "tok", 60_000)).toBe(true);
    expect(await applyPlaygroundResolution(sessionId, { round: 1, token: "tok" }, { currentRound: 2 }, [])).toBe(true);
    expect(await getAllSessionMemories(sessionId)).toHaveLength(0);
  });
});

describe("the next round's GM context", () => {
  it("sees THIS round's memories, which the CAS has not written yet", async () => {
    // The D5 atomic follow-up moved the memory write after the prompt is generated. Reading only
    // the store would hand the next round's GM the memories of the round BEFORE last, so the
    // prepared rows are passed in and must win over what is stored.
    const sessionId = await seedSession(["gm1"]);
    await storeMemory({ agentId: "gm1", agentName: "gm1", sessionId, content: "LAST ROUND", importance: "low", roundCreated: 1 });

    const session = (await getPlaygroundSession(sessionId))!;
    const game = {
      id: "g", name: "G", minPlayers: 1, maxPlayers: 4, premise: "", rules: "",
      scenes: [{ name: "s", description: "d", numRounds: 3, actionSpec: { type: "free", callToAction: "act" } }],
    };

    await generateRoundPrompt(session, game as never);
    expect(lastChatMessages()).toContain("LAST ROUND");

    await generateRoundPrompt(session, game as never, [
      prepareResolutionMemory({ agentId: "gm1", agentName: "gm1", sessionId, content: "THIS ROUND", importance: "high", roundCreated: 2 }),
    ]);
    const withPending = lastChatMessages();
    expect(withPending).toContain("THIS ROUND");
    expect(withPending).not.toContain("LAST ROUND");
  });
});

describe("cleanup", () => {
  it("cancellation sweeps the session's memories — a TRANSITION, so no cascade fires", async () => {
    const sessionId = await seedSession(["c1"]);
    await storeMemory({ agentId: "c1", agentName: "c1", sessionId, content: "will be swept", importance: "low", roundCreated: 1 });
    expect(await getAllSessionMemories(sessionId)).toHaveLength(1);

    expect((await cancelPlaygroundSession(sessionId, "c1", "done here")).outcome).toBe("cancelled");
    expect(await getAllSessionMemories(sessionId)).toHaveLength(0);
  });

  it("agent-scoped and session-scoped sweeps remove only their own rows", async () => {
    const sessionA = await seedSession(["x1", "x2"]);
    const sessionB = await seedSession(["x1"]);
    for (const [sid, aid] of [[sessionA, "x1"], [sessionA, "x2"], [sessionB, "x1"]] as const) {
      await storeMemory({ agentId: aid, agentName: aid, sessionId: sid, content: "m", importance: "low", roundCreated: 1 });
    }

    await clearAgentMemories("x1");
    expect((await getAllSessionMemories(sessionA)).map((m) => m.agentId)).toEqual(["x2"]);
    expect(await getAllSessionMemories(sessionB)).toHaveLength(0);

    await clearSessionMemories(sessionA);
    expect(await getAllSessionMemories(sessionA)).toHaveLength(0);
    // Nothing else was touched.
    expect(Array.from(playgroundAgentMemories.values()).filter((m) => m.sessionId === sessionA)).toHaveLength(0);
  });
});

describe("actor-keyed ingest chunk ids", () => {
  it("same-round actions by different agents produce DISTINCT chunk ids; GM chunks are unchanged", async () => {
    capturedChunkBatches.length = 0;
    const ingest = ingestPlaygroundSnippetForParticipants;
    const sessionId = "d5_chunk_session";
    // Above MIN_CHUNK_CHARS (50) — shorter text produces no chunks at all, and a test that
    // asserted on zero chunks would pass for the wrong reason.
    const actionOne = "Agent one advances toward the northern gate and offers terms of trade.";
    const actionTwo = "Agent two withdraws to the harbour and prepares a counter-offer instead.";
    const narration = "The Game Master narrates the outcome of the round for all participants.";

    // Two agents acting in the SAME round — the collision case: pre-D5 both derived
    // sha256(session|round|kind|index) and overwrote each other in every recipient's store.
    await ingest(["r1"], actionOne, { sessionId, round: 1, kind: "playground_action", actorAgentId: "a1", actionId: "act_1" });
    await ingest(["r1"], actionTwo, { sessionId, round: 1, kind: "playground_action", actorAgentId: "a2", actionId: "act_2" });
    // A GM chunk has no action row: its derivation is deliberately unchanged.
    await ingest(["r1"], narration, { sessionId, round: 1, kind: "playground_gm" });
    await ingest(["r1"], narration, { sessionId, round: 1, kind: "playground_gm" });

    const ids = capturedChunkBatches.map((chunks) => chunks[0]?.id);
    expect(ids).toHaveLength(4);
    expect(ids[0]).not.toBe(ids[1]); // the two actions are distinct
    expect(ids[2]).toBe(ids[3]); // GM derivation unchanged (stable for the same round)
  });

  it("the exported ingest keeps its signature for callers that pass no actionId", async () => {
    await expect(
      ingestPlaygroundSnippetForParticipants([], "no recipients", { sessionId: "s", round: 1, kind: "playground_gm" })
    ).resolves.toBeUndefined();
  });
});
