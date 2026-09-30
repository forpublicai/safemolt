/**
 * M11-2 u2 — the memory-mode dispatcher (Decision 6) and the notification recipient rules.
 *
 * Memory mode has no worker and no cron, so this in-process dispatcher IS the consumer runtime for
 * the pinned Jest/local path. Three properties are asserted here because nothing else can hold
 * them: a consumer failure never reaches the producer, the two projection consumers have written by
 * the time the store call resolves, and ingest has NOT been waited for.
 *
 * The checked-in manifests put every a1 kind at `legacy` or `none` in u2 (no producer emits yet), so
 * the effects are reached by injecting a registry whose manifests are forced `on` — the same shape
 * the u3 flip will ship, one deploy early and only inside this file.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { notificationEffects } from "@/lib/events/consumers/notifications";
import { activityTrailEffects } from "@/lib/events/consumers/activity-trail";
import { defineConsumer, type RegisteredConsumer } from "@/lib/events/consumers/dispatch";
import type { CoverageManifest, CoverageState } from "@/lib/events/consumers/coverage";
import { EVENT_KINDS, type EventKind, type PreparedEvent } from "@/lib/events/kinds";
import type { StoredEvent } from "@/lib/store-types";

import { seedComment, seedPost } from "@/__tests__/helpers/store-fixtures";

/** A manifest with every kind at `none` except the named ones, which are `on`. */
function manifestWith(state: CoverageState, kinds: EventKind[]): CoverageManifest {
  const manifest = Object.fromEntries(EVENT_KINDS.map((kind) => [kind, "none"])) as CoverageManifest;
  for (const kind of kinds) manifest[kind] = state;
  return manifest;
}

const A1_EFFECT_KINDS: EventKind[] = ["post.created", "post.deleted", "comment.created", "agent.followed"];

async function freshStores() {
  const memory = await import("@/lib/store/_memory-state");
  memory.activityEvents.clear();
  memory.activityEventSourceIds.clear();
  memory.agents.clear();
  memory.apiKeyToAgentId.clear();
  memory.claimTokenToAgentId.clear();
  memory.resetGroupState();
  memory.posts.clear();
  memory.comments.clear();
  memory.following.clear();
  memory.notifications.clear();
  memory.notificationDedupKeys.clear();
  memory.eventLog.rows.length = 0;
  memory.eventLog.nextId = 1;
  return memory;
}

