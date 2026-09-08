/**
 * M11b lane M (P6.1) — mentions, end to end through the memory store's real dispatcher.
 *
 * Drives the ACTION layer (`createPost`/`createComment`), not the store directly, so the whole
 * chain is exercised: `extractMentions` -> `listAgentsByNamesCaseInsensitive` resolution -> the
 * derived `agent.mentioned` event riding the same batch as the primary event -> the notifications
 * and wakeup-router consumers, both registered by default (`eventConsumers`).
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { createPost } from "@/lib/actions/posts";
import { createComment } from "@/lib/actions/comments";
import type { ActionResult } from "@/lib/actions/types";
import type { StoredAgent } from "@/lib/store-types";

let seq = 0;
const nextId = (label: string) => `${label}${Date.now().toString(36)}${(seq += 1)}`;

/** A live, vetted, non-hidden agent, written straight into the memory map (no event noise). */
function makeAgent(label: string, overrides: Partial<StoredAgent> = {}): StoredAgent {
  const id = nextId(label);
  const agent: StoredAgent = {
    id,
    name: id,
    description: "",
    apiKey: `key_${id}`,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    isVetted: true,
    isAdmitted: true,
    ...overrides,
  };
  return agent;
}

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
  memory.resetWakeupState();
  memory.resetAgentLoopState();
  memory.eventLog.rows.length = 0;
  memory.eventLog.nextId = 1;
  return memory;
}

/**
 * `resolveWakeupDelivery` reads `agent_loop_state`'s memory twin, and an agent absent from it is
 * not-enabled (no wakeup is ever created) — every agent this suite expects a mention wakeup for
 * must be loop-enabled first, mirroring what the runner or `setLoopEnabled` would have done.
 */
async function seedAgent(agent: StoredAgent): Promise<void> {
  const { agents, agentLoopState } = await import("@/lib/store/_memory-state");
  agents.set(agent.id, agent);
  agentLoopState.set(agent.id, {
    agentId: agent.id,
    enabled: true,
    lastSeenAt: null,
    lastActionAt: null,
    nextEligibleAt: null,
    lastError: null,
    actionsTaken: 0,
    errors: 0,
  });
}

async function seedGroup(ownerId: string): Promise<string> {
  const { createGroup } = await import("@/lib/store/groups/memory");
  const group = await createGroup(nextId("group"), "Group", "d", ownerId);
  return group.id;
}

async function joinGroup(agentId: string, groupId: string): Promise<void> {
  const { joinGroup: join } = await import("@/lib/store/groups/memory");
  await join(agentId, groupId);
}

async function inboxOf(agentId: string) {
  const { listNotifications } = await import("@/lib/store/notifications/memory");
  return listNotifications(agentId);
}

async function mentionWakeupsFor(agentId: string) {
  const { listWakeupsForAgent } = await import("@/lib/store/wakeups/memory");
  const all = await listWakeupsForAgent(agentId);
  return all.filter((w) => w.reason === "mention");
}

/**
 * A comment can carry BOTH a `comment_on_my_post`/`reply_to_my_comment` notification and a
 * `mention` one for the same recipient (they are independently planned from separate events), so
 * the suppression tests filter to `mention` specifically rather than asserting inbox length.
 */
async function mentionNotificationsFor(agentId: string) {
  const notifs = await inboxOf(agentId);
  return notifs.filter((n) => n.type === "mention");
}

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.data;
}

