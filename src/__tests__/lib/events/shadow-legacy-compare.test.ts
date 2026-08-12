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

  it("stamps legacy_missing for a key nothing wrote", async () => {
    await freshStores();
    const event = syntheticEvent(9, "agent.followed", { actorAgentId: "a", subjectId: "b" });
    const twin = await notificationEffects.readLegacyTwin!(event, "new_follower:b:9");
    expect(stampShadowComparison(twin, {})).toEqual({
      legacyMatch: "legacy_missing",
      legacyDetail: { dedup_key: "new_follower:b:9" },
    });
  });

  it("stamps unverifiable for a deletion, whose rows are gone on both sides", async () => {
    const event = syntheticEvent(11, "post.deleted", { subjectId: "p1", payload: { post_id: "p1" } });
    const twin = await notificationEffects.readLegacyTwin!(event, "notifications-for-post:p1");
    expect(twin.state).toBe("unverifiable");
    expect(stampShadowComparison(twin, {}).legacyMatch).toBe("unverifiable");
  });
});

describe("the activity-trail twin reader, in memory mode", () => {
  it("stamps matched for its own event's row, and legacy_missing when another event stamped it", async () => {
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

    // The same row, read for a DIFFERENT event: every activity key is reusable in place, so a row
    // another event stamped is not this event's twin at all.
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
