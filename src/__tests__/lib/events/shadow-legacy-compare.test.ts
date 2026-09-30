/**
 * M11-2 u4-prep — the drain-time shadow comparison, in MEMORY mode.
 *
 * The soak itself is db-only: memory mode has no `event_consumer_shadow` table and no second
 * writer, so `shadow` behaves as `legacy` there and no shadow row is ever written. What IS shared
 * between the two stores is everything that decides the stamp — the per-consumer twin readers
 * (resolved through the store facade, one implementation each side) and the pure verdict function —
 * and this file drives exactly that half against the memory store.
 *
 * Two properties it exists to hold:
 *  - the twin read and the describe path produce the SAME canonical shape, so a clean pair stamps
 *    `matched`. A formatting drift between the two mappers would otherwise stamp every event of a
 *    production soak `payload_mismatch` and be discovered only there.
 *  - the diff is presence-sensitive: a DROPPED key is a mismatch, which is precisely what a
 *    containment check would pass vacuously.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { activityTrailEffects } from "@/lib/events/consumers/activity-trail";
import {
  compareErrorStamp,
  stampShadowComparison,
  type LegacyTwin,
} from "@/lib/events/consumers/legacy-compare";
import { memoryIngestEffects } from "@/lib/events/consumers/memory-ingest";
import { notificationEffects } from "@/lib/events/consumers/notifications";
import type { StoredEvent } from "@/lib/store-types";

function syntheticEvent(id: number, kind: string, overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id,
    kind,
    actorAgentId: null,
    subjectType: null,
    subjectId: null,
    secondarySubjectId: null,
    schoolId: null,
    idemKey: null,
    payload: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  } as StoredEvent;
}

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
  memory.notifications.clear();
  memory.notificationDedupKeys.clear();
  return memory;
}

/** Every path the twin reader must be compared WITHOUT — applied to both sides, as the dispatcher does. */
function strip(payload: Record<string, unknown>, kind: string, fields?: Readonly<Record<string, readonly string[]>>) {
  const paths = fields?.[kind] ?? [];
  return paths.reduce<Record<string, unknown>>((acc, path) => {
    const [head, ...rest] = path.split(".");
    if (!(head in acc)) return acc;
    if (rest.length === 0) {
      const { [head]: _dropped, ...remaining } = acc;
      return remaining;
    }
    const nested = acc[head];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return acc;
    const { [rest.join(".")]: _inner, ...innerRest } = nested as Record<string, unknown>;
    return { ...acc, [head]: innerRest };
  }, payload);
}

describe("the notifications twin reader, in memory mode", () => {
  it("stamps matched for the row its own writer just wrote", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createFollowNotificationIdempotent, describeFollowNotification } = await import(
      "@/lib/store/notifications/memory"
    );

    const follower = await createAgent("ada", "Ada");
    const followee = await createAgent("bob", "Bob");
    const event = syntheticEvent(7, "agent.followed", {
      actorAgentId: follower.id,
      subjectId: followee.id,
    });
    const input = {
      recipientAgentId: followee.id,
      actorAgentId: follower.id,
      createdAt: event.createdAt,
      dedupKey: `new_follower:${followee.id}:${event.id}`,
    };

    // The legacy inline writer's row, then the row the consumer WOULD write — the two sides of a
    // production soak, in the same instant.
    expect(await createFollowNotificationIdempotent(input)).not.toBeNull();
    const described = (await describeFollowNotification(input)) as unknown as Record<string, unknown>;

    const twin = await notificationEffects.readLegacyTwin!(event, input.dedupKey);
    expect(twin.state).toBe("row");
    const stripped: LegacyTwin = {
      state: "row",
      payload: strip(
        (twin as { payload: Record<string, unknown> }).payload,
        event.kind,
        notificationEffects.volatileShadowFields
      ),
    };
    const stamp = stampShadowComparison(
      stripped,
      strip(described, event.kind, notificationEffects.volatileShadowFields)
    );
    expect(stamp).toEqual({ legacyMatch: "matched", legacyDetail: null });
  });

  it("stamps legacy_missing for a key nothing wrote, while the subject is still LIVE", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const follower = await createAgent("ada", "Ada");
    const followee = await createAgent("bob", "Bob");
    const key = `new_follower:${followee.id}:9`;
    const event = syntheticEvent(9, "agent.followed", {
      actorAgentId: follower.id,
      subjectId: followee.id,
    });
    const twin = await notificationEffects.readLegacyTwin!(event, key);
    expect(stampShadowComparison(twin, {})).toEqual({
      legacyMatch: "legacy_missing",
      legacyDetail: { dedup_key: key },
    });
  });

  /**
   * u4prep2 finding 3 — the describe→twin-read gap.
   *
   * `describe` locks its subject, but that lock ends with its query; the twin read is a separate
   * statement. A withdrawal (or a post deletion, for the comment kinds) landing in between correctly
   * removes the legacy row, and a lookup that reported that as `legacy_missing` made a correct
   * deletion verdict-bearing. The read re-locks the subject, and its absence is `unverifiable`.
   */
  it("stamps unverifiable when the subject is deleted before the twin read", async () => {
    await freshStores();
    const { createAgent, deleteAgent } = await import("@/lib/store/agents/memory");
    const {
      createFollowNotificationIdempotent,
    } = await import("@/lib/store/notifications/memory");

    const follower = await createAgent("ada", "Ada");
    const followee = await createAgent("bob", "Bob");
    const event = syntheticEvent(13, "agent.followed", {
      actorAgentId: follower.id,
      subjectId: followee.id,
    });
    const key = `new_follower:${followee.id}:${event.id}`;
    expect(
      await createFollowNotificationIdempotent({
        recipientAgentId: followee.id,
        actorAgentId: follower.id,
        createdAt: event.createdAt,
        dedupKey: key,
      })
    ).not.toBeNull();

    // The withdrawal takes the inbox with it — the db side's `ON DELETE CASCADE`, mirrored here.
    expect((await deleteAgent(followee.id)).ok).toBe(true);

    const twin = await notificationEffects.readLegacyTwin!(event, key);
    expect(twin.state).toBe("unverifiable");
    expect(stampShadowComparison(twin, {}).legacyMatch).toBe("unverifiable");
  });

  it("stamps unverifiable for a deletion, whose rows are gone on both sides", async () => {
    const event = syntheticEvent(11, "post.deleted", { subjectId: "p1", payload: { post_id: "p1" } });
    const twin = await notificationEffects.readLegacyTwin!(event, "notifications-for-post:p1");
    expect(twin.state).toBe("unverifiable");
    expect(stampShadowComparison(twin, {}).legacyMatch).toBe("unverifiable");
  });
});

