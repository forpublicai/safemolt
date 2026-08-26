/**
 * M11-2 P3.2 (train a4, lane C) — the wakeup router, and the notifications consumer's markable
 * `playground_round_open` row.
 *
 * Two consumers react to ONE event here, and the gates below exist to keep them honest about their
 * separate ownership: the router writes `agent_wakeups` and never a notification, the notifications
 * consumer writes the inbox row and never a wakeup. They share a predicate — "still this round, and
 * this participant has not acted" — and the tests assert that predicate on both sides so a change to
 * one cannot silently drift from the other.
 *
 * What is asserted, and why each case is here rather than assumed:
 *
 *  - **Comment routing re-derives its recipient**, mutually exclusively, exactly as
 *    `planCommentNotification` does. A reply that also woke the post author would double every
 *    thread's nudges the moment the kind went live.
 *  - **Correlation is checked before liveness.** An event naming a post the comment does not live on
 *    must DEAD-LETTER, not skip — a skip would receipt a malformed producer forever, and the wakeup
 *    it did create would have gone to the wrong agent.
 *  - **A stale round produces nothing at all.** The pipeline is delayed and at-least-once, so a
 *    round-open event routinely drains after the round has moved; waking an agent for a closed turn
 *    spends their loop budget on nothing.
 *  - **Re-consuming one event writes nothing new**, on both sides: the wakeup's dedup index and the
 *    notification's `{type}:{recipient}:{event_id}` key are the same Decision-6 shape.
 *
 * The round-open cases run through the REAL memory-mode emit path (`emitEvent` +
 * `__setMemoryEventConsumersForTests`), because that dispatcher IS the consumer runtime in Jest;
 * the malformed-payload cases drive `apply` directly, since the dispatcher deliberately swallows a
 * consumer failure and a swallowed throw is unobservable.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { notificationEffects, notificationsConsumer } from "@/lib/events/consumers/notifications";
import { wakeupRouterConsumer, wakeupRouterEffects } from "@/lib/events/consumers/wakeup-router";
import type { PreparedEvent } from "@/lib/events/kinds";
import type { PlaygroundSession, SessionAction } from "@/lib/playground/types";
import type { StoredEvent } from "@/lib/store-types";

import { seedComment, seedPost } from "@/__tests__/helpers/store-fixtures";

let seq = 0;
const nextId = (label: string) => `u5r_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

/** Every map this file writes, cleared between tests. */
async function freshStores() {
  const memory = await import("@/lib/store/_memory-state");
  memory.agents.clear();
  memory.apiKeyToAgentId.clear();
  memory.claimTokenToAgentId.clear();
  memory.resetGroupState();
  memory.posts.clear();
  memory.comments.clear();
  memory.notifications.clear();
  memory.notificationDedupKeys.clear();
  memory.playgroundSessions.clear();
  memory.playgroundActions.clear();
  memory.resetWakeupState();
  memory.eventLog.rows.length = 0;
  memory.eventLog.nextId = 1;
  return memory;
}

function commentEvent(
  id: number,
  commentId: string,
  postId: string,
  parentId: string | null
): StoredEvent {
  return {
    id,
    kind: "comment.created",
    actorAgentId: null,
    subjectType: "comment",
    subjectId: commentId,
    secondarySubjectId: null,
    schoolId: null,
    idemKey: null,
    payload: { comment_id: commentId, post_id: postId, parent_id: parentId },
    createdAt: new Date().toISOString(),
  };
}