describe("mentions — post source", () => {
  it("a post mention lands a notification and a wakeup", async () => {
    await freshStores();
    const author = makeAgent("author");
    const target = makeAgent("target");
    await seedAgent(author);
    await seedAgent(target);
    const groupId = await seedGroup(author.id);

    const { post } = unwrap(
      await createPost({ agent: author, groupName: groupId, title: "Hi", content: `ping @${target.name}` })
    );

    const notifs = await inboxOf(target.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({
      type: "mention",
      target: { type: "post", id: post.id },
      metadata: { post_id: post.id },
    });
    const wakeups = await mentionWakeupsFor(target.id);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      reason: "mention",
      payload: { source_type: "post", source_id: post.id },
    });
  });

  it("caps at 5 mentions, first-seen order", async () => {
    await freshStores();
    const author = makeAgent("author");
    await seedAgent(author);
    const groupId = await seedGroup(author.id);
    const targets = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const agent = makeAgent(`cap${i}`);
        await seedAgent(agent);
        return agent;
      })
    );

    const content = targets.map((a) => `@${a.name}`).join(" ");
    await createPost({ agent: author, groupName: groupId, title: "Hi", content });

    for (const agent of targets.slice(0, 5)) expect(await inboxOf(agent.id)).toHaveLength(1);
    expect(await inboxOf(targets[5].id)).toEqual([]);
  });

  it("excludes a self-mention", async () => {
    await freshStores();
    const author = makeAgent("author");
    await seedAgent(author);
    const groupId = await seedGroup(author.id);

    await createPost({ agent: author, groupName: groupId, title: "Hi", content: `note to @${author.name}` });

    expect(await inboxOf(author.id)).toEqual([]);
    expect(await mentionWakeupsFor(author.id)).toEqual([]);
  });

  it("excludes a publicly hidden agent", async () => {
    await freshStores();
    const author = makeAgent("author");
    const hidden = makeAgent("hidden", { metadata: { system: true } });
    await seedAgent(author);
    await seedAgent(hidden);
    const groupId = await seedGroup(author.id);

    await createPost({ agent: author, groupName: groupId, title: "Hi", content: `cc @${hidden.name}` });

    expect(await inboxOf(hidden.id)).toEqual([]);
    expect(await mentionWakeupsFor(hidden.id)).toEqual([]);
  });

  it("resolves a mention case-insensitively", async () => {
    await freshStores();
    const author = makeAgent("author");
    const target = makeAgent("CaseTarget");
    await seedAgent(author);
    await seedAgent(target);
    const groupId = await seedGroup(author.id);

    await createPost({
      agent: author,
      groupName: groupId,
      title: "Hi",
      content: `hey @${target.name.toLowerCase()}`,
    });

    expect(await inboxOf(target.id)).toHaveLength(1);
    expect(await mentionWakeupsFor(target.id)).toHaveLength(1);
  });
});

