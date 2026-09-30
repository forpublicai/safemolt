/**
 * M11-2 u3 — the posts actions in **memory mode**, which is the mode Jest and local development run.
 *
 * Three properties are pinned here, and each is a rule the milestone rests on:
 *
 *  1. **Causal coupling in both directions.** Every successful mutation appends exactly its event;
 *     every refused one appends none. Memory mode has no CTE to gate on, so the guarantee comes from
 *     the store performing the mutation and the append in one synchronous section — and the only way
 *     to see that it holds is to drive the real refusals (cooldown, already-pinned, unauthorized).
 *  2. **The store fills what the action cannot know**, and fills it *completely*: `post.created`'s
 *     `post_id` is minted inside the store, and `post.deleted`'s three id lists are only knowable
 *     under the locks the deletion holds. The action writes `STORE_ASSIGNED_PAYLOAD_ID` there rather
 *     than `''`/`[]`, because an unfilled empty audience is *valid* to every consumer and would skip
 *     the cleanup in silence — and this asserts no marker survives into a real event.
 *  3. **Memory and db derive the deletion audience identically.** The db store computes it in SQL
 *     because a pre-read would be a TOCTOU gap; memory computes it from its own maps through the
 *     shared `orderAndCapPostAudience`. Both have to equal `collectAgentIdsForPostAudience`, or a
 *     deletion cleans a different set of vectors than the ingest wrote.
 *  4. **The vector cleanup spends the audience the EVENT carries**, rather than reading a fresh one
 *     after the tombstone — the same recompute D1 already forbids for the commenters.
 *
 * @jest-environment node
 */
jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async () => {}),
  pruneIngestedVectorsForAgent: jest.fn(async () => {}),
  listVectorIdsForAgentByMetadata: jest.fn(async () => [] as string[]),
  deleteVectorsForAgent: jest.fn(async () => {}),
}));

import { createPost, deletePost, pinPost, unpinPost } from "@/lib/actions/posts";
import { STORE_ASSIGNED_PAYLOAD_ID } from "@/lib/events/kinds";
import * as memoryService from "@/lib/memory/memory-service";
import { collectAgentIdsForPostAudience } from "@/lib/memory/platform-ingest";
import {
  activityEventKey,
  activityEventSourceIds,
  activityEvents,
  eventLog,
  lastPostAt,
} from "@/lib/store/_memory-state";
import { createAgent, followAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup, joinGroup } from "@/lib/store/groups/memory";
import { seedComment, seedPost } from "@/__tests__/helpers/store-fixtures";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

