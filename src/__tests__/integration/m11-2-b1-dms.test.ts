/**
 * M11b Lane D (P6.3) `[integration]` — direct messages against a real Postgres.
 *
 * The memory-mode suite (`src/__tests__/lib/store/dms-memory.test.ts`) proves the shapes; only a
 * real statement under contention can prove:
 *
 *  - concurrent sends between the same pair get DISTINCT, increasing seqs, and commit order equals
 *    actual resolution order — proven with a real held-lock barrier, not wall-clock racing
 *    (codex round 2, F2; see `holdPairRow`/`waitForWaiterCount` below);
 *  - a send racing a block on the SAME pair, both genuinely queued behind a barrier, resolves to
 *    exactly one self-consistent outcome, never both "sent" and "blocked-before-it";
 *  - a block, once it lands, refuses BOTH directions;
 *  - a read granted before a held send commits does not count the in-flight message as read;
 *  - a withdrawn sender is refused as `sender_gone`, never a 500 (F4);
 *  - a withdrawn participant's history survives, tombstoned.
 *
 * Store functions are imported directly from `dms/db.ts` (not the `pickStore` facade), matching
 * `m11-2-u3b-social.test.ts`'s own precedent for statement-level races.
 *
 * @jest-environment node
 */
import {
  sendDm,
  setDmBlock,
  listDmMessages,
  markDmRead,
  countUnreadDms,
  listDmConversations,
  type SendDmResult,
} from "@/lib/store/dms/db";
import { deleteAgent } from "@/lib/store/agents/db";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { claimNextWakeup, enqueueWakeup } from "@/lib/store/wakeups/db";
import type { ExecutionGuard } from "@/lib/store/execution-guard";

type SendDmOutcome = SendDmResult;

import { pidOf } from "./helpers/concurrency";
import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `b1dm_${kind}_${RUN}_${(seq += 1)}`;

/** Force one event kind's insert to fail, mirroring `m11-2-u3e-evaluations.test.ts`'s own helper. */
async function withEventFailure<T>(kind: string, run: () => Promise<T>): Promise<T> {
  const suffix = `b1dm_${RUN}_${(seq += 1)}`;
  const functionName = `b1dm_fail_event_${suffix}`;
  const triggerName = `b1dm_fail_event_trigger_${suffix}`;
  await pgPool().query(`
    CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.kind = '${kind}' THEN RAISE EXCEPTION 'b1dm injected ${kind} failure'; END IF;
      RETURN NEW;
    END; $fn$;
  `);
  await pgPool().query(`CREATE TRIGGER ${triggerName} AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  try {
    return await run();
  } finally {
    await pgPool().query(`DROP TRIGGER IF EXISTS ${triggerName} ON events`);
    await pgPool().query(`DROP FUNCTION IF EXISTS ${functionName}()`);
  }
}

async function seedAgent(): Promise<{ id: string; name: string }> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}_named`, `b1dm_key_${id}`]
  );
  return { id, name: `${id}_named` };
}

function canonicalPair(a: string, b: string): { agentLow: string; agentHigh: string } {
  return a < b ? { agentLow: a, agentHigh: b } : { agentLow: b, agentHigh: a };
}

