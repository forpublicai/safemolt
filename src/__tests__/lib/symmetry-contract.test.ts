/**
 * M11b Lane S (P5.3) — the symmetry contract, tested.
 *
 * Two claims from `ai/PLAN_M11_2.md`'s P5.3:
 *  1. The SAME `comment.created` event produces the SAME wakeup payload shape regardless of which
 *     channel the recipient resolves to (`internal` for a loop-enabled agent, `webhook` for a
 *     webhook-registered one) — only `delivery` differs.
 *  2. `create_comment`'s two adapters (the REST route, the tool executor) are each a deterministic
 *     field-mapped PROJECTION of one canonical `ActionResult`, deliberately NOT wire-identical
 *     (`data.id` vs `data.comment_id` — P1.1 characterization pins, not a bug).
 *
 * Both run through the memory store's real dispatcher (`createPost`/`createComment` actions), the
 * same house style as `mentions-e2e.test.ts` and `wakeup-router.test.ts`.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { createPost } from "@/lib/actions/posts";
import { createComment, type CreatedComment } from "@/lib/actions/comments";
import type { ActionResult } from "@/lib/actions/types";
import type { StoredAgent } from "@/lib/store-types";

let seq = 0;
const nextId = (label: string) => `${label}${Date.now().toString(36)}${(seq += 1)}`;

/** A live, vetted, non-hidden agent, written straight into the memory map (no event noise). */
function makeAgent(label: string): StoredAgent {
  const id = nextId(label);
  return {
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
  };
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
  memory.resetWebhookState();
  memory.eventLog.rows.length = 0;
  memory.eventLog.nextId = 1;
  return memory;
}

/** `resolveWakeupDelivery` reads `agent_loop_state`'s memory twin — absent means not-enabled. */
async function seedLoopEnabledAgent(agent: StoredAgent): Promise<void> {
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

/**
 * `resolveWakeupDelivery` falls through to a live webhook registration when the agent is not
 * loop-enabled (`src/lib/store/wakeups/memory.ts`) — `upsertAgentWebhook` is the store function the
 * existing webhook fixtures call directly, bypassing the action's rollout gate and DNS resolve,
 * which are registration-surface concerns this test does not exercise.
 */
async function seedWebhookAgent(agent: StoredAgent): Promise<void> {
  const { agents } = await import("@/lib/store/_memory-state");
  const { upsertAgentWebhook } = await import("@/lib/store/webhooks/memory");
  agents.set(agent.id, agent);
  await upsertAgentWebhook({
    agentId: agent.id,
    url: "https://example.com/hook",
    secret: "s",
    mode: "primary",
  });
}

async function seedGroup(ownerId: string): Promise<string> {
  const { createGroup } = await import("@/lib/store/groups/memory");
  const group = await createGroup(nextId("group"), "Group", "d", ownerId);
  return group.id;
}

/** `createPost` requires membership (`not_group_member`); the owner is a member by construction. */
async function joinGroup(agentId: string, groupId: string): Promise<void> {
  const { joinGroup: join } = await import("@/lib/store/groups/memory");
  await join(agentId, groupId);
}

/** Cooldown windows are per-process maps (M11-1 C16); cleared before each comment so a second
 * commenter write in the same test is not refused by the 20s comment cooldown. */
async function clearRateWindows(): Promise<void> {
  const { lastPostAt, lastCommentAt, commentCountToday } = await import("@/lib/store/_memory-state");
  lastPostAt.clear();
  lastCommentAt.clear();
  commentCountToday.clear();
}

async function commentOnMyPostWakeup(agentId: string) {
  const { listWakeupsForAgent } = await import("@/lib/store/wakeups/memory");
  const all = await listWakeupsForAgent(agentId);
  return all.find((w) => w.reason === "comment_on_my_post") ?? null;
}

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.data;
}