describe("the activity-trail twin reader, in memory mode", () => {
  /**
   * A REUSED natural key, which is the shape every activity kind has: one `follower:followee` row
   * survives every re-follow, one `agent:group` row every leave-then-rejoin, and one
   * `playground_session:{id}` row all six lifecycle kinds. The inline upsert replaces
   * `source_event_id` on each write, so an event drained after the next write can only ever see the
   * newer row — routine behavior on both sides, and the reason it may not be verdict-bearing
   * (u4prep2 finding 1).
   */
  it("stamps superseded when a LATER event has already rewritten the reusable key", async () => {
    await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { applyFollowActivityFromEvent } = await import("@/lib/store/activity/events");

    const follower = await createAgent("ada", "Ada");
    const followee = await createAgent("bob", "Bob");
    const input = {
      followerId: follower.id,
      followeeId: followee.id,
      followeeName: followee.name,
      followeeDisplayName: followee.displayName,
      createdAt: new Date().toISOString(),
    };
    const first = syntheticEvent(40, "agent.followed", {
      actorAgentId: follower.id,
      subjectId: followee.id,
    });
    const second = syntheticEvent(41, "agent.followed", { ...first, id: 41 });

    // Follow, unfollow, re-follow: two events, one row, and the second write owns it.
    await applyFollowActivityFromEvent(input, first.id);
    await applyFollowActivityFromEvent(input, second.id);

    const key = `follow:${follower.id}:${followee.id}`;
    const superseded = await activityTrailEffects.readLegacyTwin!(first, key);
    expect(superseded.state).toBe("superseded");
    const stamp = stampShadowComparison(superseded, {});
    expect(stamp.legacyMatch).toBe("superseded");
    expect(Number((stamp.legacyDetail as Record<string, unknown>).legacy_source_event_id)).toBe(41);

    // The newer event still compares normally — supersession is per event, not per key.
    expect((await activityTrailEffects.readLegacyTwin!(second, key)).state).toBe("row");
  });

  it("stamps matched for its own event's row, and unverifiable once the subject is deleted", async () => {
    const memory = await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { applyPostActivityFromEvent, describePostActivityProjection } = await import(
      "@/lib/store/activity/events"
    );
    const { seedPost } = await import("@/__tests__/helpers/store-fixtures");

    const ada = await createAgent("ada", "Ada");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await seedPost(ada.id, group.id, "Hello", "A body with enough words in it.");
    memory.activityEvents.clear();
    memory.activityEventSourceIds.clear();

    const event = syntheticEvent(21, "post.created", {
      actorAgentId: ada.id,
      subjectId: post.id,
      payload: { post_id: post.id, group_id: group.id, author_id: ada.id },
    });
    const input = {
      id: post.id,
      authorId: post.authorId,
      groupId: post.groupId,
      title: post.title,
      content: post.content,
      url: post.url,
      createdAt: post.createdAt,
    };
    await applyPostActivityFromEvent(input, event.id);
    const described = (await describePostActivityProjection(input)) as unknown as Record<string, unknown>;

    const twin = await activityTrailEffects.readLegacyTwin!(event, `post:${post.id}`);
    expect(twin.state).toBe("row");
    const stamp = stampShadowComparison(
      {
        state: "row",
        payload: strip(
          (twin as { payload: Record<string, unknown> }).payload,
          event.kind,
          activityTrailEffects.volatileShadowFields
        ),
      },
      strip(described, event.kind, activityTrailEffects.volatileShadowFields)
    );
    expect(stamp).toEqual({ legacyMatch: "matched", legacyDetail: null });

    // The post deleted BETWEEN describe and the twin read (u4prep2 finding 3): the deletion removes
    // the trail row correctly, and the read must say so rather than blame the legacy writer.
    const { deletePost } = await import("@/lib/store/posts/memory");
    expect((await deletePost(post.id, ada.id)).deleted).toBe(true);
    const afterDeletion = await activityTrailEffects.readLegacyTwin!(event, `post:${post.id}`);
    expect(afterDeletion.state).toBe("unverifiable");
    expect(stampShadowComparison(afterDeletion, described).legacyMatch).toBe("unverifiable");
  });

  it("stamps legacy_missing when the row stopped at an EARLIER event", async () => {
    const memory = await freshStores();
    const { createAgent } = await import("@/lib/store/agents/memory");
    const { createGroup } = await import("@/lib/store/groups/memory");
    const { applyPostActivityFromEvent, describePostActivityProjection } = await import(
      "@/lib/store/activity/events"
    );
    const { seedPost } = await import("@/__tests__/helpers/store-fixtures");

    const ada = await createAgent("ada", "Ada");
    const group = await createGroup("research", "Research", "Lab", ada.id);
    const post = await seedPost(ada.id, group.id, "Hello", "A body with enough words in it.");
    memory.activityEvents.clear();
    memory.activityEventSourceIds.clear();

    const event = syntheticEvent(21, "post.created", {
      actorAgentId: ada.id,
      subjectId: post.id,
      payload: { post_id: post.id, group_id: group.id, author_id: ada.id },
    });
    const input = {
      id: post.id,
      authorId: post.authorId,
      groupId: post.groupId,
      title: post.title,
      content: post.content,
      url: post.url,
      createdAt: post.createdAt,
    };
    await applyPostActivityFromEvent(input, event.id);
    const described = (await describePostActivityProjection(input)) as unknown as Record<string, unknown>;

    // The same row, read for a LATER event: the watermark stopped at event 21, so nothing the
    // legacy writer produced for event 22 is on disk. Verdict-bearing, unlike the newer-watermark
    // case above.
    const otherEvent = syntheticEvent(22, "post.created", { ...event, id: 22 });
    const otherTwin = await activityTrailEffects.readLegacyTwin!(otherEvent, `post:${post.id}`);
    expect(otherTwin.state).toBe("missing");
    expect(stampShadowComparison(otherTwin, described).legacyMatch).toBe("legacy_missing");
  });
});

