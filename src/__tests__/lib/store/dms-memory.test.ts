/**
 * @jest-environment node
 *
 * M11b Lane D (P6.3), memory mode — the store-level DM gates from
 * `ai/m11-2-handoff/b1-lane-d-dms-spec.md` deliverable 8's first list. The db-only races (seq
 * ordering, send-vs-block linearization, withdrawal) live in
 * `src/__tests__/integration/m11-2-b1-dms.test.ts`; this file covers what a single JS thread can
 * prove: outcomes, projections and the consumer wiring the memory dispatcher fires synchronously.
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { sendDm as sendDmAction } from "@/lib/actions/dms";
import { wakeupRouterEffects } from "@/lib/events/consumers/wakeup-router";
import {
  createAgent,
  getAgentById,
  setAgentVetted,
  listDmConversations,
  listDmMessages,
  markDmRead,
  countUnreadDms,
  sendDm,
  setDmBlock,
} from "@/lib/store";
import {
  agentLoopState,
  commentCountToday,
  eventLog,
  notifications,
  notificationDedupKeys,
  resetDmState,
  resetWakeupState,
} from "@/lib/store/_memory-state";
import { clearRateWindows } from "@/__tests__/helpers/store-fixtures";
import { listNotifications } from "@/lib/store/notifications/memory";
import { listWakeupsForAgent, claimNextWakeup, completeWakeup, enqueueWakeup } from "@/lib/store/wakeups/memory";
import { deleteAgent } from "@/lib/store/agents/memory";
import type { ExecutionGuard } from "@/lib/store/execution-guard";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

let seq = 0;
const nextName = (label: string) => `DmMem_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

/** A vetted, loop-enabled agent — loop-enabled because `resolveWakeupDelivery` requires it. */
async function freshAgent(label: string): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "dm fixture");
  await setAgentVetted(created.id, `# ${label}\n`);
  agentLoopState.set(created.id, {
    agentId: created.id,
    enabled: true,
    lastSeenAt: null,
    lastActionAt: null,
    nextEligibleAt: null,
    lastError: null,
    actionsTaken: 0,
    errors: 0,
  });
  return (await getAgentById(created.id))!;
}

function dmSentEvent(
  id: number,
  senderId: string,
  recipientId: string,
  conversationId: string,
  messageId: string,
  seqNum: number
): StoredEvent {
  return {
    id,
    kind: "dm.sent",
    actorAgentId: senderId,
    subjectType: "dm_message",
    subjectId: messageId,
    secondarySubjectId: recipientId,
    schoolId: null,
    idemKey: null,
    payload: { conversation_id: conversationId, message_id: messageId, seq: seqNum, recipient_agent_id: recipientId },
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  resetDmState();
  resetWakeupState();
  notifications.clear();
  notificationDedupKeys.clear();
  eventLog.rows.length = 0;
  eventLog.nextId = 1;
});

describe("sendDm — both directions, notification and wakeup", () => {
  it("A→B lands a dm_received notification and a dm wakeup for B", async () => {
    const a = await freshAgent("a");
    const b = await freshAgent("b");

    const result = await sendDmAction({ agent: a, recipientName: b.name, content: "hi B" });
    expect(result.ok).toBe(true);

    const notifs = (await listNotifications(b.id)).filter((n) => n.type === "dm_received");
    expect(notifs).toHaveLength(1);
    const wakeups = (await listWakeupsForAgent(b.id)).filter((w) => w.reason === "dm");
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0].payload).toMatchObject({ other_agent_id: a.id });
  });

  it("B→A (the reverse direction) lands the same shape for A", async () => {
    const a = await freshAgent("a2");
    const b = await freshAgent("b2");

    const result = await sendDmAction({ agent: b, recipientName: a.name, content: "hi A" });
    expect(result.ok).toBe(true);

    const notifs = (await listNotifications(a.id)).filter((n) => n.type === "dm_received");
    expect(notifs).toHaveLength(1);
    const wakeups = (await listWakeupsForAgent(a.id)).filter((w) => w.reason === "dm");
    expect(wakeups).toHaveLength(1);
  });
});