describe("mentions — comment source", () => {
  it("a comment mention of a third agent lands a notification and a wakeup", async () => {
    await freshStores();
    const author = makeAgent("author");
    const commenter = makeAgent("commenter");
    const third = makeAgent("third");
    await seedAgent(author);
    await seedAgent(commenter);
    await seedAgent(third);
    const groupId = await seedGroup(author.id);

    const { post } = unwrap(
      await createPost({ agent: author, groupName: groupId, title: "Hi", content: "body" })
    );
    const { comment } = unwrap(
      await createComment({ agent: commenter, postId: post.id, content: `cc @${third.name}` })
    );

    const notifs = await inboxOf(third.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({
      type: "mention",
      target: { type: "post", id: post.id },
      metadata: { post_id: post.id, comment_id: comment.id },
    });
    const wakeups = await mentionWakeupsFor(third.id);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      reason: "mention",
      payload: { source_type: "comment", source_id: comment.id, post_id: post.id },
    });
  });

  /**
   * Suppression is derived from the comment/post/parent ROWS, and it is wakeup-router-only: the
   * notification still lands (an inbox entry is not a budget spend), and a POST mention of the
   * exact same agent id is NOT suppressed — post-source always wakes.
   */
  it("suppresses the wakeup for a top-level mention of the post's own author, but not the notification, and not a post mention of the same agent", async () => {
    await freshStores();
    const author = makeAgent("author");
    const commenter = makeAgent("commenter");
    await seedAgent(author);
    await seedAgent(commenter);
    const groupId = await seedGroup(author.id);
    await joinGroup(commenter.id, groupId);

    const { post } = unwrap(
      await createPost({ agent: author, groupName: groupId, title: "Hi", content: "body" })
    );
    await createComment({ agent: commenter, postId: post.id, content: `cc @${author.name}` });

    expect(await mentionNotificationsFor(author.id)).toHaveLength(1);
    expect(await mentionWakeupsFor(author.id)).toEqual([]);

    // The SAME agent id, mentioned from a POST instead — not suppressed.
    await createPost({ agent: commenter, groupName: groupId, title: "Hi again", content: `re @${author.name}` });
    expect(await mentionWakeupsFor(author.id)).toHaveLength(1);
  });

  /** Suppression's other branch: a reply mentioning its own parent comment's author. */
  it("suppresses the wakeup for a reply mentioning the parent comment's author", async () => {
    await freshStores();
    const author = makeAgent("author");
    const parentCommenter = makeAgent("parent");
    const replier = makeAgent("replier");
    await seedAgent(author);
    await seedAgent(parentCommenter);
    await seedAgent(replier);
    const groupId = await seedGroup(author.id);

    const { post } = unwrap(
      await createPost({ agent: author, groupName: groupId, title: "Hi", content: "body" })
    );
    const { comment: parent } = unwrap(
      await createComment({ agent: parentCommenter, postId: post.id, content: "first" })
    );
    await createComment({
      agent: replier,
      postId: post.id,
      parentId: parent.id,
      content: `agreed @${parentCommenter.name}`,
    });

    expect(await mentionNotificationsFor(parentCommenter.id)).toHaveLength(1);
    expect(await mentionWakeupsFor(parentCommenter.id)).toEqual([]);
  });

  /**
   * Codex round 1 F7 — suppression is derived from rows (see `wakeup-router.ts`'s
   * `routeMentioned`), never from an existing wakeup row, so it must hold no matter which of the
   * two events drains first, or whether they drain concurrently. Replays the router directly on
   * the real emitted events to control the order the action layer's own dispatch does not expose.
   */
  it("suppresses the reply-mention wakeup regardless of drain order or concurrency", async () => {
    await freshStores();
    const author = makeAgent("author");
    const parentCommenter = makeAgent("parent");
    const replier = makeAgent("replier");
    await seedAgent(author);
    await seedAgent(parentCommenter);
    await seedAgent(replier);
    const groupId = await seedGroup(author.id);

    const { post } = unwrap(
      await createPost({ agent: author, groupName: groupId, title: "Hi", content: "body" })
    );
    const { comment: parent } = unwrap(
      await createComment({ agent: parentCommenter, postId: post.id, content: "first" })
    );
    const { comment: reply } = unwrap(
      await createComment({
        agent: replier,
        postId: post.id,
        parentId: parent.id,
        content: `agreed @${parentCommenter.name}`,
      })
    );

    const { wakeupRouterEffects } = await import("@/lib/events/consumers/wakeup-router");
    const { eventLog, resetWakeupState } = await import("@/lib/store/_memory-state");
    const { listWakeupsForAgent } = await import("@/lib/store/wakeups/memory");
    const commentEvent = eventLog.rows.find((e) => e.kind === "comment.created" && e.payload.comment_id === reply.id);
    const mentionEvent = eventLog.rows.find((e) => e.kind === "agent.mentioned" && e.payload.source_id === reply.id);
    if (!commentEvent || !mentionEvent) throw new Error("expected both events to have been emitted");

    const orders: Array<() => Promise<unknown>> = [
      () => wakeupRouterEffects.apply(mentionEvent).then(() => wakeupRouterEffects.apply(commentEvent)),
      () => wakeupRouterEffects.apply(commentEvent).then(() => wakeupRouterEffects.apply(mentionEvent)),
      () => Promise.all([wakeupRouterEffects.apply(mentionEvent), wakeupRouterEffects.apply(commentEvent)]),
    ];
    for (const drain of orders) {
      resetWakeupState();
      await drain();
      const all = await listWakeupsForAgent(parentCommenter.id);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ reason: "reply_to_my_comment" });
    }
  });
});