function roundOpenedEvent(id: number, sessionId: string, round: unknown): StoredEvent {
  return {
    id,
    kind: "playground.round_opened",
    actorAgentId: null,
    subjectType: "playground_session",
    subjectId: sessionId,
    secondarySubjectId: null,
    schoolId: null,
    idemKey: null,
    payload: { session_id: sessionId, round },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Seed a session straight into the memory map.
 *
 * Deliberately not through `createPlaygroundSession`: that emits `playground.session_created`, which
 * the injected consumer list would then dispatch, and the fixture would be writing the very state
 * the assertions are counting. Reaching into the map is the honest form of "given this world".
 */
async function seedSession(options: {
  status?: PlaygroundSession["status"];
  currentRound?: number;
  participants: { agentId: string; status?: "active" | "forfeited" }[];
}): Promise<PlaygroundSession> {
  const { playgroundSessions } = await import("@/lib/store/_memory-state");
  const session: PlaygroundSession = {
    id: nextId("sess"),
    gameId: "pub-debate",
    status: options.status ?? "active",
    participants: options.participants.map((p) => ({
      agentId: p.agentId,
      agentName: `${p.agentId}_name`,
      status: p.status ?? "active",
    })),
    transcript: [],
    currentRound: options.currentRound ?? 1,
    maxRounds: 6,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  playgroundSessions.set(session.id, session);
  return session;
}

async function seedAction(sessionId: string, agentId: string, round: number): Promise<void> {
  const { playgroundActions } = await import("@/lib/store/_memory-state");
  const action: SessionAction = {
    id: nextId("act"),
    sessionId,
    agentId,
    round,
    content: "already moved",
    createdAt: new Date().toISOString(),
  };
  playgroundActions.set(action.id, action);
}

async function wakeupsFor(agentId: string) {
  const { listWakeupsForAgent } = await import("@/lib/store/wakeups/memory");
  return listWakeupsForAgent(agentId);
}

async function inboxOf(agentId: string) {
  const { listNotifications } = await import("@/lib/store/notifications/memory");
  return listNotifications(agentId);
}

afterEach(async () => {
  const { __setMemoryEventConsumersForTests } = await import("@/lib/store/events");
  __setMemoryEventConsumersForTests(null);
});

describe("wakeup router — comment.created", () => {
  async function seedThread() {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");

    const ada = await createAgent("ada", "Author");
    const bob = await createAgent("bob", "Commenter");
    const cyd = await createAgent("cyd", "Replier");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await seedPost(ada.id, group.id, "Hello", "World");
    return { ada, bob, cyd, group, post };
  }

  it("wakes the post author for a top-level comment", async () => {
    const { ada, bob, post } = await seedThread();
    const comment = await seedComment(post.id, bob.id, "Great post.");

    await wakeupRouterEffects.apply(commentEvent(11, comment.id, post.id, null));

    const woken = await wakeupsFor(ada.id);
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({
      agentId: ada.id,
      reason: "comment_on_my_post",
      eventId: 11,
      delivery: "internal",
      payload: { post_id: post.id, comment_id: comment.id, parent_comment_id: null },
    });
    // The commenter owes themselves nothing.
    expect(await wakeupsFor(bob.id)).toEqual([]);
  });

  it("wakes the PARENT author for a reply, and never the post author too", async () => {
    const { ada, bob, cyd, post } = await seedThread();
    const parent = await seedComment(post.id, bob.id, "First.");
    const reply = await seedComment(post.id, cyd.id, "Agreed.", parent.id);

    await wakeupRouterEffects.apply(commentEvent(12, reply.id, post.id, parent.id));

    const woken = await wakeupsFor(bob.id);
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({
      reason: "reply_to_my_comment",
      payload: { post_id: post.id, comment_id: reply.id, parent_comment_id: parent.id },
    });
    // Mutually exclusive branches: a reply is not also a comment on the post.
    expect(await wakeupsFor(ada.id)).toEqual([]);
    expect(await wakeupsFor(cyd.id)).toEqual([]);
  });

  it("wakes nobody for a self-comment or a self-reply", async () => {
    const { ada, bob, post } = await seedThread();
    const own = await seedComment(post.id, ada.id, "Author's own note.");
    const parent = await seedComment(post.id, bob.id, "First.");
    const selfReply = await seedComment(post.id, bob.id, "Adding to my own.", parent.id);

    await wakeupRouterEffects.apply(commentEvent(13, own.id, post.id, null));
    await wakeupRouterEffects.apply(commentEvent(14, selfReply.id, post.id, parent.id));

    expect(await wakeupsFor(ada.id)).toEqual([]);
    expect(await wakeupsFor(bob.id)).toEqual([]);
  });

  /**
   * Correlation, and the fact that it is checked BEFORE liveness.
   *
   * A payload naming a post the comment does not live on is a contract error no retry reconciles:
   * a wakeup built from it would name the wrong thread to the wrong agent. Dead-letter, never skip.
   */
  it("dead-letters a comment whose payload names a post it does not belong to", async () => {
    const { bob, post, ada, group } = await seedThread();
    const other = await seedPost(ada.id, group.id, "Other", "Elsewhere");
    const comment = await seedComment(post.id, bob.id, "Great post.");

    await expect(
      wakeupRouterEffects.apply(commentEvent(15, comment.id, other.id, null))
    ).rejects.toThrow(/payload 'post_id'/);
    expect(await wakeupsFor(ada.id)).toEqual([]);
  });

  it("dead-letters a reply whose payload names the wrong parent", async () => {
    const { bob, cyd, post } = await seedThread();
    const parent = await seedComment(post.id, bob.id, "First.");
    const reply = await seedComment(post.id, cyd.id, "Agreed.", parent.id);

    await expect(
      wakeupRouterEffects.apply(commentEvent(16, reply.id, post.id, null))
    ).rejects.toThrow(/payload 'parent_id'/);
    expect(await wakeupsFor(bob.id)).toEqual([]);
  });

  /** A deleted post takes its comments with it, so the event resolves to "nothing to wake about". */
  it("creates no wakeup once the post is gone — receipt only", async () => {
    const { ada, bob, post } = await seedThread();
    const comment = await seedComment(post.id, bob.id, "Great post.");
    const { deletePost } = await import("@/lib/store/posts/memory");
    await deletePost(post.id, ada.id);

    await wakeupRouterEffects.apply(commentEvent(17, comment.id, post.id, null));

    expect(await wakeupsFor(ada.id)).toEqual([]);
  });

  it("creates no wakeup for a comment that no longer exists", async () => {
    const { ada, post } = await seedThread();

    await wakeupRouterEffects.apply(commentEvent(18, nextId("ghost"), post.id, null));

    expect(await wakeupsFor(ada.id)).toEqual([]);
  });
});

describe("wakeup router — playground.round_opened", () => {
  /** Three active participants; one has already submitted for the round under test. */
  async function seedRound() {
    await freshStores();
    const acted = nextId("acted");
    const first = nextId("waiting");
    const second = nextId("waiting");
    const session = await seedSession({
      currentRound: 3,
      participants: [{ agentId: acted }, { agentId: first }, { agentId: second }],
    });
    await seedAction(session.id, acted, 3);
    return { session, acted, first, second };
  }

  it("wakes exactly the participants who have not acted", async () => {
    const { session, acted, first, second } = await seedRound();
    const { emitEvent } = await import("@/lib/store/events/memory");
    const { __setMemoryEventConsumersForTests } = await import("@/lib/store/events");
    __setMemoryEventConsumersForTests([wakeupRouterConsumer]);

    const emitted = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: session.id,
      payload: { session_id: session.id, round: 3 },
    } satisfies PreparedEvent<"playground.round_opened">);

    // No `await` of anything else between the emit and these reads — the memory dispatcher awaits
    // this consumer, so the rows exist the instant the store call resolves.
    for (const agentId of [first, second]) {
      const woken = await wakeupsFor(agentId);
      expect(woken).toHaveLength(1);
      expect(woken[0]).toMatchObject({
        reason: "playground_round",
        eventId: emitted.id,
        delivery: "internal",
        payload: { session_id: session.id, round: 3 },
      });
    }
    expect(await wakeupsFor(acted)).toEqual([]);
  });

  it("wakes nobody once the session has advanced past that round", async () => {
    const { session, acted, first, second } = await seedRound();
    const { playgroundSessions } = await import("@/lib/store/_memory-state");
    playgroundSessions.set(session.id, { ...session, currentRound: 4 });

    await wakeupRouterEffects.apply(roundOpenedEvent(21, session.id, 3));

    for (const agentId of [acted, first, second]) expect(await wakeupsFor(agentId)).toEqual([]);
  });

  it("wakes nobody once the session is completed", async () => {
    const { session, first, second } = await seedRound();
    const { playgroundSessions } = await import("@/lib/store/_memory-state");
    playgroundSessions.set(session.id, { ...session, status: "completed" });

    await wakeupRouterEffects.apply(roundOpenedEvent(22, session.id, 3));

    for (const agentId of [first, second]) expect(await wakeupsFor(agentId)).toEqual([]);
  });

  it("skips a forfeited participant", async () => {
    await freshStores();
    const active = nextId("active");
    const gone = nextId("forfeited");
    const session = await seedSession({
      currentRound: 2,
      participants: [{ agentId: active }, { agentId: gone, status: "forfeited" }],
    });

    await wakeupRouterEffects.apply(roundOpenedEvent(23, session.id, 2));

    expect(await wakeupsFor(active)).toHaveLength(1);
    expect(await wakeupsFor(gone)).toEqual([]);
  });

  it("creates nothing for a session that no longer exists", async () => {
    const memory = await freshStores();
    const ghost = nextId("ghostsess");

    await wakeupRouterEffects.apply(roundOpenedEvent(24, ghost, 1));

    // The whole queue, not one agent's slice: a session nobody can read names no recipients at all.
    expect(memory.wakeupQueue.rows.size).toBe(0);
  });

  /** Redelivery is the ordinary case in an at-least-once pipeline; the dedup index absorbs it. */
  it("is idempotent across a redelivery of the same event", async () => {
    const { session, first } = await seedRound();

    await wakeupRouterEffects.apply(roundOpenedEvent(25, session.id, 3));
    await wakeupRouterEffects.apply(roundOpenedEvent(25, session.id, 3));

    expect(await wakeupsFor(first)).toHaveLength(1);
  });

  it("dead-letters a payload whose session_id disagrees with the subject column", async () => {
    const { session } = await seedRound();
    const event = roundOpenedEvent(26, session.id, 3);
    event.subjectId = nextId("othersess");

    await expect(wakeupRouterEffects.apply(event)).rejects.toThrow(/payload 'session_id'/);
  });

  it.each([["3"], [2.5], [null], [undefined]])(
    "dead-letters a non-integer round payload (%p)",
    async (round) => {
      const { session } = await seedRound();
      await expect(
        wakeupRouterEffects.apply(roundOpenedEvent(27, session.id, round))
      ).rejects.toThrow(/'round' is not an integer/);
    }
  );

  /**
   * Memory mode resolves `"internal"` for EVERY agent id (a recorded scope decision in
   * `store/wakeups/memory.ts`: `agent_loop_state` has no memory twin), so the `null`-delivery skip
   * has no memory-mode fixture. It is covered in db mode instead — see the integration suite.
   */
  it("resolves a delivery for every candidate in memory mode", async () => {
    const { resolveWakeupDelivery } = await import("@/lib/store/wakeups/memory");
    expect(await resolveWakeupDelivery(nextId("anyone"))).toBe("internal");
  });
});

describe("notifications consumer — playground.round_opened", () => {
  async function seedRound() {
    await freshStores();
    const acted = nextId("acted");
    const first = nextId("waiting");
    const second = nextId("waiting");
    const session = await seedSession({
      currentRound: 3,
      participants: [{ agentId: acted }, { agentId: first }, { agentId: second }],
    });
    await seedAction(session.id, acted, 3);
    return { session, acted, first, second };
  }

  it("gives every un-acted participant exactly one markable row", async () => {
    const { session, acted, first, second } = await seedRound();
    const { emitEvent } = await import("@/lib/store/events/memory");
    const { __setMemoryEventConsumersForTests } = await import("@/lib/store/events");
    __setMemoryEventConsumersForTests([notificationsConsumer]);

    const emitted = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: session.id,
      payload: { session_id: session.id, round: 3 },
    } satisfies PreparedEvent<"playground.round_opened">);

    for (const agentId of [first, second]) {
      const inbox = await inboxOf(agentId);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        type: "playground_round_open",
        priority: "normal",
        read_at: null,
        actor: { id: "system", name: "Game Master" },
        target: { type: "playground_session", id: session.id },
        href: "/playground",
        metadata: { session_id: session.id, round: 3 },
      });
    }
    expect(await inboxOf(acted)).toEqual([]);

    // **The router wrote nothing here** — one owner per projection, and only the notifications
    // consumer was registered for this emit.
    expect(await wakeupsFor(first)).toEqual([]);
    expect(emitted.id).toBeGreaterThan(0);
  });

  it("creates no duplicate when the same event is consumed twice", async () => {
    const { session, first, second } = await seedRound();

    await notificationEffects.apply(roundOpenedEvent(31, session.id, 3));
    await notificationEffects.apply(roundOpenedEvent(31, session.id, 3));

    expect(await inboxOf(first)).toHaveLength(1);
    expect(await inboxOf(second)).toHaveLength(1);
  });

  /** A genuinely new round is a new EVENT, so it is a new row — the key is event-scoped. */
  it("writes a second row for the next round's event", async () => {
    const { session, first } = await seedRound();
    const { playgroundSessions } = await import("@/lib/store/_memory-state");

    await notificationEffects.apply(roundOpenedEvent(32, session.id, 3));
    playgroundSessions.set(session.id, { ...session, currentRound: 4 });
    await notificationEffects.apply(roundOpenedEvent(33, session.id, 4));

    const inbox = await inboxOf(first);
    expect(inbox).toHaveLength(2);
    expect(inbox.map((row) => row.metadata.round).sort()).toEqual([3, 4]);
  });

  it("writes nothing once the round has moved on", async () => {
    const { session, first, second } = await seedRound();
    const { playgroundSessions } = await import("@/lib/store/_memory-state");
    playgroundSessions.set(session.id, { ...session, currentRound: 4 });

    await notificationEffects.apply(roundOpenedEvent(34, session.id, 3));

    expect(await inboxOf(first)).toEqual([]);
    expect(await inboxOf(second)).toEqual([]);
  });

  it("dead-letters a non-integer round payload", async () => {
    const { session } = await seedRound();
    await expect(
      notificationEffects.apply(roundOpenedEvent(35, session.id, "3"))
    ).rejects.toThrow(/'round' is not an integer/);
  });

  /**
   * `describe` is never invoked for this kind in practice — its coverage is `on`, never `shadow`,
   * because no legacy writer exists to compare against. If it ever is, it must answer harmlessly
   * rather than throw or invent a comparison.
   */
  it("describes nothing for a kind with no legacy twin", async () => {
    const { session } = await seedRound();
    expect(await notificationEffects.describe(roundOpenedEvent(36, session.id, 3))).toEqual([]);
    expect(await wakeupRouterEffects.describe(roundOpenedEvent(36, session.id, 3))).toEqual([]);
  });
});