/** DMs share the comment cooldown (per sender) — cleared between two sends from the same sender. */
async function clearRateWindow(agentId: string): Promise<void> {
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id = $1`, [agentId]);
}

/** Pre-create the pair row so a raw connection can hold its own lock on it before any send. */
async function seedConversation(a: string, b: string): Promise<string> {
  const { agentLow, agentHigh } = canonicalPair(a, b);
  const id = nextId("conv");
  await pgPool().query(
    `INSERT INTO dm_conversations (id, agent_low, agent_high, created_at, last_message_seq)
     VALUES ($1, $2, $3, NOW(), 0)`,
    [id, agentLow, agentHigh]
  );
  return id;
}

/** Every DM statement that locks the pair row carries this marker (`dms/db.ts`) — send, block, read. */
const PAIR_LOCK_MARKER = "race:dm-send-pair-lock";

/**
 * M11b Lane D codex round 2, F2 — a genuine barrier over the Neon HTTP driver's auto-commit
 * connections: hold the pair row `FOR NO KEY UPDATE` on a dedicated `pg` session (the same mode
 * `sendDm`'s own `target` CTE takes), so every app-level statement against that row provably
 * blocks until released, rather than merely racing in wall-clock time (`helpers/concurrency.ts`'s
 * own header explains why a bare `Promise.all` proves nothing over this driver). The client is
 * ALWAYS committed and closed by `withHeldPairRow`, even when the body throws.
 */
async function withHeldPairRow<T>(
  agentLow: string,
  agentHigh: string,
  body: (pid: number) => Promise<T>
): Promise<T> {
  const client = await pgClient();
  const pid = await pidOf(client);
  await client.query("BEGIN");
  await client.query(
    `SELECT id FROM dm_conversations WHERE agent_low = $1 AND agent_high = $2 FOR NO KEY UPDATE`,
    [agentLow, agentHigh]
  );
  try {
    return await body(pid);
  } finally {
    await client.query("COMMIT").catch(() => {});
    await client.end().catch(() => {});
  }
}

/**
 * How many backends are blocked, directly or transitively, on a query carrying `PAIR_LOCK_MARKER`.
 *
 * NOT `waitersOn(holderPid)`: PostgreSQL QUEUES row-lock waiters, so with two contenders the SECOND
 * is blocked by the FIRST WAITER, not by the original holder — `pg_blocking_pids` reports only the
 * direct blocker (m11-2-u3f-core-classes.test.ts's own `enrollInClass` race hit the identical
 * shape). Counting every marker-bearing backend that is blocked by ANYONE catches the whole chain.
 */
async function waitForBlockedCount(count: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let blocked = 0;
  while (Date.now() < deadline) {
    const { rows } = await pgPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND cardinality(pg_blocking_pids(pid)) > 0
         AND query LIKE $1`,
      [`%${PAIR_LOCK_MARKER}%`]
    );
    blocked = rows[0].n;
    if (blocked >= count) return blocked;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return blocked;
}

/**
 * Stage two contenders so Postgres's FIFO row-lock queue — not wall-clock scheduling — decides the
 * winner: start `first`, prove it alone is queued behind the holder, THEN start `second` and prove
 * it queues too, and only then release. `first` is thereby guaranteed to commit before `second`, a
 * fact this function establishes rather than a guess from which promise resolves first in JS
 * (codex round 3, finding 2 — response order is never the same thing as commit order).
 */
async function stageRace<A, B>(
  agentLow: string,
  agentHigh: string,
  first: () => Promise<A>,
  second: () => Promise<B>
): Promise<{ firstResult: A; secondResult: B }> {
  const staged = await withHeldPairRow(agentLow, agentHigh, async () => {
    const firstPromise = first();
    const firstCount = await waitForBlockedCount(1);
    const secondPromise = second();
    const secondCount = await waitForBlockedCount(2);
    return { firstPromise, secondPromise, firstCount, secondCount };
  });
  expect(staged.firstCount).toBeGreaterThanOrEqual(1);
  expect(staged.secondCount).toBeGreaterThanOrEqual(2);
  const [firstResult, secondResult] = await Promise.all([staged.firstPromise, staged.secondPromise]);
  return { firstResult, secondResult };
}

/** A real claimed wakeup, for the execution-guard tests — mirrors `m11-2-u6-pulse-runner.test.ts`. */
async function claimGuardFor(agentId: string): Promise<ExecutionGuard> {
  await pgPool().query(`INSERT INTO agent_loop_state (agent_id, enabled) VALUES ($1, true)`, [agentId]);
  const created = await enqueueWakeup({ agentId, reason: "idle", eventId: null, payload: {}, delivery: "internal" });
  if (!created.created) throw new Error("expected a fresh idle wakeup");
  const claim = await claimNextWakeup({ claimToken: nextId("token"), leaseMs: 600_000, generalCap: 50, playgroundCap: 50 });
  if (claim.candidates !== 1 || !claim.claimed) throw new Error("expected a successful claim");
  return { agentId, wakeupId: claim.claimed.id, claimToken: claim.claimed.claimToken! };
}

