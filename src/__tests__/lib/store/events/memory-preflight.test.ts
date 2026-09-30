/**
 * M11-2 u3 — memory-mode atomicity for the prepared-events parameter (Decision 4).
 *
 * The discipline is "all throwing work happens before the mutation, and the mutation plus the event
 * append then execute with no `await` between them". A kind-only check up front does not satisfy it:
 * the payload normalization and the idempotency check can throw too, and they used to run *inside*
 * the append — so a duplicate `idem_key`, a duplicate within one batch, or a payload JSON cannot
 * represent left the mutation applied and its events missing.
 *
 * Postgres does the opposite. The event insert rides the mutation's own statement, so a 23505 rolls
 * the mutation back with it — proved against the real database in
 * `src/__tests__/integration/m11-2-u3-posts.test.ts`. Memory mode has to reach the same end state,
 * and the only way to get there without a transaction is to refuse the whole batch before writing
 * anything. That is what these gates check: **after every failure mode, memory state is untouched.**
 *
 * @jest-environment node
 */
import { createPost, deletePost, pinPost } from "@/lib/actions/posts";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { eventLog, groups, lastPostAt, posts } from "@/lib/store/_memory-state";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import {
  appendPreparedBatch,
  emitEvent,
  prepareEventBatch,
} from "@/lib/store/events/memory";
import { createPost as storeCreatePost, deletePost as storeDeletePost, pinPost as storePinPost } from "@/lib/store/posts/memory";
import { seedPost } from "@/__tests__/helpers/store-fixtures";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