describe("memory-mode dispatcher", () => {
  afterEach(async () => {
    const { __setMemoryEventConsumersForTests } = await import("@/lib/store/events");
    __setMemoryEventConsumersForTests(null);
  });

  it("swallows a consumer failure and leaves the append result unchanged", async () => {
    await freshStores();
    const { emitEvent } = await import("@/lib/store/events/memory");
    const { __setMemoryEventConsumersForTests } = await import("@/lib/store/events");
    const { eventLog } = await import("@/lib/store/_memory-state");

    const exploding: RegisteredConsumer = {
      name: "exploding",
      coverage: manifestWith("on", ["post.created"]),
      memoryModeDelivery: "await",
      handleEvent: async () => {
        throw new Error("projection unavailable");
      },
    };
    __setMemoryEventConsumersForTests([exploding]);
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});

    // The producer's result is the assertion: db mode decouples a consumer failure from its
    // producer, and memory mode must not be the one place a bad projection 500s a good comment.
    const emitted = await emitEvent({
      kind: "post.created",
      payload: { post_id: "p1", group_id: "g1", author_id: "a1" },
    } satisfies PreparedEvent<"post.created">);

    expect(emitted.id).toBe(1);
    expect(eventLog.rows).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("awaits the projection consumers and only schedules the ingest one", async () => {
    await freshStores();
    const { emitEvent } = await import("@/lib/store/events/memory");
    const { __setMemoryEventConsumersForTests } = await import("@/lib/store/events");

    const order: string[] = [];
    let releaseIngest = () => {};
    const ingestFinished = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });

    const projection: RegisteredConsumer = {
      name: "projection",
      coverage: manifestWith("on", ["post.created"]),
      memoryModeDelivery: "await",
      handleEvent: async () => {
        order.push("projection");
      },
    };
    const ingest: RegisteredConsumer = {
      name: "ingest",
      coverage: manifestWith("on", ["post.created"]),
      memoryModeDelivery: "background",
      handleEvent: async () => {
        await ingestFinished;
        order.push("ingest");
      },
    };
    __setMemoryEventConsumersForTests([projection, ingest]);

    await emitEvent({
      kind: "post.created",
      payload: { post_id: "p1", group_id: "g1", author_id: "a1" },
    } satisfies PreparedEvent<"post.created">);
    order.push("emit-resolved");

    // The whole point: the store call returned while the background consumer was still blocked.
    // Awaiting ingest inline would turn a local no-DB post into a wait on an external vector
    // service, for up to 2,000 recipients, one at a time.
    expect(order).toEqual(["projection", "emit-resolved"]);

    releaseIngest();
    await ingestFinished;
    // One more turn of the loop for the background consumer's own continuation.
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["projection", "emit-resolved", "ingest"]);
  });

  /**
   * The Decision-6 guarantee tests depend on: a notification and a trail row exist the instant the
   * emitting store call resolves, exactly as today's inline writers provide.
   */
  it("makes the notification and activity projections visible when emitEvent resolves", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { listNotifications, __resetNotificationsForTests } = await import(
      "@/lib/store/notifications/memory"
    );
    const { listActivityEvents } = await import("@/lib/store/activity/events");
    const { emitEvent } = await import("@/lib/store/events/memory");
    const { __setMemoryEventConsumersForTests } = await import("@/lib/store/events");

    const ada = await createAgent("ada", "Author");
    const bob = await createAgent("bob", "Commenter");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await seedPost(ada.id, group.id, "Hello", "World");
    const comment = await seedComment(post.id, bob.id, "Great post.");

    // The legacy inline writers already produced both projections during the fixture writes. Clear
    // them so what remains afterwards can only have come from the consumer.
    __resetNotificationsForTests();
    const { activityEvents } = await import("@/lib/store/_memory-state");
    activityEvents.clear();

    __setMemoryEventConsumersForTests([
      defineConsumer({
        name: "notifications",
        coverage: manifestWith("on", A1_EFFECT_KINDS),
        effects: notificationEffects,
        memoryModeDelivery: "await",
      }),
      defineConsumer({
        name: "activity-trail",
        coverage: manifestWith("on", A1_EFFECT_KINDS),
        effects: activityTrailEffects,
        memoryModeDelivery: "await",
      }),
    ]);

    await emitEvent({
      kind: "comment.created",
      actorAgentId: bob.id,
      subjectType: "comment",
      subjectId: comment.id,
      payload: { comment_id: comment.id, post_id: post.id, parent_id: null },
    } satisfies PreparedEvent<"comment.created">);

    // No `await` of anything else between the emit and these reads — that is the assertion.
    const inbox = await listNotifications(ada.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("comment_on_my_post");
    expect(inbox[0].actor.id).toBe(bob.id);

    const trail = await listActivityEvents({ types: ["comment"] });
    expect(trail.map((item) => item.id)).toEqual([comment.id]);
  });

  it("refuses to write a projection for a subject that is already gone", async () => {
    const memory = await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { listActivityEvents } = await import("@/lib/store/activity/events");

    const ada = await createAgent("ada", "Author");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await seedPost(ada.id, group.id, "Hello", "World");
    memory.activityEvents.clear();

    const { deletePost } = await import("@/lib/store/posts/memory");
    await deletePost(post.id, ada.id);

    await activityTrailEffects.apply({
      id: 42,
      kind: "post.created",
      actorAgentId: ada.id,
      subjectType: "post",
      subjectId: post.id,
      secondarySubjectId: null,
      schoolId: null,
      idemKey: null,
      payload: { post_id: post.id, group_id: group.id, author_id: ada.id },
      createdAt: new Date().toISOString(),
    } satisfies StoredEvent);

    // Delete-then-create convergence: the deleted post never reappears on the trail.
    expect(await listActivityEvents({ types: ["post"] })).toEqual([]);
  });
});

/**
 * Recipient derivation, tested by direct invocation because no producer emits yet.
 *
 * The rule under test is that the consumer matches TODAY'S inline writer exactly — a top-level
 * comment notifies the post author, a reply notifies the parent comment's author, and neither
 * notifies the commenter. Any divergence here makes every shadow comparison for that kind a
 * mismatch and doubles (or drops) notifications the moment the kind flips to `on`.
 */