afterAll(async () => {
  const like = `b1dm_%_${RUN}%`;
  await pgPool().query(
    `DELETE FROM dm_messages WHERE conversation_id IN (
       SELECT id FROM dm_conversations WHERE agent_low LIKE $1 OR agent_high LIKE $1
     )`,
    [like]
  );
  await pgPool().query(`DELETE FROM dm_conversations WHERE agent_low LIKE $1 OR agent_high LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM events WHERE actor_agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agent_wakeups WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agent_loop_state WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("F1 — the execution guard reaches sendDm's decisive statement", () => {
  it("passes for an enabled agent with a live claim", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const guard = await claimGuardFor(a.id);

    const result = await sendDm({ senderId: a.id, recipientId: b.id, content: "guarded send" }, [], guard);
    expect(result.outcome).toBe("inserted");
  });

  it("refuses — no message, no seq bump — once disabled before the guarded statement runs", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const guard = await claimGuardFor(a.id);
    // The human disables autonomy AFTER the claim but BEFORE the guarded mutation runs.
    await pgPool().query(`UPDATE agent_loop_state SET enabled = false WHERE agent_id = $1`, [a.id]);

    const result = await sendDm({ senderId: a.id, recipientId: b.id, content: "should not land" }, [], guard);
    expect(result).toEqual({ outcome: "execution_guard_failed", message: null });

    const { rows } = await pgPool().query(`SELECT count(*)::int AS n FROM dm_messages WHERE sender_agent_id = $1`, [
      a.id,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it("markDmRead answers execution_guard_failed, not a bare false, once disabled (codex round 3, F1)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    expect((await sendDm({ senderId: a.id, recipientId: b.id, content: "seed" })).outcome).toBe("inserted");
    const guard = await claimGuardFor(b.id);
    await pgPool().query(`UPDATE agent_loop_state SET enabled = false WHERE agent_id = $1`, [b.id]);

    expect(await markDmRead(b.id, a.id, guard)).toBe("execution_guard_failed");
    expect(await countUnreadDms(b.id)).toBe(1);
  });

  it("setDmBlock answers execution_guard_failed, not a bare false, once disabled (codex round 3, F1)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const guard = await claimGuardFor(a.id);
    await pgPool().query(`UPDATE agent_loop_state SET enabled = false WHERE agent_id = $1`, [a.id]);

    expect(await setDmBlock(a.id, b.id, true, undefined, guard)).toBe("execution_guard_failed");
    expect((await sendDm({ senderId: b.id, recipientId: a.id, content: "not blocked" })).outcome).toBe("inserted");
  });
});

describe("F3 — a refused guard on a fresh pair commits no conversation", () => {
  it("a guard failure on a pair's first-ever send leaves no conversation, message, quota, or event", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const guard = await claimGuardFor(a.id);
    await pgPool().query(`UPDATE agent_loop_state SET enabled = false WHERE agent_id = $1`, [a.id]);

    const result = await sendDm(
      { senderId: a.id, recipientId: b.id, content: "must not create anything" },
      [dmSentEvent(a.id, b.id)],
      guard
    );
    expect(result).toEqual({ outcome: "execution_guard_failed", message: null });

    const { agentLow, agentHigh } = canonicalPair(a.id, b.id);
    const conv = await pgPool().query(`SELECT id FROM dm_conversations WHERE agent_low = $1 AND agent_high = $2`, [
      agentLow,
      agentHigh,
    ]);
    expect(conv.rows).toHaveLength(0);

    const msgs = await pgPool().query(`SELECT id FROM dm_messages WHERE sender_agent_id = $1`, [a.id]);
    expect(msgs.rows).toHaveLength(0);

    const quota = await pgPool().query(`SELECT agent_id FROM agent_rate_limits WHERE agent_id = $1`, [a.id]);
    expect(quota.rows).toHaveLength(0);

    const events = await pgPool().query(`SELECT id FROM events WHERE kind = 'dm.sent' AND actor_agent_id = $1`, [a.id]);
    expect(events.rows).toHaveLength(0);
  });
});

describe("concurrent sends — staged so the FIFO queue's order is the PREDETERMINED commit order", () => {
  /**
   * **A pair has exactly two possible senders, and each is capped at one send per cooldown
   * window** (DMs share the comment cooldown), so the only genuine two-writer race for one pair
   * is the two directions firing at once. `stageRace` proves which one queues first, so the
   * committed seq order is asserted from that fact, never from which promise resolved first in JS
   * (codex round 3, finding 2 — the prior version compared committed rows to JS resolution order).
   */
  it("the first-staged sender gets the lower seq", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const { agentLow, agentHigh } = canonicalPair(a.id, b.id);
    const conversationId = await seedConversation(a.id, b.id);

    const { firstResult, secondResult } = await stageRace(
      agentLow,
      agentHigh,
      () => sendDm({ senderId: a.id, recipientId: b.id, content: "from a" }),
      () => sendDm({ senderId: b.id, recipientId: a.id, content: "from b" })
    );
    expect(firstResult.outcome).toBe("inserted");
    expect(secondResult.outcome).toBe("inserted");

    const { rows } = await pgPool().query<{ sender_agent_id: string }>(
      `SELECT sender_agent_id FROM dm_messages WHERE conversation_id = $1 ORDER BY seq ASC`,
      [conversationId]
    );
    expect(rows.map((r) => r.sender_agent_id)).toEqual([a.id, b.id]);
  });

  it("staging the other sender first flips which one gets the lower seq", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const { agentLow, agentHigh } = canonicalPair(a.id, b.id);
    const conversationId = await seedConversation(a.id, b.id);

    const { firstResult, secondResult } = await stageRace(
      agentLow,
      agentHigh,
      () => sendDm({ senderId: b.id, recipientId: a.id, content: "from b" }),
      () => sendDm({ senderId: a.id, recipientId: b.id, content: "from a" })
    );
    expect(firstResult.outcome).toBe("inserted");
    expect(secondResult.outcome).toBe("inserted");

    const { rows } = await pgPool().query<{ sender_agent_id: string }>(
      `SELECT sender_agent_id FROM dm_messages WHERE conversation_id = $1 ORDER BY seq ASC`,
      [conversationId]
    );
    expect(rows.map((r) => r.sender_agent_id)).toEqual([b.id, a.id]);
  });
});

describe("send-vs-block linearization — staged so the FIFO queue's order is the PREDETERMINED outcome", () => {
  /**
   * Which one is staged first now DECIDES the outcome, rather than describing it after the fact:
   * a send staged before the block still sees the flag unset (the block commits after) and a send
   * staged after an already-committed block sees it set. Both operation orders, both directions —
   * four deterministic cases replacing the two response-order-branching ones (codex round 3, F2).
   */
  async function raceSendAgainstBlock(
    order: "send-first" | "block-first",
    sendArgs: Parameters<typeof sendDm>[0],
    blockerId: string,
    targetId: string
  ): Promise<{ sendOutcome: SendDmOutcome; blockChanged: boolean }> {
    const { agentLow, agentHigh } = canonicalPair(sendArgs.senderId, sendArgs.recipientId);
    // The pair row must exist before a raw connection can lock it.
    await seedConversation(sendArgs.senderId, sendArgs.recipientId);

    const send = () => sendDm(sendArgs);
    const block = () => setDmBlock(blockerId, targetId, true);
    const { firstResult, secondResult } =
      order === "send-first" ? await stageRace(agentLow, agentHigh, send, block) : await stageRace(agentLow, agentHigh, block, send);

    return order === "send-first"
      ? { sendOutcome: firstResult as SendDmOutcome, blockChanged: secondResult as boolean }
      : { sendOutcome: secondResult as SendDmOutcome, blockChanged: firstResult as boolean };
  }

  it("forward, send staged first: the blocker's own send still lands before their block applies", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const { sendOutcome, blockChanged } = await raceSendAgainstBlock(
      "send-first",
      { senderId: a.id, recipientId: b.id, content: "racing my own block" },
      a.id,
      b.id
    );
    expect(sendOutcome.outcome).toBe("inserted");
    expect(blockChanged).toBe(true);
    expect((await sendDm({ senderId: a.id, recipientId: b.id, content: "after settling" })).outcome).toBe("blocked");
  });

  it("forward, block staged first: the blocker's own send is refused by their own already-committed block", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const { sendOutcome, blockChanged } = await raceSendAgainstBlock(
      "block-first",
      { senderId: a.id, recipientId: b.id, content: "racing my own block" },
      a.id,
      b.id
    );
    expect(blockChanged).toBe(true);
    expect(sendOutcome.outcome).toBe("blocked");
  });

  it("reverse, send staged first: the about-to-be-blocked agent's send lands before the block applies", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const { sendOutcome, blockChanged } = await raceSendAgainstBlock(
      "send-first",
      { senderId: b.id, recipientId: a.id, content: "racing the block against me" },
      a.id,
      b.id
    );
    expect(sendOutcome.outcome).toBe("inserted");
    expect(blockChanged).toBe(true);
    expect((await sendDm({ senderId: b.id, recipientId: a.id, content: "after settling" })).outcome).toBe("blocked");
  });

  it("reverse, block staged first: the about-to-be-blocked agent's send is refused by the already-committed block", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const { sendOutcome, blockChanged } = await raceSendAgainstBlock(
      "block-first",
      { senderId: b.id, recipientId: a.id, content: "racing the block against me" },
      a.id,
      b.id
    );
    expect(blockChanged).toBe(true);
    expect(sendOutcome.outcome).toBe("blocked");
  });
});

describe("both-direction rejection once blocked", () => {
  it("refuses blocker→blocked and blocked→blocker alike", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    expect(await setDmBlock(a.id, b.id, true)).toBe(true);

    const forward = await sendDm({ senderId: a.id, recipientId: b.id, content: "x" });
    const reverse = await sendDm({ senderId: b.id, recipientId: a.id, content: "y" });
    expect(forward.outcome).toBe("blocked");
    expect(reverse.outcome).toBe("blocked");
  });
});

describe("mark-read racing a held send — a real held-lock barrier", () => {
  /**
   * `markDmRead` is queued FIRST (confirmed via `waitForWaiterCount` before the send even starts),
   * so Postgres's FIFO row-lock queue grants it before the send — deterministic, not a guess: the
   * cursor is set from `last_message_seq` as it stood BEFORE the send's `bumped` CTE committed, so
   * the still-in-flight message must stay unread (codex round 2, F2 — replaces a same-sender burst
   * that raced its OWN cooldown, since a rate-limited attempt resolving early proved nothing).
   */
  it("a read granted before a held send commits does not count the in-flight message as read", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    // One message the reader has already seen, so the cursor starts above zero. Cleared after: the
    // held send below is from the SAME sender, and DMs share the per-sender comment cooldown.
    expect((await sendDm({ senderId: a.id, recipientId: b.id, content: "seen" })).outcome).toBe("inserted");
    expect(await markDmRead(b.id, a.id)).toBe(true);
    await clearRateWindow(a.id);

    const { agentLow, agentHigh } = canonicalPair(a.id, b.id);
    const { pRead, pSend, firstCount, secondCount } = await withHeldPairRow(agentLow, agentHigh, async () => {
      const read = markDmRead(b.id, a.id);
      const first = await waitForBlockedCount(1);
      const send = sendDm({ senderId: a.id, recipientId: b.id, content: "still in flight" });
      const second = await waitForBlockedCount(2);
      return { pRead: read, pSend: send, firstCount: first, secondCount: second };
    });
    expect(firstCount).toBeGreaterThanOrEqual(1);
    expect(secondCount).toBeGreaterThanOrEqual(2);

    const [readResult, sendResult] = await Promise.all([pRead, pSend]);
    expect(readResult).toBe(true);
    expect(sendResult.outcome).toBe("inserted");

    // The read's cursor predates the send's commit — the new message is excluded, not "stranded".
    expect(await countUnreadDms(b.id)).toBe(1);
  });
});

describe("F5 — block event payload names the real conversation, not the store-assigned marker", () => {
  it("dm.blocked's payload.conversation_id equals the row's own subject_id", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const event: PreparedEvent<"dm.blocked"> = {
      kind: "dm.blocked",
      actorAgentId: a.id,
      subjectType: "dm_conversation",
      subjectId: STORE_ASSIGNED_PAYLOAD_ID,
      secondarySubjectId: b.id,
      schoolId: null,
      payload: { conversation_id: STORE_ASSIGNED_PAYLOAD_ID, target_agent_id: b.id },
    };
    expect(await setDmBlock(a.id, b.id, true, [event])).toBe(true);

    const { rows } = await pgPool().query(
      `SELECT subject_id, payload FROM events WHERE kind = 'dm.blocked' AND actor_agent_id = $1 ORDER BY id DESC LIMIT 1`,
      [a.id]
    );
    const row = rows[0] as { subject_id: string; payload: { conversation_id: string } };
    expect(row.payload.conversation_id).toBe(row.subject_id);
    expect(row.payload.conversation_id).not.toBe(STORE_ASSIGNED_PAYLOAD_ID);
  });
});

function dmSentEvent(actorId: string, recipientId: string): PreparedEvent<"dm.sent"> {
  return {
    kind: "dm.sent",
    actorAgentId: actorId,
    subjectType: "dm_message",
    subjectId: STORE_ASSIGNED_PAYLOAD_ID,
    secondarySubjectId: recipientId,
    schoolId: null,
    payload: {
      conversation_id: STORE_ASSIGNED_PAYLOAD_ID,
      message_id: STORE_ASSIGNED_PAYLOAD_ID,
      seq: 0,
      recipient_agent_id: recipientId,
    },
  };
}

describe("F5 (round 3) — a database send emits a real dm.sent event", () => {
  it("stores the message id, conversation id, seq, and an ids-only payload", async () => {
    const a = await seedAgent();
    const b = await seedAgent();

    const result = await sendDm({ senderId: a.id, recipientId: b.id, content: "a real event" }, [dmSentEvent(a.id, b.id)]);
    expect(result.outcome).toBe("inserted");
    const message = result.message!;

    const { rows } = await pgPool().query(
      `SELECT subject_id, payload FROM events WHERE kind = 'dm.sent' AND actor_agent_id = $1 ORDER BY id DESC LIMIT 1`,
      [a.id]
    );
    const row = rows[0] as { subject_id: string; payload: Record<string, unknown> };
    expect(row.subject_id).toBe(message.id);
    expect(row.payload).toEqual({
      conversation_id: message.conversationId,
      message_id: message.id,
      seq: message.seq,
      recipient_agent_id: b.id,
    });
  });

  it("rolls back the message, quota claim, and seq bump when the event insert fails", async () => {
    const a = await seedAgent();
    const b = await seedAgent();

    await withEventFailure("dm.sent", async () => {
      await expect(
        sendDm({ senderId: a.id, recipientId: b.id, content: "should roll back" }, [dmSentEvent(a.id, b.id)])
      ).rejects.toThrow(/injected/);
    });

    const msgs = await pgPool().query(`SELECT id FROM dm_messages WHERE sender_agent_id = $1`, [a.id]);
    expect(msgs.rows).toHaveLength(0);
    const quota = await pgPool().query(`SELECT agent_id FROM agent_rate_limits WHERE agent_id = $1`, [a.id]);
    expect(quota.rows).toHaveLength(0);
    const { agentLow, agentHigh } = canonicalPair(a.id, b.id);
    const conv = await pgPool().query(`SELECT id FROM dm_conversations WHERE agent_low = $1 AND agent_high = $2`, [
      agentLow,
      agentHigh,
    ]);
    expect(conv.rows).toHaveLength(0);
  });
});

describe("F4 — a withdrawn sender is refused as sender_gone, never a 500", () => {
  it("a sender deleted before their first quota claim trips the FK, translated not thrown", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    expect(await deleteAgent(a.id)).toEqual({ ok: true });

    const result = await sendDm({ senderId: a.id, recipientId: b.id, content: "from the void" });
    expect(result).toEqual({ outcome: "sender_gone", message: null });
  });
});

describe("withdrawal leaves history intact, tombstoned", () => {
  /**
   * **`b` only RECEIVES, deliberately.** `agent_rate_limits.agent_id REFERENCES agents(id)` with
   * no cascade (`scripts/schema.sql`) and `deleteAgent` (`agents/db.ts`, outside this lane's
   * fence) never cleans that table — a pre-existing, cross-cutting gap shared with comments, not a
   * DM-specific FK, and DMs deliberately add none of their own (Decision 10). A `b` who also SENT
   * would claim an `agent_rate_limits` row and make its own withdrawal 23503 regardless of DMs;
   * receiving claims no such row, so this test isolates the property Decision 10 actually promises
   * — a DM-participant's withdrawal is never blocked by DM state itself.
   */
  it("the surviving participant still reads the conversation and its messages after the other withdraws", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    expect((await sendDm({ senderId: a.id, recipientId: b.id, content: "before withdrawal" })).outcome).toBe(
      "inserted"
    );

    expect(await deleteAgent(b.id)).toEqual({ ok: true });

    const conversations = await listDmConversations(a.id);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].other).toEqual({ id: b.id, name: null, deleted: true });

    const history = await listDmMessages(a.id, b.id, { limit: 10 });
    expect(history.map((m) => m.content)).toEqual(["before withdrawal"]);
  });
});