let seq = 0;
const nextName = (label: string) => `u3pf_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3 preflight fixture");
  await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

/** The event-log high-water mark, so a test can read only what it appended. */
function marker(): number {
  return eventLog.nextId - 1;
}

/** Events appended since the marker, in order. */
function eventsSince(from: number): StoredEvent[] {
  return eventLog.rows.filter((event) => event.id > from);
}

/** Everything a failed write must leave exactly as it found it. */
function snapshot() {
  return {
    events: eventLog.rows.length,
    nextEventId: eventLog.nextId,
    posts: posts.size,
    groups: JSON.stringify(Array.from(groups.entries()).map(([id, g]) => [id, g.pinnedPostIds])),
    windows: JSON.stringify(Array.from(lastPostAt.entries())),
  };
}

/** A well-formed `post.created` event, minus the fields the store fills. */
function postCreated(agentId: string, groupId: string, extra: Partial<PreparedEvent> = {}): PreparedEvent {
  return {
    kind: "post.created",
    actorAgentId: agentId,
    subjectType: "post",
    subjectId: "",
    payload: { post_id: "", group_id: groupId, author_id: agentId },
    ...extra,
  } as PreparedEvent;
}

describe("prepareEventBatch refuses before anything is written", () => {
  it("refuses an unknown kind", () => {
    expect(() =>
      prepareEventBatch([{ kind: "post.invented", payload: {} } as unknown as PreparedEvent])
    ).toThrow(/refusing to emit unknown kind/);
  });

  it("refuses a payload JSON cannot represent", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      prepareEventBatch([{ kind: "post.pinned", payload: cyclic } as unknown as PreparedEvent])
    ).toThrow();
  });

  it("refuses an idem key already in the log, with the driver's own code", () => {
    const key = nextName("idem");
    const event = { kind: "post.pinned", idemKey: key, payload: { post_id: "p", group_id: "g" } } as PreparedEvent;
    appendPreparedBatch(prepareEventBatch([event]));

    expect(() => prepareEventBatch([event])).toThrow(/idx_events_idem/);
    try {
      prepareEventBatch([event]);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("23505");
    }
  });

  /**
   * The case a per-event check cannot see. Neither event conflicts with the LOG; the second conflicts
   * with the first, and would be refused only after the first had already been appended — the same
   * half-applied state, reached from inside one call.
   */
  it("refuses two events in one batch that share an idem key", () => {
    const key = nextName("batchidem");
    const event = { kind: "post.pinned", idemKey: key, payload: { post_id: "p", group_id: "g" } } as PreparedEvent;
    const before = eventLog.rows.length;

    expect(() => prepareEventBatch([event, { ...event }])).toThrow(/idx_events_idem/);
    expect(eventLog.rows.length).toBe(before);
  });

  it("appends nothing at all when any event in the batch is refused", () => {
    const good = { kind: "post.pinned", payload: { post_id: "p", group_id: "g" } } as PreparedEvent;
    const bad = { kind: "post.invented", payload: {} } as unknown as PreparedEvent;
    const before = eventLog.rows.length;

    expect(() => prepareEventBatch([good, bad])).toThrow();
    // Not "the bad one was skipped" — the GOOD one is absent too, which is the whole guarantee.
    expect(eventLog.rows.length).toBe(before);
  });

  it("appends a preflighted batch without throwing, and dispatches every event", async () => {
    const first = { kind: "post.pinned", payload: { post_id: "p1", group_id: "g" } } as PreparedEvent;
    const second = { kind: "post.unpinned", payload: { post_id: "p2", group_id: "g" } } as PreparedEvent;
    const { stored, dispatched } = appendPreparedBatch(prepareEventBatch([first, second]));
    await dispatched;

    expect(stored.map((row) => row.kind)).toEqual(["post.pinned", "post.unpinned"]);
    expect(stored[1].id).toBe(stored[0].id + 1);
  });
});

describe("a refused batch leaves the store's mutation unapplied", () => {
  it("createPost writes no post, charges no cooldown and appends no event", async () => {
    const author = await agent("create");
    const group = await createGroup(nextName("grp"), "U3 preflight", "", author.id);
    lastPostAt.clear();
    const before = snapshot();

    await expect(
      storeCreatePost(author.id, group.id, "refused", "body", undefined, [
        { ...postCreated(author.id, group.id), kind: "post.invented" } as unknown as PreparedEvent,
      ])
    ).rejects.toThrow(/refusing to emit unknown kind/);

    // The post, the cooldown stamp and the event log are all exactly as they were. Before the
    // preflight moved up, the cooldown had already been charged and the post already inserted.
    expect(snapshot()).toEqual(before);
  });

  /**
   * **A refused mutation refuses; it does not raise the event log's uniqueness error.**
   *
   * The db event insert is gated on the cooldown claim's CTE, so a retry inside the window inserts
   * no post AND no event — a duplicate `idem_key` never reaches the index, and the caller gets the
   * `null` that produces its 429. Memory mode ran the whole preflight before the cooldown, so the
   * ordinary shape of a client retry (same key, too soon) threw 23505 in Jest and answered null in
   * production. Validation still runs first, because Postgres validates while it renders.
   *
   * The db half is `src/__tests__/integration/m11-2-u3-posts.test.ts`.
   */
  it("answers null rather than 23505 when the cooldown refuses a retry reusing an idem key", async () => {
    const author = await agent("idemretry");
    const group = await createGroup(nextName("grp"), "U3 preflight", "", author.id);
    lastPostAt.clear();
    const key = nextName("retrykey");
    const withKey = () => [postCreated(author.id, group.id, { idemKey: key })];

    expect(await storeCreatePost(author.id, group.id, "first", "body", undefined, withKey())).not.toBeNull();
    const before = snapshot();

    await expect(
      storeCreatePost(author.id, group.id, "retry", "body", undefined, withKey())
    ).resolves.toBeNull();
    // Refused means refused: no post, no event, and the window not re-stamped.
    expect(snapshot()).toEqual(before);

    // Uniqueness is not weakened, only re-ordered — once the window admits the post, the duplicate
    // key is refused exactly as `idx_events_idem` refuses it, and the post is not written.
    lastPostAt.clear();
    await expect(
      storeCreatePost(author.id, group.id, "same key again", "body", undefined, withKey())
    ).rejects.toMatchObject({ code: "23505" });
    expect(posts.size).toBe(before.posts);
  });

  it("deletePost leaves the post live, its karma reversed by nothing, and no event appended", async () => {
    const author = await agent("delete");
    const group = await createGroup(nextName("grp"), "U3 preflight", "", author.id);
    const post = await seedPost(author.id, group.id, "survives");
    const before = snapshot();

    await expect(
      storeDeletePost(post.id, author.id, [
        { kind: "post.invented", payload: {} } as unknown as PreparedEvent,
      ])
    ).rejects.toThrow(/refusing to emit unknown kind/);

    expect(posts.get(post.id)?.deletedAt).toBeUndefined();
    expect(snapshot()).toEqual(before);
  });

  it("pinPost leaves the group's pins untouched and appends no event", async () => {
    const owner = await agent("pin");
    const group = await createGroup(nextName("grp"), "U3 preflight", "", owner.id);
    const post = await seedPost(owner.id, group.id, "unpinned");
    const before = snapshot();

    await expect(
      storePinPost(group.id, post.id, owner.id, [
        { kind: "post.invented", payload: {} } as unknown as PreparedEvent,
      ])
    ).rejects.toThrow(/refusing to emit unknown kind/);

    expect(groups.get(group.id)?.pinnedPostIds ?? []).not.toContain(post.id);
    expect(snapshot()).toEqual(before);
  });
});

/**
 * The primary+derived shape, memory side.
 *
 * The db store renders both events into one statement with per-event substitutions; memory appends
 * both in one synchronous section. What has to agree across the two is that each event keeps its own
 * subject — the property a single whole-list substitution would destroy.
 */
describe("a primary event and a differently-subjected derived event", () => {
  it("keeps each event's own subject when both ride one append", async () => {
    const before = eventLog.rows.length;
    const primary = {
      kind: "post.pinned",
      actorAgentId: "u3pf_actor",
      subjectType: "post",
      subjectId: "u3pf_primary_subject",
      payload: { post_id: "u3pf_primary_subject", group_id: "u3pf_group" },
    } as PreparedEvent;
    const derived = {
      kind: "post.unpinned",
      actorAgentId: "u3pf_actor",
      subjectType: "post",
      subjectId: "u3pf_derived_subject",
      payload: { post_id: "u3pf_derived_subject", group_id: "u3pf_group" },
    } as PreparedEvent;

    const { dispatched } = appendPreparedBatch(prepareEventBatch([primary, derived]));
    await dispatched;

    const appended = eventLog.rows.slice(before);
    expect(appended.map((row) => row.subjectId)).toEqual([
      "u3pf_primary_subject",
      "u3pf_derived_subject",
    ]);
    expect(appended.map((row) => (row.payload as { post_id: string }).post_id)).toEqual([
      "u3pf_primary_subject",
      "u3pf_derived_subject",
    ]);
  });
});

/**
 * Store-assigned substitution is **positional**, and the parity that makes it matter is same-kind.
 *
 * The db store applies `overrides[0]` to `events[0]` and leaves every later event alone, whatever
 * kind it is. A memory twin keyed on the KIND instead would fill every `post.created` in the list —
 * so the two stores would agree for one event and disagree for two, which is exactly the shape
 * P1.2's primary+derived batches take. These fixtures pass two events of the SAME kind, because a
 * kind-keyed bug is invisible to any fixture whose events differ.
 *
 * The db half is `src/__tests__/integration/m11-2-u3-posts.test.ts`.
 */
describe("store-assigned fields land on the positional primary only", () => {
  const secondary = (label: string): PreparedEvent =>
    ({
      kind: "post.created",
      actorAgentId: "u3pf_actor",
      subjectType: "post",
      subjectId: `u3pf_${label}_subject`,
      payload: { post_id: `u3pf_${label}_post`, group_id: "u3pf_group", author_id: "u3pf_actor" },
    }) as PreparedEvent;

  it("createPost fills the first post.created and leaves a second one untouched", async () => {
    const author = await agent("samekindcreate");
    const group = await createGroup(nextName("grp"), "U3 preflight", "", author.id);
    lastPostAt.clear();
    const before = marker();

    const post = await storeCreatePost(author.id, group.id, "same kind", "body", undefined, [
      postCreated(author.id, group.id),
      secondary("derived"),
    ]);
    expect(post).not.toBeNull();

    const [primary, derived] = eventsSince(before);
    // The primary took the minted id, in the column and in the payload.
    expect(primary.subjectId).toBe(post!.id);
    expect((primary.payload as { post_id: string }).post_id).toBe(post!.id);
    // The second event kept ITS OWN subject — a kind-keyed substitution would have overwritten both.
    expect(derived.subjectId).toBe("u3pf_derived_subject");
    expect((derived.payload as { post_id: string }).post_id).toBe("u3pf_derived_post");
  });

  it("deletePost fills the first post.deleted and leaves a second one untouched", async () => {
    const author = await agent("samekinddelete");
    const group = await createGroup(nextName("grp"), "U3 preflight", "", author.id);
    const post = await seedPost(author.id, group.id, "same kind delete");
    const before = marker();

    const deletedEvent = (label: string, lists: string[]): PreparedEvent =>
      ({
        kind: "post.deleted",
        actorAgentId: author.id,
        subjectType: "post",
        subjectId: label,
        payload: {
          post_id: post.id,
          group_id: group.id,
          author_id: author.id,
          comment_ids: lists,
          commenter_ids: lists,
          audience_agent_ids: lists,
        },
      }) as PreparedEvent;

    const result = await storeDeletePost(post.id, author.id, [
      deletedEvent("primary", [STORE_ASSIGNED_PAYLOAD_ID]),
      deletedEvent("derived", ["u3pf_kept"]),
    ]);
    expect(result.deleted).toBe(true);

    const [primary, derived] = eventsSince(before);
    // The primary's three lists were replaced by what the deletion actually saw.
    expect((primary.payload as { audience_agent_ids: string[] }).audience_agent_ids).toEqual([author.id]);
    expect((primary.payload as { commenter_ids: string[] }).commenter_ids).toEqual([]);
    // The second event kept its own lists, untouched.
    expect((derived.payload as { audience_agent_ids: string[] }).audience_agent_ids).toEqual(["u3pf_kept"]);
    expect((derived.payload as { commenter_ids: string[] }).commenter_ids).toEqual(["u3pf_kept"]);
  });
});

describe("the single-event entry point still works through the same path", () => {
  it("emits and returns the row's id and timestamp", async () => {
    const emitted = await emitEvent({
      kind: "post.pinned",
      payload: { post_id: "u3pf_single", group_id: "u3pf_group" },
    } as PreparedEvent);
    expect(emitted.id).toBeGreaterThan(0);
    expect(emitted.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /** The actions still work end to end, so the reordering did not break the ordinary path. */
  it("leaves the ordinary action path intact", async () => {
    const author = await agent("ok");
    const group = await createGroup(nextName("grp"), "U3 preflight", "", author.id);
    lastPostAt.clear();

    const created = await createPost({ agent: author, groupName: group.name, title: "fine" });
    expect(created.ok).toBe(true);
    const postId = created.ok ? created.data.post.id : "";
    expect((await pinPost({ agent: author, postId })).ok).toBe(true);
    expect((await deletePost({ agent: author, postId })).ok).toBe(true);
  });
});