describe("block — 403-equivalent both directions, history intact", () => {
  it("blocks sends both ways after either side blocks, and history remains readable", async () => {
    const a = await freshAgent("blkA");
    const b = await freshAgent("blkB");
    const before = await sendDm({ senderId: a.id, recipientId: b.id, content: "before the block" });
    expect(before.outcome).toBe("inserted");

    expect(await setDmBlock(b.id, a.id, true)).toBe(true);

    const aToB = await sendDm({ senderId: a.id, recipientId: b.id, content: "after block, a to b" });
    expect(aToB.outcome).toBe("blocked");
    const bToA = await sendDm({ senderId: b.id, recipientId: a.id, content: "after block, b to a" });
    expect(bToA.outcome).toBe("blocked");

    // History from before the block is still readable by either participant.
    const history = await listDmMessages(a.id, b.id);
    expect(history.map((m) => m.content)).toEqual(["before the block"]);
  });

  it("unblock resumes sending", async () => {
    const a = await freshAgent("unbA");
    const b = await freshAgent("unbB");
    await setDmBlock(a.id, b.id, true);
    expect((await sendDm({ senderId: b.id, recipientId: a.id, content: "x" })).outcome).toBe("blocked");

    expect(await setDmBlock(a.id, b.id, false)).toBe(true);

    const resumed = await sendDm({ senderId: b.id, recipientId: a.id, content: "resumed" });
    expect(resumed.outcome).toBe("inserted");
  });
});

describe("read cursor + unread", () => {
  it("markDmRead advances the cursor and unreadCount reflects it before and after", async () => {
    const a = await freshAgent("rdA");
    const b = await freshAgent("rdB");
    await sendDm({ senderId: a.id, recipientId: b.id, content: "1" });
    // DMs share the comment cooldown (20s) — clear it so the second send is not refused as
    // `rate_limited`, which would make this a rate-limit test rather than a cursor test.
    clearRateWindows();
    await sendDm({ senderId: a.id, recipientId: b.id, content: "2" });

    expect(await countUnreadDms(b.id)).toBe(2);
    const before = await listDmConversations(b.id);
    expect(before[0].unreadCount).toBe(2);

    expect(await markDmRead(b.id, a.id)).toBe(true);

    expect(await countUnreadDms(b.id)).toBe(0);
    const after = await listDmConversations(b.id);
    expect(after[0].unreadCount).toBe(0);
  });

  it("F3: unreadFirst surfaces an older unread thread ahead of newer read ones, before the limit", async () => {
    const reader = await freshAgent("f3Reader");
    const p1 = await freshAgent("f3P1");
    const p2 = await freshAgent("f3P2");
    const p3 = await freshAgent("f3P3");

    await sendDm({ senderId: p1.id, recipientId: reader.id, content: "oldest, stays unread" });
    clearRateWindows();
    await sendDm({ senderId: p2.id, recipientId: reader.id, content: "read" });
    await markDmRead(reader.id, p2.id);
    clearRateWindows();
    await sendDm({ senderId: p3.id, recipientId: reader.id, content: "newest, read" });
    await markDmRead(reader.id, p3.id);

    // Without unreadFirst, recency alone would return the two READ threads and drop p1 entirely.
    // The tie-break among the (fast, same-tick) read threads is not this test's concern — only
    // that the unread one is guaranteed a seat ahead of the limit.
    const page = await listDmConversations(reader.id, { limit: 2, unreadFirst: true });
    expect(page[0].other.id).toBe(p1.id);
    expect(page[0].unreadCount).toBe(1);
    expect(page.map((c) => c.other.id)).toContain(p1.id);
  });
});

describe("rate limit shape", () => {
  it("sendDm returns rate_limited once the shared comment quota is exhausted", async () => {
    const a = await freshAgent("rlA");
    const b = await freshAgent("rlB");
    // Force the DAILY CAP directly — DMs share the comment quota's memory-state maps (spec).
    commentCountToday.set(a.id, { date: new Date().toISOString().slice(0, 10), count: 999999 });

    const result = await sendDm({ senderId: a.id, recipientId: b.id, content: "over the cap" });
    expect(result.outcome).toBe("rate_limited");
    expect(result.message).toBeNull();
  });
});

describe("push payload has no content", () => {
  it("the emitted dm.sent event's payload carries only ids/seq, never content", async () => {
    const a = await freshAgent("pushA");
    const b = await freshAgent("pushB");
    const before = eventLog.rows.length;

    const result = await sendDmAction({ agent: a, recipientName: b.name, content: "a secret nobody should log" });
    expect(result.ok).toBe(true);

    const emitted = eventLog.rows.slice(before).filter((e) => e.kind === "dm.sent");
    expect(emitted).toHaveLength(1);
    expect(Object.keys(emitted[0].payload).sort()).toEqual(
      ["conversation_id", "message_id", "recipient_agent_id", "seq"].sort()
    );
    expect(JSON.stringify(emitted[0].payload)).not.toContain("secret");
  });
});

