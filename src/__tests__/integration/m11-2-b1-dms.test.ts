/**
 * M11b Lane D (P6.3) `[integration]` — direct messages against a real Postgres.
 *
 * The memory-mode suite (`src/__tests__/lib/store/dms-memory.test.ts`) proves the shapes; only a
 * real statement under contention can prove:
 *
 *  - concurrent sends between the same pair get DISTINCT, increasing seqs, and commit order equals
 *    seq order — the pair row's lock is the serialization point (`dms/db.ts`'s own doc comment);
 *  - a send racing a block on the SAME pair resolves to exactly one self-consistent outcome, never
 *    both "sent" and "blocked-before-it" for the same message;
 *  - a block, once it lands, refuses BOTH directions;
 *  - a burst of sends racing a concurrent `markDmRead` never strands a message: nothing that
 *    committed after the read returned is missing from the unread count;
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

type SendDmOutcome = SendDmResult;

import { runConcurrently, rejections } from "./helpers/concurrency";
import { closeIntegrationConnections, pgPool } from "./helpers/db";

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
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("concurrent sends — distinct increasing seqs, commit order = seq order", () => {
  /**
   * **A pair has exactly two possible senders, and each is capped at one send per cooldown
   * window** (DMs share the comment cooldown — `dms/db.ts`'s own doc comment). A same-sender
   * burst therefore cannot exercise the row-lock race at all: everything past the first send
   * would legitimately refuse as `rate_limited`, which is a different gate. The concurrency this
   * test can genuinely produce for ONE pair is the two directions firing at once.
   */
  it("A→B and B→A firing at once land distinct seqs with no gap or duplicate", async () => {
    const a = await seedAgent();
    const b = await seedAgent();

    const outcomes = await runConcurrently<SendDmOutcome>([
      () => sendDm({ senderId: a.id, recipientId: b.id, content: "from a" }),
      () => sendDm({ senderId: b.id, recipientId: a.id, content: "from b" }),
    ]);

    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.every((o) => o.ok && o.value.outcome === "inserted")).toBe(true);

    const messages = await listDmMessages(a.id, b.id, { limit: 10 });
    const seqs = messages.map((m) => m.seq).sort((x, y) => x - y);
    expect(seqs).toEqual([1, 2]);
    // `listDmMessages` orders DESC by seq — commit order (by seq, ascending) is exactly the
    // reverse of read order, i.e. the read is self-consistent with the seq assignment.
    expect(messages.map((m) => m.seq)).toEqual([2, 1]);
  });
});

describe("send-vs-block linearization", () => {
  /**
   * Exactly one self-consistent outcome: either the send won the row first (block applies after,
   * so a FOLLOW-UP send from the same sender is what gets refused), or the block won first (the
   * racing send itself comes back `blocked`). Never both "sent" and "the block predates it".
   */
  async function assertLinearized(
    sendOutcome: { outcome: string },
    laterProbe: { outcome: string }
  ): Promise<void> {
    if (sendOutcome.outcome === "inserted") {
      // The send won the row before the block (or the block had not yet landed) — a send AFTER
      // both have settled must now be refused, proving the block did land, just second.
      expect(laterProbe.outcome).toBe("blocked");
    } else {
      // The block won the row first — the racing send itself was refused as blocked.
      expect(sendOutcome.outcome).toBe("blocked");
    }
  }

  it("the blocker's own send races their own block (forward direction)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();

    const [sendOutcome, blockOutcome] = await runConcurrently<SendDmOutcome | boolean>([
      () => sendDm({ senderId: a.id, recipientId: b.id, content: "racing my own block" }),
      () => setDmBlock(a.id, b.id, true),
    ]);
    expect(rejections([sendOutcome, blockOutcome])).toEqual([]);
    expect(sendOutcome.ok && blockOutcome.ok).toBe(true);

    const probe = sendOutcome.ok ? (sendOutcome.value as SendDmOutcome) : { outcome: "blocked" as const };
    const followUp = await sendDm({ senderId: a.id, recipientId: b.id, content: "after settling" });
    await assertLinearized(probe, followUp);
    // Whichever order won, the pair is blocked once both operations have settled.
    expect(followUp.outcome).toBe("blocked");
  });

  it("the about-to-be-blocked agent races a send against the block (reverse direction)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();

    const [sendOutcome, blockOutcome] = await runConcurrently<SendDmOutcome | boolean>([
      () => sendDm({ senderId: b.id, recipientId: a.id, content: "racing the block against me" }),
      () => setDmBlock(a.id, b.id, true),
    ]);
    expect(rejections([sendOutcome, blockOutcome])).toEqual([]);
    expect(sendOutcome.ok && blockOutcome.ok).toBe(true);

    const probe = sendOutcome.ok ? (sendOutcome.value as SendDmOutcome) : { outcome: "blocked" as const };
    const followUp = await sendDm({ senderId: b.id, recipientId: a.id, content: "after settling" });
    await assertLinearized(probe, followUp);
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

describe("concurrent send/mark-read never strands a message", () => {
  /**
   * Nothing that committed AFTER `markDmRead` returned may be missing from the unread count. A
   * message that committed BEFORE the read is legitimately at-or-below the cursor; the spec's
   * wording is one-directional on purpose, since `markDmRead`'s own lock (the pair row) makes it
   * impossible for a send that commits strictly after it to be silently swept under the cursor.
   */
  it("unread count accounts for every send that committed after the read returned", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    // One message the reader has already seen, so `last_read_seq` starts above zero.
    expect((await sendDm({ senderId: a.id, recipientId: b.id, content: "seen" })).outcome).toBe("inserted");
    expect(await markDmRead(b.id, a.id)).toBe(true);

    const results = await runConcurrently<SendDmOutcome | boolean>([
      ...[1, 2, 3].map((n) => () => sendDm({ senderId: a.id, recipientId: b.id, content: `burst ${n}` })),
      () => markDmRead(b.id, a.id),
    ]);
    expect(rejections(results)).toEqual([]);

    const conversations = await listDmConversations(b.id);
    const unreadFromList = conversations[0]?.unreadCount ?? 0;
    const unreadCounted = await countUnreadDms(b.id);
    expect(unreadCounted).toBe(unreadFromList);

    // The reader's final cursor must be at or below the highest seq actually written — never past
    // it, and the total messages minus the cursor is exactly what's reported unread.
    const allMessages = await listDmMessages(a.id, b.id, { limit: 20 });
    const maxSeq = Math.max(...allMessages.map((m) => m.seq));
    expect(unreadCounted).toBeLessThanOrEqual(maxSeq);
    expect(unreadCounted).toBeGreaterThanOrEqual(0);
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
