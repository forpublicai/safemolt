/**
 * M11-2 u1 — the kind vocabulary, the memory-mode log, and the contract hash.
 *
 * Memory mode is the pinned Jest path, so this file is where the no-DB half of the substrate is
 * held: the append discipline Decision 4 requires, the bound that stands in for db-mode retention,
 * and the hash the deployment-version barrier reads. The db half — drain, receipts, floor, dead
 * letters — is `src/__tests__/integration/m11-2-u1-*.test.ts`; none of it can be shown with a mock.
 *
 * @jest-environment node
 */
import { computeConsumerContractHash } from "@/lib/events/consumer-contract";
import { eventConsumers } from "@/lib/events/consumers/registry";
import {
  EVENT_KINDS,
  isKnownEventKind,
  type EventKind,
  type PreparedEvent,
  type PreparedEventOf,
} from "@/lib/events/kinds";
import { EVENT_LOG_CAP, eventLog } from "@/lib/store/_memory-state";
import { emitEvent, getEventById, listEventsAfter } from "@/lib/store/events/memory";

function resetLog(): void {
  eventLog.rows.length = 0;
  eventLog.nextId = 1;
}

const fence = (consumer: string): PreparedEvent<"system.activation_fence"> => ({
  kind: "system.activation_fence",
  payload: { consumer },
});

beforeEach(resetLog);
afterAll(resetLog);

describe("kind vocabulary", () => {
  /**
   * The compile-time half of the gate. `satisfies Record<EventKind, true>` fails to compile the
   * moment a kind is added to `EventPayloadMap` without being listed, which is what makes
   * `EVENT_KINDS` — and therefore the drain's skip-unknown backstop — exhaustive rather than
   * hand-maintained.
   */
  const COVERAGE = {
    "system.activation_fence": true,
    "post.created": true,
    "post.deleted": true,
    "post.pinned": true,
    "post.unpinned": true,
    "post.voted": true,
    "comment.created": true,
    "comment.voted": true,
    "agent.followed": true,
    "agent.unfollowed": true,
    "group.created": true,
    "group.joined": true,
    "group.left": true,
    "group.settings_updated": true,
    "group.moderator_added": true,
    "group.moderator_removed": true,
    "group.subscribed": true,
    "group.unsubscribed": true,
    "playground.session_created": true,
    "playground.session_joined": true,
    "playground.participant_affiliation_updated": true,
    "playground.action_submitted": true,
    "playground.session_completed": true,
    "playground.session_cancelled": true,
    "playground.session_expired": true,
    "evaluation.registered": true,
    "evaluation.started": true,
    "evaluation.session_message": true,
    "evaluation.proctor_claimed": true,
    "evaluation.completed": true,
    "agent.registered": true,
    "agent.registration_expired": true,
    "agent.claimed": true,
    "agent.vetting_started": true,
    "agent.vetted": true,
  } satisfies Record<EventKind, true>;

  it("ships the substrate kind plus trains a1 and a2's groups, playground, evaluations and lifecycle, and the runtime list matches the type union", () => {
    expect(Object.keys(COVERAGE).sort()).toEqual([...EVENT_KINDS].sort());
    expect([...EVENT_KINDS].sort()).toEqual([
      // Train a2's agent-lifecycle family, added by u3e (P1.4) with all three manifests. Every one
      // of them is history-only on every consumer.
      "agent.claimed",
      "agent.followed",
      "agent.registered",
      "agent.registration_expired",
      "agent.unfollowed",
      "agent.vetted",
      "agent.vetting_started",
      "comment.created",
      "comment.voted",
      // Train a2's evaluation family, added by u3e. `evaluation.completed` is the only one with a
      // legacy inline writer, and it enters at `legacy` rather than `shadow` — see
      // `consumers/coverage.ts` for the recorded deviation.
      "evaluation.completed",
      "evaluation.proctor_claimed",
      "evaluation.registered",
      "evaluation.session_message",
      "evaluation.started",
      // Train a2's first family, added by u3c (P1.3) together with all three coverage manifests.
      "group.created",
      "group.joined",
      "group.left",
      "group.moderator_added",
      "group.moderator_removed",
      "group.settings_updated",
      "group.subscribed",
      "group.unsubscribed",
      // Train a2's playground family, added by u3d (P1.4) with all three manifests. `round_opened`
      // and `round_resolved` are deliberately NOT here: the first is a4's and the second belongs to
      // the round-resolution CAS, which u3d does not migrate — and a kind may not enter the union
      // before every consumer has an entry for it.
      "playground.action_submitted",
      "playground.participant_affiliation_updated",
      "playground.session_cancelled",
      "playground.session_completed",
      "playground.session_created",
      "playground.session_expired",
      "playground.session_joined",
      "post.created",
      "post.deleted",
      "post.pinned",
      "post.unpinned",
      "post.voted",
      "system.activation_fence",
    ]);
  });

  it("narrows a known kind and refuses everything else", () => {
    expect(isKnownEventKind("system.activation_fence")).toBe(true);
    expect(isKnownEventKind("post.created")).toBe(true);
    // A kind that lands with its own consumer coverage in a later train. Unknown today means "skip
    // without a receipt", never "handled" — which is what keeps a mixed-version rollout lossless.
    expect(isKnownEventKind("playground.round_opened")).toBe(false);
    expect(isKnownEventKind("")).toBe(false);
  });

  it("types a payload per kind", () => {
    const prepared: PreparedEvent<"system.activation_fence"> = fence("notifications");
    expect(prepared.payload.consumer).toBe("notifications");
  });

  /**
   * The correlation, exercised where it can actually break.
   *
   * With one kind in the union, `{ kind: K; payload: Map[K] }` and the distributed form are
   * indistinguishable. With two, the naive form collapses to `{ kind: A | B; payload: PA | PB }`
   * and cheerfully accepts kind A carrying B's payload — the payload contract would be decoration,
   * and nothing would notice until a consumer read a field that was never there. So the real
   * construction is applied to a SYNTHETIC two-kind map: adding a fake kind to the shipped union
   * would defeat the skip-unknown-without-receipt backstop this milestone depends on.
   */
  it("refuses one kind carrying another kind's payload", () => {
    interface SyntheticPayloadMap {
      "synthetic.alpha": { alpha: number };
      "synthetic.beta": { beta: string };
    }
    type SyntheticPrepared = PreparedEventOf<SyntheticPayloadMap>;

    const alpha: SyntheticPrepared = { kind: "synthetic.alpha", payload: { alpha: 1 } };
    const beta: SyntheticPrepared = { kind: "synthetic.beta", payload: { beta: "b" } };
    // @ts-expect-error — the payload belongs to the other kind. `npx tsc --noEmit` fails if this
    // line ever stops being an error, which is the whole assertion.
    const crossed: SyntheticPrepared = { kind: "synthetic.alpha", payload: { beta: "b" } };

    expect([alpha.kind, beta.kind, crossed.kind]).toEqual([
      "synthetic.alpha",
      "synthetic.beta",
      "synthetic.alpha",
    ]);
  });
});