describe("tombstoned participant renders as deleted", () => {
  it("listDmConversations and message history survive a participant's withdrawal", async () => {
    const a = await freshAgent("twA");
    const b = await freshAgent("twB");
    await sendDm({ senderId: a.id, recipientId: b.id, content: "before withdrawal" });

    expect(await deleteAgent(b.id)).toEqual({ ok: true });

    const conversations = await listDmConversations(a.id);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].other).toEqual({ id: b.id, name: null, deleted: true });

    const history = await listDmMessages(a.id, b.id);
    expect(history.map((m) => m.content)).toEqual(["before withdrawal"]);
  });
});

describe("F2 — preflight throws before any state changes (memory)", () => {
  /** A pre-seeded idemKey makes `prepareEventBatch` throw deterministically (duplicate-key path). */
  function seedIdemKey(key: string): void {
    eventLog.rows.push(dmSentEvent(eventLog.nextId++, "seed", "seed", "seed_conv", "seed_msg", 1));
    eventLog.rows[eventLog.rows.length - 1].idemKey = key;
  }

  it("sendDm throws and leaves no message, no conversation, no quota claimed", async () => {
    const a = await freshAgent("pfSendA");
    const b = await freshAgent("pfSendB");
    seedIdemKey("dup-send");

    await expect(
      sendDm({ senderId: a.id, recipientId: b.id, content: "should not land" }, [
        {
          kind: "dm.sent",
          actorAgentId: a.id,
          subjectType: "dm_message",
          subjectId: "x",
          secondarySubjectId: b.id,
          schoolId: null,
          idemKey: "dup-send",
          payload: { conversation_id: "x", message_id: "x", seq: 0, recipient_agent_id: b.id },
        },
      ])
    ).rejects.toThrow();

    expect(await listDmMessages(a.id, b.id)).toHaveLength(0);
    // Quota untouched: a follow-up send (no events) still succeeds as the FIRST message.
    const retry = await sendDm({ senderId: a.id, recipientId: b.id, content: "first real send" });
    expect(retry.outcome).toBe("inserted");
    expect(retry.message?.seq).toBe(1);
  });

  it("setDmBlock throws and leaves the flag unset (no conversation row created)", async () => {
    const a = await freshAgent("pfBlockA");
    const b = await freshAgent("pfBlockB");
    seedIdemKey("dup-block");

    await expect(
      setDmBlock(a.id, b.id, true, [
        {
          kind: "dm.blocked",
          actorAgentId: a.id,
          subjectType: "dm_conversation",
          subjectId: "x",
          secondarySubjectId: b.id,
          schoolId: null,
          idemKey: "dup-block",
          payload: { conversation_id: "x", target_agent_id: b.id },
        },
      ])
    ).rejects.toThrow();

    // Flag never flipped: a follow-up block (no events) reports a real change.
    expect(await setDmBlock(a.id, b.id, true)).toBe(true);
  });
});

describe("F6 — memory re-checks the sender by id (withdrawal parity with the FK)", () => {
  it("a sender withdrawn before the call is refused like agent_rate_limits' FK would refuse it", async () => {
    const a = await freshAgent("wdSendA");
    const b = await freshAgent("wdSendB");
    expect(await deleteAgent(a.id)).toEqual({ ok: true });

    const result = await sendDm({ senderId: a.id, recipientId: b.id, content: "from the void" });
    expect(result).toEqual({ outcome: "sender_gone", message: null });
    expect(await listDmMessages(a.id, b.id)).toHaveLength(0);
  });
});

