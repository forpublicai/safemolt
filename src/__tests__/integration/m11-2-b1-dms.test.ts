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
});

describe("concurrent sends — a real held-lock barrier, seq order = actual commit order", () => {
  /**
   * **A pair has exactly two possible senders, and each is capped at one send per cooldown
   * window** (DMs share the comment cooldown), so the only genuine two-writer race for one pair
   * is the two directions firing at once. The barrier holds the pair row on a dedicated `pg`
   * session, confirms BOTH sends are genuinely queued behind it (not merely racing in wall-clock
   * time), then releases — whichever promise resolves first in JS cannot be reordered relative to
   * the DB, because the second session's statement cannot even begin executing until the first
   * commits and releases the row (codex round 2, F2).
   */
  it("two different senders overlapping both succeed, and seq order matches actual resolution order", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const { agentLow, agentHigh } = canonicalPair(a.id, b.id);
    const conversationId = await seedConversation(a.id, b.id);

    const resolveOrder: string[] = [];
    const blocked = await withHeldPairRow(agentLow, agentHigh, async () => {
      const pA = sendDm({ senderId: a.id, recipientId: b.id, content: "from a" }).then((r) => {
        resolveOrder.push("a");
        return r;
      });
      const pB = sendDm({ senderId: b.id, recipientId: a.id, content: "from b" }).then((r) => {
        resolveOrder.push("b");
        return r;
      });
      const count = await waitForBlockedCount(2);
      return { count, pA, pB };
    });
    expect(blocked.count).toBeGreaterThanOrEqual(2);

    const [rA, rB] = await Promise.all([blocked.pA, blocked.pB]);
    expect(rA.outcome).toBe("inserted");
    expect(rB.outcome).toBe("inserted");

    // Read seq assignment straight from the row, keyed by SENDER — not sorted — and compare
    // against the order the promises actually resolved in.
    const { rows } = await pgPool().query<{ sender_agent_id: string; seq: number }>(
      `SELECT sender_agent_id, seq FROM dm_messages WHERE conversation_id = $1 ORDER BY seq ASC`,
      [conversationId]
    );
    expect(rows.map((r) => (r.sender_agent_id === a.id ? "a" : "b"))).toEqual(resolveOrder);
  });
});

describe("send-vs-block linearization — a real held-lock barrier", () => {
  /**
   * Exactly one self-consistent outcome: either the send won the row first (block applies after,
   * so a FOLLOW-UP send from the same sender is what gets refused), or the block won first (the
   * racing send itself comes back `blocked`). The barrier proves both operations were genuinely
   * queued on the SAME row before either runs, so the branch taken below reflects the real winner
   * rather than whichever call happened to be scheduled first in JS.
   */
  async function raceSendAgainstBlock(
    sendArgs: Parameters<typeof sendDm>[0],
    blockerId: string,
    targetId: string
  ): Promise<{ resolveOrder: string[]; sendOutcome: SendDmOutcome; blockChanged: boolean }> {
    const { agentLow, agentHigh } = canonicalPair(sendArgs.senderId, sendArgs.recipientId);
    // The pair row must exist before a raw connection can lock it.
    await seedConversation(sendArgs.senderId, sendArgs.recipientId);

    const resolveOrder: string[] = [];
    const { count, pSend, pBlock } = await withHeldPairRow(agentLow, agentHigh, async () => {
      const send = sendDm(sendArgs).then((r) => {
        resolveOrder.push("send");
        return r;
      });
      const block = setDmBlock(blockerId, targetId, true).then((r) => {
        resolveOrder.push("block");
        return r;
      });
      return { count: await waitForBlockedCount(2), pSend: send, pBlock: block };
    });
    expect(count).toBeGreaterThanOrEqual(2);

    const [sendOutcome, blockChanged] = await Promise.all([pSend, pBlock]);
    return { resolveOrder, sendOutcome, blockChanged };
  }

  it("the blocker's own send races their own block (forward direction)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();

    const { resolveOrder, sendOutcome, blockChanged } = await raceSendAgainstBlock(
      { senderId: a.id, recipientId: b.id, content: "racing my own block" },
      a.id,
      b.id
    );
    expect(blockChanged).toBe(true);

    if (resolveOrder[0] === "send") {
      // The send's statement was granted the lock first, so `not_blocked` still saw no flag set.
      expect(sendOutcome.outcome).toBe("inserted");
    } else {
      // The block was granted first, so the send's own `not_blocked` CTE already saw it.
      expect(sendOutcome.outcome).toBe("blocked");
    }
    // Whichever order won, the pair is blocked once both operations have settled.
    const followUp = await sendDm({ senderId: a.id, recipientId: b.id, content: "after settling" });
    expect(followUp.outcome).toBe("blocked");
  });

  it("the about-to-be-blocked agent races a send against the block (reverse direction)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();

    const { resolveOrder, sendOutcome, blockChanged } = await raceSendAgainstBlock(
      { senderId: b.id, recipientId: a.id, content: "racing the block against me" },
      a.id,
      b.id
    );
    expect(blockChanged).toBe(true);

    if (resolveOrder[0] === "send") {
      expect(sendOutcome.outcome).toBe("inserted");
    } else {
      expect(sendOutcome.outcome).toBe("blocked");
    }
    const followUp = await sendDm({ senderId: b.id, recipientId: a.id, content: "after settling" });
    expect(followUp.outcome).toBe("blocked");
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