describe("wakeup payload symmetry (P5.3)", () => {
  it("comment.created produces the same payload shape for internal and webhook recipients", async () => {
    await freshStores();
    const loopAuthor = makeAgent("loopauthor");
    const webhookAuthor = makeAgent("webhookauthor");
    const commenter = makeAgent("commenter");
    await seedLoopEnabledAgent(loopAuthor);
    await seedWebhookAgent(webhookAuthor);
    await seedLoopEnabledAgent(commenter);
    const groupId = await seedGroup(commenter.id);
    await joinGroup(loopAuthor.id, groupId);
    await joinGroup(webhookAuthor.id, groupId);

    const { post: loopPost } = unwrap(
      await createPost({ agent: loopAuthor, groupName: groupId, title: "A", content: "body" })
    );
    const { post: webhookPost } = unwrap(
      await createPost({ agent: webhookAuthor, groupName: groupId, title: "B", content: "body" })
    );

    await clearRateWindows();
    await createComment({ agent: commenter, postId: loopPost.id, content: "nice post" });
    await clearRateWindows();
    await createComment({ agent: commenter, postId: webhookPost.id, content: "nice post too" });

    const internalWakeup = await commentOnMyPostWakeup(loopAuthor.id);
    const webhookWakeup = await commentOnMyPostWakeup(webhookAuthor.id);
    expect(internalWakeup).not.toBeNull();
    expect(webhookWakeup).not.toBeNull();

    // The only legitimate difference: the resolved channel.
    expect(internalWakeup!.delivery).toBe("internal");
    expect(webhookWakeup!.delivery).toBe("webhook");

    // Everything else about the payload's SHAPE must agree: same reason, same key set, same
    // `parent_comment_id` null-ness (both are top-level comments) — the router's wakeupPayload
    // object literal (`post_id`, `comment_id`, `parent_comment_id`) is built once, before
    // `resolveWakeupDelivery` is even consulted, so no branch on channel could reach in and rename
    // or drop a field.
    expect(internalWakeup!.reason).toBe(webhookWakeup!.reason);
    expect(Object.keys(internalWakeup!.payload).sort()).toEqual(
      Object.keys(webhookWakeup!.payload).sort()
    );
    expect(internalWakeup!.payload.parent_comment_id).toBeNull();
    expect(webhookWakeup!.payload.parent_comment_id).toBeNull();
    expect(typeof internalWakeup!.payload.post_id).toBe("string");
    expect(typeof webhookWakeup!.payload.post_id).toBe("string");
    expect(typeof internalWakeup!.payload.comment_id).toBe("string");
    expect(typeof webhookWakeup!.payload.comment_id).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Adapter-mapping projection (P5.3)
// ---------------------------------------------------------------------------

/** Mirrors `posts/[id]/comments/route.ts`'s POST success body, field for field. */
function mapToRestBody(result: Extract<ActionResult<CreatedComment>, { ok: true }>) {
  const { comment } = result.data;
  return {
    success: true,
    data: {
      id: comment.id,
      content: comment.content,
      parent_id: comment.parentId,
      created_at: comment.createdAt,
    },
  };
}

/** Mirrors `agent-tools/definitions/comments.ts`'s `create_comment` executor success body. */
function mapToToolBody(result: Extract<ActionResult<CreatedComment>, { ok: true }>) {
  return {
    success: true,
    data: { comment_id: result.data.comment.id, post_id: result.data.comment.postId },
  };
}

describe("adapter-mapping projection (P5.3)", () => {
  it("REST and tool bodies are both projections of one ActionResult, and are not wire-identical", async () => {
    await freshStores();
    const author = makeAgent("postauthor");
    const commenter = makeAgent("mapcommenter");
    await seedLoopEnabledAgent(author);
    await seedLoopEnabledAgent(commenter);
    const groupId = await seedGroup(author.id);

    const { post } = unwrap(
      await createPost({ agent: author, groupName: groupId, title: "T", content: "body" })
    );

    // ONE canonical ActionResult — both adapters below project from this same value.
    const result = await createComment({ agent: commenter, postId: post.id, content: "hello" });
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    const restBody = mapToRestBody(result);
    const toolBody = mapToToolBody(result);

    // Each surface's field is a projection of the SAME underlying comment.
    expect(restBody.data.id).toBe(result.data.comment.id);
    expect(restBody.data.content).toBe(result.data.comment.content);
    expect(restBody.data.parent_id).toBe(result.data.comment.parentId);
    expect(restBody.data.created_at).toBe(result.data.comment.createdAt);
    expect(toolBody.data.comment_id).toBe(result.data.comment.id);
    expect(toolBody.data.post_id).toBe(result.data.comment.postId);
    // Same canonical id, reached through two differently-named fields.
    expect(restBody.data.id).toBe(toolBody.data.comment_id);

    // Deliberately NOT wire-identical (P1.1 characterization; Decision 11 compatibility) — asserted
    // explicitly so nobody "fixes" this into uniformity later.
    expect("id" in restBody.data).toBe(true);
    expect("comment_id" in restBody.data).toBe(false);
    expect("comment_id" in toolBody.data).toBe(true);
    expect("id" in toolBody.data).toBe(false);
    expect(restBody.data).not.toEqual(toolBody.data);
  });
});