describe("F1 — the execution guard reaches send/read/block (memory)", () => {
  async function claimGuardFor(agentId: string): Promise<ExecutionGuard> {
    const created = await enqueueWakeup({ agentId, reason: "idle", eventId: null, payload: {}, delivery: "internal" });
    if (!created.created) throw new Error("expected a fresh idle wakeup");
    const claim = await claimNextWakeup({ claimToken: "tok-f1", leaseMs: 600_000, generalCap: 50, playgroundCap: 50 });
    if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");
    return { agentId, wakeupId: claim.claimed.id, claimToken: claim.claimed.claimToken! };
  }

  it("sendDm passes with a live claim, and refuses once disabled before the write", async () => {
    const a = await freshAgent("f1SendA");
    const b = await freshAgent("f1SendB");
    const guard = await claimGuardFor(a.id);
    expect((await sendDm({ senderId: a.id, recipientId: b.id, content: "guarded" }, [], guard)).outcome).toBe(
      "inserted"
    );
    // Completed so the idle dedup (one PENDING-OR-CLAIMED row per agent) admits a fresh claim.
    await completeWakeup(guard.wakeupId, guard.claimToken, "acted");

    const guard2 = await claimGuardFor(a.id);
    agentLoopState.get(a.id)!.enabled = false;
    const result = await sendDm({ senderId: a.id, recipientId: b.id, content: "should not land" }, [], guard2);
    expect(result).toEqual({ outcome: "execution_guard_failed", message: null });
    expect(await listDmMessages(a.id, b.id)).toHaveLength(1); // still just the guarded success above
  });

  it("markDmRead does not advance the cursor once disabled before the write", async () => {
    const a = await freshAgent("f1ReadA");
    const b = await freshAgent("f1ReadB");
    expect((await sendDm({ senderId: a.id, recipientId: b.id, content: "hi" })).outcome).toBe("inserted");
    const guard = await claimGuardFor(b.id);
    agentLoopState.get(b.id)!.enabled = false;

    expect(await markDmRead(b.id, a.id, guard)).toBe(false);
    expect(await countUnreadDms(b.id)).toBe(1);
  });

  it("setDmBlock does not flip the flag once disabled before the write", async () => {
    const a = await freshAgent("f1BlockA");
    const b = await freshAgent("f1BlockB");
    const guard = await claimGuardFor(a.id);
    agentLoopState.get(a.id)!.enabled = false;

    expect(await setDmBlock(a.id, b.id, true, undefined, guard)).toBe(false);
    expect((await sendDm({ senderId: a.id, recipientId: b.id, content: "not blocked" })).outcome).toBe("inserted");
  });
});

describe("F4 — the route answers 404 for a sender withdrawn mid-request, never 429/500", () => {
  it("the send action classifies a withdrawn sender as not_found (memory mode)", async () => {
    const a = await freshAgent("f4SendA");
    const b = await freshAgent("f4SendB");
    expect(await deleteAgent(a.id)).toEqual({ ok: true });

    const result = await sendDmAction({ agent: a, recipientName: b.name, content: "from the void" });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: "not_found" }));
  });
});

describe("consumer wiring — drain-time block re-check suppresses the wakeup", () => {
  /**
   * The memory dispatcher fires synchronously on emit, so there is no real gap between a send and
   * its drain to race a block into. Driving `wakeupRouterEffects.apply` directly on a `dm.sent`
   * event, AFTER the block has landed, is the honest way to prove the re-check: it is the same
   * code path a delayed drain would take against a block that committed in between.
   */
  it("apply() enqueues nothing once the pair is blocked, even for an already-sent message", async () => {
    const a = await freshAgent("raceA");
    const b = await freshAgent("raceB");
    const sent = await sendDm({ senderId: a.id, recipientId: b.id, content: "in flight" });
    expect(sent.outcome).toBe("inserted");
    const msg = sent.message!;

    // Block lands after the send committed — the exact window `routeDmSent` re-checks for.
    await setDmBlock(b.id, a.id, true);

    const before = await listWakeupsForAgent(b.id);
    await wakeupRouterEffects.apply(dmSentEvent(9001, a.id, b.id, msg.conversationId, msg.id, msg.seq));
    const after = await listWakeupsForAgent(b.id);

    expect(after.filter((w) => w.reason === "dm")).toEqual(before.filter((w) => w.reason === "dm"));
  });

  it("apply() enqueues a dm wakeup for an unblocked pair (the non-suppressed control case)", async () => {
    const a = await freshAgent("okA");
    const b = await freshAgent("okB");
    const sent = await sendDm({ senderId: a.id, recipientId: b.id, content: "unblocked" });
    const msg = sent.message!;

    await wakeupRouterEffects.apply(dmSentEvent(9002, a.id, b.id, msg.conversationId, msg.id, msg.seq));

    const wakeups = (await listWakeupsForAgent(b.id)).filter((w) => w.reason === "dm");
    expect(wakeups).toHaveLength(1);
  });
});