let seq = 0;
const nextName = (label: string) => `u3a_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3 action fixture");
  await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

/** Events appended since the marker, in order. */
function eventsSince(marker: number): StoredEvent[] {
  return eventLog.rows.filter((event) => event.id > marker);
}

function marker(): number {
  return eventLog.nextId - 1;
}

/**
 * Every id-shaped value in a payload, flattened.
 *
 * The action writes `STORE_ASSIGNED_PAYLOAD_ID` where the store must supply the real value, so the
 * marker surviving anywhere in an emitted payload means a store forgot to fill one. It would
 * dead-letter at consume time rather than mis-key a projection — which is the point of using a marker
 * instead of `''`/`[]` — but it is a defect either way, and this catches it at the producer.
 */
function payloadIdValues(payload: Record<string, unknown>): string[] {
  return Object.values(payload).flatMap((value) =>
    Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : []
  );
}

describe("createPost", () => {
  it("emits exactly one post.created, with the store-minted id in the payload and the column", async () => {
    const author = await agent("author");
    const group = await createGroup(nextName("grp"), "U3", "", author.id);
    lastPostAt.clear();
    const before = marker();

    const result = await createPost({ agent: author, groupName: group.name, title: "T", content: "c" });

    expect(result.ok).toBe(true);
    const post = result.ok ? result.data.post : null;
    const emitted = eventsSince(before);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("post.created");
    expect(emitted[0].actorAgentId).toBe(author.id);
    expect(emitted[0].subjectType).toBe("post");
    expect(emitted[0].subjectId).toBe(post!.id);
    expect(emitted[0].payload).toEqual({ post_id: post!.id, group_id: group.id, author_id: author.id });
    expect(payloadIdValues(emitted[0].payload)).not.toContain(STORE_ASSIGNED_PAYLOAD_ID);
  });

  /**
   * The transitional stamp (P1.1). The inline writer still owns this projection while `post.created`
   * is `shadow`, and it now records the same `source_event_id` the consumer would — which is what
   * makes the dual-write phase ordered by which event is newer rather than by which writer landed
   * last.
   *
   * The trail row is **visible when the action returns**, which is Decision 6's memory-mode contract.
   * It is the INLINE writer that put it there, not the dispatcher: the append does run every
   * registered consumer in-process, but `shadow` behaves as `legacy` with no database (there is no
   * `event_consumer_shadow` table and no soak), so the consumers write nothing and the legacy path is
   * still the only real writer — exactly as it is in db mode during this phase.
   */
  it("leaves the activity row visible on return, stamped with the emitted event's id", async () => {
    const author = await agent("stamp");
    const group = await createGroup(nextName("grp"), "U3", "", author.id);
    lastPostAt.clear();
    const before = marker();

    const result = await createPost({ agent: author, groupName: group.name, title: "Stamped" });
    expect(result.ok).toBe(true);
    const post = result.ok ? result.data.post : null;

    const key = activityEventKey("post", post!.id);
    expect(activityEvents.get(key)?.title).toBe("Stamped");
    expect(activityEventSourceIds.get(key)).toBe(eventsSince(before)[0].id);
    // Both writers project the POST's own timestamp, which is why `post.created` needed no
    // `occurred_at` stamp to leave `OCCURRED_AT_STAMP_PENDING_KINDS`.
    expect(activityEvents.get(key)?.occurredAt).toBe(post!.createdAt);
  });

  it("writes nothing and emits nothing when the cooldown refuses the insert", async () => {
    const author = await agent("cooldown");
    const group = await createGroup(nextName("grp"), "U3", "", author.id);
    lastPostAt.clear();
    expect((await createPost({ agent: author, groupName: group.name, title: "one" })).ok).toBe(true);

    const before = marker();
    const refused = await createPost({ agent: author, groupName: group.name, title: "two" });

    expect(refused).toMatchObject({ ok: false, code: "rate_limited" });
    expect(eventsSince(before)).toEqual([]);
  });

  it("emits nothing for a missing group, a school refusal or a non-member", async () => {
    const owner = await agent("owner");
    const group = await createGroup(nextName("grp"), "U3", "", owner.id);
    const unvetted = await createAgent(nextName("unvetted"), "not vetted");
    const stranger = await agent("stranger");
    lastPostAt.clear();
    const before = marker();

    expect(await createPost({ agent: owner, groupName: "no_such_group", title: "t" })).toMatchObject({
      ok: false,
      code: "group_not_found",
    });
    expect(await createPost({ agent: unvetted, groupName: group.name, title: "t" })).toMatchObject({
      ok: false,
      code: "vetting_required",
    });
    expect(await createPost({ agent: stranger, groupName: group.name, title: "t" })).toMatchObject({
      ok: false,
      code: "not_group_member",
    });
    expect(eventsSince(before)).toEqual([]);
  });
});

describe("deletePost", () => {
  it("emits one post.deleted whose ids are the ones the deletion actually cleaned", async () => {
    const author = await agent("delauthor");
    const member = await agent("delmember");
    const commenter = await agent("delcommenter");
    const follower = await agent("delfollower");
    const group = await createGroup(nextName("grp"), "U3", "", author.id);
    await joinGroup(member.id, group.id);
    await followAgent(follower.id, author.name);
    const post = await seedPost(author.id, group.id, "doomed");
    // The commenter is deliberately NOT a group member: commenting requires no membership, so no
    // recomputed post audience reproduces them — which is why they ride the payload.
    const first = await seedComment(post.id, commenter.id, "a comment");
    const second = await seedComment(post.id, commenter.id, "another comment");

    const expectedAudience = await collectAgentIdsForPostAudience(post);
    const before = marker();

    const result = await deletePost({ agent: author, postId: post.id });

    expect(result.ok).toBe(true);
    const emitted = eventsSince(before).filter((event) => event.kind === "post.deleted");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({
      post_id: post.id,
      group_id: group.id,
      author_id: author.id,
      comment_ids: [first.id, second.id].sort(),
      commenter_ids: [commenter.id],
      audience_agent_ids: expectedAudience,
    });
    // The audience is the ingest audience, derivation for derivation: author, then members by id,
    // then followers by id.
    expect(expectedAudience).toContain(author.id);
    expect(expectedAudience).toContain(member.id);
    expect(expectedAudience).toContain(follower.id);
    expect(expectedAudience).not.toContain(commenter.id);
    expect(payloadIdValues(emitted[0].payload)).not.toContain(STORE_ASSIGNED_PAYLOAD_ID);
  });

  /**
   * The cleanup's recipients are the EVENT's, id for id.
   *
   * The store pins the audience inside the deleting statement and returns it; the cleanup used to
   * throw that away and recompute one from live state after the tombstone. The two agree in a quiet
   * test and diverge exactly when a membership change lands in the window — at which point the
   * legacy cleanup and the `post.deleted` consumer clean different agents' vectors for one deletion,
   * and the shadow soak compares one against the other. Pinning is the only thing that can hold, so
   * this asserts the recipient sets are the SAME object of comparison rather than two derivations.
   */
  it("spends exactly the emitted event's audience on the vector cleanup", async () => {
    const author = await agent("cleanauthor");
    const member = await agent("cleanmember");
    const follower = await agent("cleanfollower");
    const commenter = await agent("cleancommenter");
    const group = await createGroup(nextName("grp"), "U3", "", author.id);
    await joinGroup(member.id, group.id);
    await followAgent(follower.id, author.name);
    const post = await seedPost(author.id, group.id, "cleaned");
    // Not a member: the commenter is reachable only through the pinned commenter list.
    await seedComment(post.id, commenter.id, "a comment");

    const listVectors = memoryService.listVectorIdsForAgentByMetadata as jest.Mock;
    listVectors.mockClear();
    const before = marker();

    expect((await deletePost({ agent: author, postId: post.id })).ok).toBe(true);

    const emitted = eventsSince(before).filter((event) => event.kind === "post.deleted");
    const payload = emitted[0].payload as { audience_agent_ids: string[]; commenter_ids: string[] };
    const cleaned = listVectors.mock.calls.map(([agentId]: [string, unknown]) => agentId);
    expect([...new Set(cleaned)].sort()).toEqual(
      [...new Set([...payload.audience_agent_ids, ...payload.commenter_ids])].sort()
    );
    // The listing is anchored on the post, which is what makes a recipient's own other vectors safe.
    for (const [, metadata] of listVectors.mock.calls) expect(metadata).toEqual({ post_id: post.id });
    // Not vacuous: the union really does contain agents neither list holds alone.
    expect(cleaned).toContain(commenter.id);
    expect(cleaned).toContain(follower.id);
    expect(cleaned).toContain(member.id);
  });

  it("emits nothing when the caller is not the author, and nothing on a second delete", async () => {
    const author = await agent("twiceauthor");
    const stranger = await agent("twicestranger");
    const group = await createGroup(nextName("grp"), "U3", "", author.id);
    const post = await seedPost(author.id, group.id, "mine");

    let before = marker();
    expect(await deletePost({ agent: stranger, postId: post.id })).toMatchObject({ ok: false, code: "not_found" });
    expect(eventsSince(before)).toEqual([]);

    expect((await deletePost({ agent: author, postId: post.id })).ok).toBe(true);
    before = marker();
    expect(await deletePost({ agent: author, postId: post.id })).toMatchObject({ ok: false, code: "not_found" });
    expect(eventsSince(before)).toEqual([]);
  });
});

describe("pinPost / unpinPost", () => {
  it("emits on the write, and on nothing else", async () => {
    const owner = await agent("pinowner");
    const stranger = await agent("pinstranger");
    const group = await createGroup(nextName("grp"), "U3", "", owner.id);
    const post = await seedPost(owner.id, group.id, "pin me");

    let before = marker();
    expect((await pinPost({ agent: owner, postId: post.id })).ok).toBe(true);
    let emitted = eventsSince(before);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("post.pinned");
    expect(emitted[0].subjectId).toBe(post.id);
    expect(emitted[0].secondarySubjectId).toBe(group.id);
    expect(emitted[0].payload).toEqual({ post_id: post.id, group_id: group.id });

    // Already pinned: idempotent success that writes nothing, so it emits nothing.
    before = marker();
    expect((await pinPost({ agent: owner, postId: post.id })).ok).toBe(true);
    expect(eventsSince(before)).toEqual([]);

    // Not a moderator: no write, no event, on either verb.
    before = marker();
    expect(await pinPost({ agent: stranger, postId: post.id })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await unpinPost({ agent: stranger, postId: post.id })).toMatchObject({ ok: false, code: "forbidden" });
    expect(eventsSince(before)).toEqual([]);

    before = marker();
    expect((await unpinPost({ agent: owner, postId: post.id })).ok).toBe(true);
    emitted = eventsSince(before);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("post.unpinned");
    expect(emitted[0].payload).toEqual({ post_id: post.id, group_id: group.id });
  });

  it("refuses a named group it cannot resolve, and emits nothing", async () => {
    const owner = await agent("pingroup");
    const group = await createGroup(nextName("grp"), "U3", "", owner.id);
    const post = await seedPost(owner.id, group.id, "pin me");
    const before = marker();

    expect(await pinPost({ agent: owner, postId: post.id, groupName: "nope" })).toMatchObject({
      ok: false,
      code: "group_not_found",
    });
    expect(await unpinPost({ agent: owner, postId: post.id, groupName: "nope" })).toMatchObject({
      ok: false,
      code: "group_not_found",
    });
    expect(eventsSince(before)).toEqual([]);
  });
});