describe("memory event log", () => {
  it("emits, reads by id, and lists after a cursor in id order", async () => {
    const first = await emitEvent(fence("a"));
    const second = await emitEvent(fence("b"));
    const third = await emitEvent(fence("c"));

    expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
    expect(await getEventById(second.id)).toMatchObject({
      id: 2,
      kind: "system.activation_fence",
      payload: { consumer: "b" },
    });
    expect(await getEventById(999)).toBeNull();

    const after = await listEventsAfter(first.id);
    expect(after.map((event) => event.id)).toEqual([2, 3]);
  });

  it("treats an empty kind filter as no filter, and honours a real one", async () => {
    await emitEvent(fence("a"));
    expect((await listEventsAfter(0, [])).length).toBe(1);
    expect((await listEventsAfter(0, ["system.activation_fence"])).length).toBe(1);
    expect((await listEventsAfter(0, ["post.created"])).length).toBe(0);
  });

  it("caps the list and applies the caller's limit", async () => {
    await emitEvent(fence("a"));
    await emitEvent(fence("b"));
    expect((await listEventsAfter(0, undefined, 1)).map((e) => e.id)).toEqual([1]);
  });

  /**
   * Decision 4: validation is the throwing part and it runs FIRST, so a refused event leaves the
   * log untouched. Emitting a kind this build does not know would also wedge every consumer's scan
   * floor, since an unknown kind is skipped without a receipt.
   */
  it("refuses an unknown kind and appends nothing", async () => {
    // Cast at the whole-event level: `PreparedEvent` correlates each kind with ITS payload, so a
    // bare `kind` cast no longer type-checks against a distributed union — which is the payload
    // contract working, not a problem with the fixture.
    await expect(
      emitEvent({ kind: "not.a.kind", payload: {} } as unknown as PreparedEvent)
    ).rejects.toThrow(/unknown kind/);
    expect(eventLog.rows).toHaveLength(0);
  });

  /**
   * The append is a plain push with no `await` in front of it, so it is visible before the promise
   * settles. That is what lets a memory-mode mutation and its event be observed together: no
   * interleaved promise can see the mutation without the event.
   */
  it("appends synchronously, before the returned promise settles", async () => {
    const pending = emitEvent(fence("sync"));
    expect(eventLog.rows.map((event) => event.payload.consumer)).toEqual(["sync"]);
    await pending;
  });

  /**
   * The log is history. A caller that kept a reference to what it emitted — or to what it read —
   * could otherwise rewrite an event after the fact, and in memory mode that IS the database.
   * The db store cannot be edited this way, so a memory store that could would let a test pass
   * against semantics production does not have.
   */
  it("stores and returns copies, never the caller's object", async () => {
    const payload = { consumer: "original" };
    const { id } = await emitEvent({ kind: "system.activation_fence", payload });

    payload.consumer = "mutated-after-emit";
    expect((await getEventById(id))?.payload).toEqual({ consumer: "original" });

    const read = await getEventById(id);
    (read as { payload: Record<string, unknown> }).payload.consumer = "mutated-after-read";
    expect((await getEventById(id))?.payload).toEqual({ consumer: "original" });

    const listed = await listEventsAfter(0);
    (listed[0] as { payload: Record<string, unknown> }).payload.consumer = "mutated-after-list";
    expect((await getEventById(id))?.payload).toEqual({ consumer: "original" });
  });

  /**
   * The clone is a JSON round-trip, not `structuredClone`, and the difference is observable: the db
   * store serializes with `JSON.stringify` and reads JSONB back, so a `Date` becomes a string and
   * an `undefined` member disappears. Memory mode has to answer what Postgres would answer.
   */
  it("normalizes a payload the way JSONB does", async () => {
    const { id } = await emitEvent({
      kind: "system.activation_fence",
      payload: { consumer: "json", when: new Date(0), missing: undefined } as never,
    });

    expect((await getEventById(id))?.payload).toEqual({
      consumer: "json",
      when: "1970-01-01T00:00:00.000Z",
    });
  });

  /**
   * The memory stand-in for `idx_events_idem`. A producer stamping a deterministic key relies on
   * the second write being refused; db mode refuses it with 23505, and memory mode has to agree or
   * a retry that is idempotent in production duplicates in the suite that is supposed to prove it.
   * The refusal is validation, so it happens before the append and the log is left untouched.
   */
  it("refuses a duplicate idem_key without appending, and leaves NULL keys unconstrained", async () => {
    const withKey = { kind: "system.activation_fence" as const, idemKey: "k1", payload: { consumer: "a" } };
    await emitEvent(withKey);

    await expect(emitEvent(withKey)).rejects.toMatchObject({ code: "23505" });
    expect(eventLog.rows).toHaveLength(1);

    await emitEvent(fence("no-key-1"));
    await emitEvent(fence("no-key-2"));
    expect(eventLog.rows).toHaveLength(3);
  });

  it("drops the oldest row past the cap, and never reissues its id", async () => {
    for (let i = 0; i < EVENT_LOG_CAP + 1; i += 1) await emitEvent(fence(`c${i}`));

    expect(eventLog.rows).toHaveLength(EVENT_LOG_CAP);
    expect(eventLog.rows[0].id).toBe(2);
    expect(eventLog.rows[eventLog.rows.length - 1].id).toBe(EVENT_LOG_CAP + 1);
    expect(await getEventById(1)).toBeNull();
  });
});