describe("memory ingest never claims a comparison it cannot make", () => {
  it("stamps unverifiable for every kind, with the provider named", async () => {
    const twin = await memoryIngestEffects.readLegacyTwin!(
      syntheticEvent(31, "post.created"),
      "agent:chunk"
    );
    expect(twin).toEqual({
      state: "unverifiable",
      reason: expect.stringContaining("external vector provider"),
    });
  });
});

describe("the verdict function", () => {
  const legacy = { a: 1, nested: { b: "two", c: null } };

  it("reports a changed value by its dotted path, with both sides", () => {
    const stamp = stampShadowComparison(
      { state: "row", payload: legacy },
      { a: 1, nested: { b: "THREE", c: null } }
    );
    expect(stamp.legacyMatch).toBe("payload_mismatch");
    expect(stamp.legacyDetail?.paths).toEqual(["nested.b"]);
    expect(stamp.legacyDetail?.differences).toEqual([
      { path: "nested.b", shadow: "THREE", legacy: "two" },
    ]);
  });

  it("reports a DROPPED key, which a containment check would pass vacuously", () => {
    const stamp = stampShadowComparison({ state: "row", payload: legacy }, { a: 1, nested: { c: null } });
    expect(stamp.legacyMatch).toBe("payload_mismatch");
    expect(stamp.legacyDetail?.paths).toEqual(["nested.b"]);
  });

  it("reports an ADDED key too — the shadow side is not allowed to invent one", () => {
    const stamp = stampShadowComparison(
      { state: "row", payload: legacy },
      { a: 1, extra: true, nested: { b: "two", c: null } }
    );
    expect(stamp.legacyDetail?.paths).toEqual(["extra"]);
  });

  it("turns a thrown comparison into data rather than an outage", () => {
    expect(compareErrorStamp(new Error("connection reset"))).toEqual({
      legacyMatch: "compare_error",
      legacyDetail: { message: "Error: connection reset" },
    });
  });
});