describe("notification recipients", () => {
  function commentEvent(id: number, commentId: string, postId: string, parentId: string | null): StoredEvent {
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

  it("notifies the post author, the parent author, and never the commenter", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { listNotifications, __resetNotificationsForTests } = await import(
      "@/lib/store/notifications/memory"
    );

    const ada = await createAgent("ada", "Author");
    const bob = await createAgent("bob", "Commenter");
    const cyd = await createAgent("cyd", "Replier");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await seedPost(ada.id, group.id, "Hello", "World");
    const topLevel = await seedComment(post.id, bob.id, "Great post.");
    const selfComment = await seedComment(post.id, ada.id, "Author's own note.");
    const reply = await seedComment(post.id, cyd.id, "Agreed.", topLevel.id);
    const selfReply = await seedComment(post.id, bob.id, "Adding to my own.", topLevel.id);
    __resetNotificationsForTests();

    await notificationEffects.apply(commentEvent(11, topLevel.id, post.id, null));
    await notificationEffects.apply(commentEvent(12, selfComment.id, post.id, null));
    await notificationEffects.apply(commentEvent(13, reply.id, post.id, topLevel.id));
    await notificationEffects.apply(commentEvent(14, selfReply.id, post.id, topLevel.id));

    const adasInbox = await listNotifications(ada.id);
    // One row: the top-level comment by bob. The author's own comment self-notifies nobody, and a
    // REPLY never notifies the post author — the inline batch picks one element, not both.
    expect(adasInbox.map((row) => row.type)).toEqual(["comment_on_my_post"]);

    const bobsInbox = await listNotifications(bob.id);
    // cyd's reply reaches bob; bob's own reply to his own comment does not.
    expect(bobsInbox.map((row) => row.type)).toEqual(["reply_to_my_comment"]);
    expect(bobsInbox[0].metadata).toMatchObject({ post_id: post.id, parent_comment_id: topLevel.id });

    expect(await listNotifications(cyd.id)).toEqual([]);
  });

  it("keys the dedup on type, recipient and event, so two effects never collide", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { listNotifications, __resetNotificationsForTests } = await import(
      "@/lib/store/notifications/memory"
    );

    const ada = await createAgent("ada", "Author");
    const bob = await createAgent("bob", "Commenter");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await seedPost(ada.id, group.id, "Hello", "World");
    const first = await seedComment(post.id, bob.id, "One.");
    const second = await seedComment(post.id, bob.id, "Two.");
    __resetNotificationsForTests();

    // Two distinct events => two rows with distinct keys: a repeat comment by the same actor on the
    // same post IS a new notification (the key is event-scoped, not content-scoped).
    await notificationEffects.apply(commentEvent(21, first.id, post.id, null));
    await notificationEffects.apply(commentEvent(22, second.id, post.id, null));
    expect(await listNotifications(ada.id)).toHaveLength(2);

    const shadow = [
      ...(await notificationEffects.describe(commentEvent(21, first.id, post.id, null))),
      ...(await notificationEffects.describe(commentEvent(22, second.id, post.id, null))),
    ];
    expect(shadow.map((effect) => effect.key)).toEqual([
      `comment_on_my_post:${ada.id}:21`,
      `comment_on_my_post:${ada.id}:22`,
    ]);

    // Re-consuming one event is NOT: at-least-once delivery means this happens routinely.
    await notificationEffects.apply(commentEvent(21, first.id, post.id, null));
    expect(await listNotifications(ada.id)).toHaveLength(2);
  });

  /**
   * A malformed reply event must DEAD-LETTER, never quietly become a top-level comment.
   *
   * `parent_id` is required-nullable: `null` means "top level" and routes the notification to the
   * POST's author. Reading a missing or empty field as `null` would take a broken reply event and
   * notify the wrong agent, forever, with nothing raised anywhere.
   */
  it("dead-letters a comment event whose parent_id is missing or empty", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { listNotifications, __resetNotificationsForTests } = await import(
      "@/lib/store/notifications/memory"
    );
    const { PermanentEffectError } = await import("@/lib/events/errors");

    const ada = await createAgent("ada", "Author");
    const bob = await createAgent("bob", "Commenter");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await seedPost(ada.id, group.id, "Hello", "World");
    const comment = await seedComment(post.id, bob.id, "Great post.");
    __resetNotificationsForTests();

    const malformed = (payload: Record<string, unknown>): StoredEvent => ({
      id: 41,
      kind: "comment.created",
      actorAgentId: null,
      subjectType: "comment",
      subjectId: comment.id,
      secondarySubjectId: null,
      schoolId: null,
      idemKey: null,
      payload,
      createdAt: new Date().toISOString(),
    });

    await expect(
      notificationEffects.apply(malformed({ comment_id: comment.id, post_id: post.id }))
    ).rejects.toBeInstanceOf(PermanentEffectError);
    await expect(
      notificationEffects.apply(
        malformed({ comment_id: comment.id, post_id: post.id, parent_id: "" })
      )
    ).rejects.toBeInstanceOf(PermanentEffectError);

    // Neither malformed event silently produced a notification for the post author.
    expect(await listNotifications(ada.id)).toEqual([]);
  });

  /**
   * A live subject is not a CORRELATED subject.
   *
   * Every read succeeds here — the comment exists, the post exists — and the payload still names a
   * post the comment does not live on, or a parent it does not have. Trusting it would notify the
   * wrong post's author, and (in the ingest consumer) fan the comment out to the wrong audience
   * under the wrong title. Two ids that disagree cannot be reconciled by a retry, so this
   * dead-letters rather than skipping silently.
   */
  it("dead-letters a comment event whose payload names another post or the wrong parent", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { listNotifications, __resetNotificationsForTests } = await import(
      "@/lib/store/notifications/memory"
    );
    const { activityTrailEffects } = await import("@/lib/events/consumers/activity-trail");
    const { memoryIngestEffects } = await import("@/lib/events/consumers/memory-ingest");
    const { PermanentEffectError } = await import("@/lib/events/errors");

    const ada = await createAgent("ada", "Author");
    const bob = await createAgent("bob", "Commenter");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await seedPost(ada.id, group.id, "Hello", "World");
    const otherPost = await seedPost(ada.id, group.id, "Elsewhere", "Another body");
    const comment = await seedComment(post.id, bob.id, "Great post.");
    const parent = await seedComment(post.id, ada.id, "A parent comment.");
    __resetNotificationsForTests();

    const event = (payload: Record<string, unknown>): StoredEvent => ({
      id: 61,
      kind: "comment.created",
      actorAgentId: bob.id,
      subjectType: "comment",
      subjectId: comment.id,
      secondarySubjectId: null,
      schoolId: null,
      idemKey: null,
      payload,
      createdAt: new Date().toISOString(),
    });

    // The comment lives on `post`, but the payload says `otherPost`.
    const crossPost = event({ comment_id: comment.id, post_id: otherPost.id, parent_id: null });
    // The comment is top level, but the payload claims a parent.
    const wrongParent = event({ comment_id: comment.id, post_id: post.id, parent_id: parent.id });

    for (const effects of [notificationEffects, activityTrailEffects, memoryIngestEffects]) {
      await expect(effects.apply(crossPost)).rejects.toBeInstanceOf(PermanentEffectError);
      await expect(effects.apply(wrongParent)).rejects.toBeInstanceOf(PermanentEffectError);
    }

    // **And the correlation is checked BEFORE liveness**, so deleting the wrongly-named post does
    // not turn the contract error into a silent skip. Checking liveness first would hide exactly the
    // malformed producer this refusal exists to surface — and hide it only sometimes, depending on
    // whether the post it wrongly named happened to be deleted.
    const { deletePost } = await import("@/lib/store/posts/memory");
    await deletePost(otherPost.id, ada.id);
    for (const effects of [notificationEffects, activityTrailEffects, memoryIngestEffects]) {
      await expect(effects.apply(crossPost)).rejects.toBeInstanceOf(PermanentEffectError);
    }

    // Nothing was written for either post's author on the way to those refusals.
    expect(await listNotifications(ada.id)).toEqual([]);
  });

  it("refuses an empty id inside post.deleted's audiences", async () => {
    const { memoryIngestEffects } = await import("@/lib/events/consumers/memory-ingest");
    const { PermanentEffectError } = await import("@/lib/events/errors");
    await expect(
      memoryIngestEffects.apply({
        id: 51,
        kind: "post.deleted",
        actorAgentId: null,
        subjectType: "post",
        subjectId: "p1",
        secondarySubjectId: null,
        schoolId: null,
        idemKey: null,
        payload: {
          post_id: "p1",
          group_id: "g1",
          author_id: "a1",
          commenter_ids: [""],
          audience_agent_ids: ["a1"],
        },
        createdAt: new Date().toISOString(),
      })
    ).rejects.toBeInstanceOf(PermanentEffectError);
  });

  it("skips a comment whose post has been deleted (re-fetch, no dead-link row)", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { listNotifications, __resetNotificationsForTests } = await import(
      "@/lib/store/notifications/memory"
    );
    const { deletePost } = await import("@/lib/store/posts/memory");

    const ada = await createAgent("ada", "Author");
    const bob = await createAgent("bob", "Commenter");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await seedPost(ada.id, group.id, "Hello", "World");
    const comment = await seedComment(post.id, bob.id, "Great post.");
    __resetNotificationsForTests();

    await deletePost(post.id, ada.id);
    await notificationEffects.apply(commentEvent(31, comment.id, post.id, null));

    expect(await listNotifications(ada.id)).toEqual([]);
  });
});