describe("consumer contract hash", () => {
  it("is deterministic and independent of declaration order", () => {
    const a = computeConsumerContractHash(
      ["b.kind", "a.kind"],
      [
        { name: "activity", coverage: [["b.kind", "on"], ["a.kind", "legacy"]] },
        { name: "notifications", coverage: [["a.kind", "shadow"]] },
      ]
    );
    const b = computeConsumerContractHash(
      ["a.kind", "b.kind"],
      [
        { name: "notifications", coverage: [["a.kind", "shadow"]] },
        { name: "activity", coverage: [["a.kind", "legacy"], ["b.kind", "on"]] },
      ]
    );

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The barrier is only worth running if the hash MOVES when the contract does. Both inputs are
   * checked: a kind entering the union, and a consumer's coverage state changing — the second is
   * the case P5.1's effect expansion depends on, where the kind set is unchanged.
   */
  it("changes when the union changes and when a coverage state changes", () => {
    const base = computeConsumerContractHash(["a.kind"], [{ name: "activity", coverage: [["a.kind", "legacy"]] }]);
    const widerUnion = computeConsumerContractHash(
      ["a.kind", "b.kind"],
      [{ name: "activity", coverage: [["a.kind", "legacy"]] }]
    );
    const flipped = computeConsumerContractHash(["a.kind"], [{ name: "activity", coverage: [["a.kind", "on"]] }]);

    expect(widerUnion).not.toBe(base);
    expect(flipped).not.toBe(base);
  });

  it("defaults to the build's real union and registry", () => {
    expect(eventConsumers.map((consumer) => consumer.name)).toEqual([
      "notifications",
      "activity-trail",
      "memory-ingest",
    ]);
    expect(computeConsumerContractHash()).toBe(
      computeConsumerContractHash(
        [...EVENT_KINDS],
        eventConsumers.map((consumer) => ({
          name: consumer.name,
          coverage: Object.entries(consumer.coverage),
        }))
      )
    );
  });
});
