/**
 * M11-2 u2 — the coverage manifests and the barrier signal they feed.
 *
 * `satisfies Record<EventKind, CoverageState>` already makes an unmapped kind a compile error. This
 * file is the runtime half of that guarantee plus the two rules the compiler cannot state: a
 * `legacy` (or `shadow`) entry must name a real inline writer, and `system.activation_fence` must
 * be `none` everywhere. Both are configuration errors that would otherwise surface as a silently
 * dead consumer in production.
 *
 * @jest-environment node
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { computeConsumerContractHash, type ConsumerContractInput } from "@/lib/events/consumer-contract";
import {
  DECLARED_LEGACY_WRITERS,
  DELETION_KINDS,
  OCCURRED_AT_STAMP_PENDING_KINDS,
  activityTrailCoverage,
  memoryIngestCoverage,
  notificationsCoverage,
  wakeupRouterCoverage,
  type CoverageState,
} from "@/lib/events/consumers/coverage";
import { eventConsumers } from "@/lib/events/consumers/registry";
import { EVENT_KINDS } from "@/lib/events/kinds";
import type { StoredEvent } from "@/lib/store-types";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const STATES: CoverageState[] = ["legacy", "shadow", "on", "none"];

function realContractInputs(): ConsumerContractInput[] {
  return eventConsumers.map((consumer) => ({
    name: consumer.name,
    coverage: Object.entries(consumer.coverage),
  }));
}

describe("coverage manifests", () => {
  /**
   * The three a1 consumers, plus a4's wakeup router (M11-2 P3.2, lane C).
   *
   * The router is APPENDED: order matters only in memory mode's sequential dispatch, and nothing
   * about a wakeup needs deciding before a projection is written. It is the first consumer whose
   * manifest carries no `legacy` and no `shadow` — its projection is born in the consumer.
   */
  it("registers the three a1 consumers and the a4 wakeup router, in dispatch order", () => {
    expect(eventConsumers.map((consumer) => consumer.name)).toEqual([
      "notifications",
      "activity-trail",
      "memory-ingest",
      "wakeup-router",
    ]);
  });

  /**
   * The runtime double-check of the compile-time guarantee.
   *
   * It is not redundant: `satisfies` binds the checked-in object literal, and the drain dispatches
   * on a `kind` string read from a JSONB row. A kind that reached `EVENT_KINDS` without reaching a
   * manifest would be receipted with no effect and no inline writer — permanently swallowing the
   * first events of that kind in any mixed-version window.
   */
  it.each(eventConsumers.map((consumer) => [consumer.name, consumer] as const))(
    "%s maps every union kind to a real state",
    (_name, consumer) => {
      expect(Object.keys(consumer.coverage).sort()).toEqual([...EVENT_KINDS].sort());
      for (const state of Object.values(consumer.coverage)) {
        expect(STATES).toContain(state);
      }
    }
  );

  /**
   * `legacy` means "that kind's declared inline writer still owns the projection". A `legacy` entry
   * with nothing behind it is a consumer that has been switched off and a projection nobody writes.
   * `shadow` carries the same requirement for a stronger reason: shadow writes only the comparison
   * row, so without a legacy writer the feature would run dead through the whole soak.
   */
  it.each(eventConsumers.map((consumer) => [consumer.name, consumer] as const))(
    "%s declares an inline writer for every legacy or shadow kind",
    (name, consumer) => {
      const declared: Partial<
        Record<string, readonly { file: string; pattern: string; count: number }[]>
      > = DECLARED_LEGACY_WRITERS[name] ?? {};
      const problems: string[] = [];
      for (const [kind, state] of Object.entries(consumer.coverage)) {
        const anchors = declared[kind];
        if ((state === "legacy" || state === "shadow") && (anchors?.length ?? 0) === 0) {
          problems.push(`${name}/${kind} is '${state}' with no declared inline writer`);
        }
        // `none` is history-only BY POLICY — receipted deliberately with no effect anywhere. A
        // declared inline writer would contradict that, and would mean a real projection nothing
        // will ever migrate. (`on` may legitimately still have one: the dual-write phase keeps the
        // inline writer for exactly one deploy after the flip.)
        if (state === "none" && anchors?.length) {
          problems.push(
            `${name}/${kind} is 'none' but declares ${anchors.map((a) => a.file).join(", ")}`
          );
        }
      }
      expect(problems).toEqual([]);
    }
  );

  /**
   * The anchors are re-verified against the tree — the FILE, the INVOCATION, and how many.
   *
   * Checking the path proves nothing (every one of these files exists for other reasons) and a bare
   * substring proves little more, because a comment mentioning the writer satisfies it — which is
   * exactly what u4 leaves behind when it deletes the call. So the pattern matches call syntax or
   * the SQL verb of a prepared writer, and the count is pinned: deleting one of two invocations must
   * fail as loudly as deleting both.
   *
   * Every writer is listed, **db side and memory side**: both stores carry these projections, and a
   * manifest that pinned only the db writer would keep saying `legacy` after u4 deleted the memory
   * one — leaving Jest's projections to nobody while production's still had an owner.
   *
   * **u4 decrements these counts as it deletes each inline writer**, and a kind whose anchors all
   * reach zero must leave `legacy` in the same change — which is the coupling this test exists for.
   */
  it("points every declared writer at the invocations it claims, and counts them", () => {
    const problems: string[] = [];
    for (const [consumer, kinds] of Object.entries(DECLARED_LEGACY_WRITERS)) {
      for (const [kind, anchors] of Object.entries(kinds)) {
        for (const anchor of anchors ?? []) {
          const path = join(REPO_ROOT, anchor.file);
          if (!existsSync(path)) {
            problems.push(`${consumer}/${kind} -> ${anchor.file} (file missing)`);
            continue;
          }
          const found = readFileSync(path, "utf8").match(new RegExp(anchor.pattern, "g"))?.length ?? 0;
          if (found !== anchor.count) {
            problems.push(
              `${consumer}/${kind} -> ${anchor.file}: expected ${anchor.count} invocation(s) of ` +
                `/${anchor.pattern}/, found ${found}`
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  /**
   * Deletion kinds describe KEYS ONLY, because a canonical payload cannot exist for rows that no
   * longer do — so the soak verifies them by key set and by the both-orders convergence gates.
   * A describe that started returning a projection would silently change what verification means.
   */
  it("keeps every deletion kind key-only in every consumer's describe", async () => {
    const { memoryIngestEffects } = await import("@/lib/events/consumers/memory-ingest");
    const { activityTrailEffects } = await import("@/lib/events/consumers/activity-trail");
    const { notificationEffects } = await import("@/lib/events/consumers/notifications");
    const { wakeupRouterEffects } = await import("@/lib/events/consumers/wakeup-router");

    for (const kind of DELETION_KINDS) {
      const event: StoredEvent = {
        id: 1,
        kind,
        actorAgentId: "a1",
        subjectType: "post",
        subjectId: "p1",
        secondarySubjectId: null,
        schoolId: null,
        idemKey: null,
        payload: {
          post_id: "p1",
          group_id: "g1",
          author_id: "a1",
          commenter_ids: ["c1"],
          comment_ids: ["cm1"],
          audience_agent_ids: ["a1"],
        },
        createdAt: new Date().toISOString(),
      };
      for (const effects of [
        notificationEffects,
        activityTrailEffects,
        memoryIngestEffects,
        wakeupRouterEffects,
      ]) {
        for (const effect of await effects.describe(event)) {
          // Key-only means the payload carries the operation and the identifiers it keyed on, and
          // never a projection: no rendered content can be produced for a row that is gone.
          expect(effect.payload.operation).toBe("delete");
          expect(Object.keys(effect.payload).sort()).not.toContain("title");
          expect(Object.keys(effect.payload).sort()).not.toContain("summary");
        }
      }
    }
  });

  /**
   * The u3 obligation, enforced rather than merely written down.
   *
   * These kinds project `occurred_at` from the event row while the legacy writers stamp their own
   * clock, so a `shadow` soak would mismatch on the trail's ordering key for every one of their
   * events. They may not enter `shadow` until P1.2's transitional writers stamp the event's
   * `created_at` into `occurred_at` — at which point this assertion is what has to be relaxed, in
   * the same change, deliberately.
   */
  it("keeps the occurred-at-pending kinds out of shadow", () => {
    for (const consumer of eventConsumers) {
      for (const kind of OCCURRED_AT_STAMP_PENDING_KINDS) {
        expect(`${consumer.name}/${kind}=${consumer.coverage[kind]}`).not.toBe(
          `${consumer.name}/${kind}=shadow`
        );
      }
    }
  });

  it("keeps the activation fence history-only in every manifest", () => {
    for (const consumer of eventConsumers) {
      expect(consumer.coverage["system.activation_fence"]).toBe("none");
    }
  });

  /**
   * The shipped state table, pinned.
   *
   * u2 shipped every migrated kind at `legacy` because it landed one deploy before any producer
   * emitted. u3 added the post producers and moved the post kinds to `shadow` in the same deploy;
   * **u3b (P1.2) does the same for the comment and follow kinds**, whose producers ship with it —
   * Protocol M step 1, and the Scope rule that shadow rides its producer. Every migrated a1 kind is
   * therefore soaking, and nothing is left at `legacy`. A diff on this assertion is a cutover, and
   * cutovers are reviewed.
   *
   * **u3c (P1.3) adds train a2's first family**, the eight group kinds. Exactly one of them has a
   * legacy writer to shadow against — `group.joined`, on the activity trail — and it enters
   * `shadow` in the same deploy as its producer. The other seven are history-only in all three
   * manifests: `none`, never `legacy`, because `legacy` claims an inline writer that does not exist.
   *
   * **u3d (P1.4) adds a2's playground family**, seven kinds sharing two projections on the activity
   * trail — six write the session's row, one writes the action's — so all seven enter `shadow` with
   * their producers. The one `legacy` entry in the whole table is `memory-ingest` /
   * `playground.action_submitted`: its producer ships here but the ingest consumer has no playground
   * fan-out planner yet, and `shadow` without one would describe an empty effect set for every
   * action and read clean while proving nothing. That is a recorded deviation from Protocol M
   * step 1, and it is checkable — the declared writer below still names the surviving scheduler.
   *
   * **u3e (P1.4) adds a2's evaluation and agent-lifecycle families** — ten kinds, nine of them
   * history-only on every consumer. The tenth, `evaluation.completed`, has four declared inline
   * writers (two producers × two stores) and enters at `legacy` rather than `shadow`: its trail
   * projections are written by statements that CANNOT read the event id their sibling produced —
   * one is a batch element of D4's completion transaction, the other runs after `completeVetting`'s
   * batch commits — so neither can stamp `source_event_id`, and a soak with nothing to order the
   * two writers by would compare noise. That is the second recorded deviation from Protocol M
   * step 1, checkable the same way: the declared writers below name all four invocations.
   *
   * **P3.2 deploy 1 adds train a4's `playground.round_opened`, and it is the table's first and only
   * `on` entry.** Protocol M does not apply to it: nothing writes a round-open notification inline
   * today, so there is no legacy writer to shadow against and `legacy` would claim one that does not
   * exist. A kind whose projection is BORN in the consumer starts `on` — and it starts there one
   * deploy before any producer emits, which is the new-kind protocol's whole point. It must NOT
   * appear in `DECLARED_LEGACY_WRITERS`; the `none`/`legacy` rules above already enforce that from
   * the other direction.
   */
  it("ships the u3e state table, plus a4's new kind", () => {
    expect(notificationsCoverage).toEqual({
      "system.activation_fence": "none",
      "post.created": "none",
      "post.deleted": "shadow",
      "post.pinned": "none",
      "post.unpinned": "none",
      "post.voted": "none",
      "comment.created": "shadow",
      "comment.voted": "none",
      "agent.followed": "shadow",
      "agent.unfollowed": "none",
      "group.created": "none",
      "group.joined": "none",
      "group.left": "none",
      "group.settings_updated": "none",
      "group.moderator_added": "none",
      "group.moderator_removed": "none",
      "group.subscribed": "none",
      "group.unsubscribed": "none",
      // Nothing notifies on any other playground mutation.
      "playground.session_created": "none",
      "playground.session_joined": "none",
      "playground.participant_affiliation_updated": "none",
      // The one `on` entry in the whole table — a4's new kind, born in the consumer with no inline
      // writer to cut over from. See this test's header.
      "playground.round_opened": "on",
      "playground.action_submitted": "none",
      "playground.session_completed": "none",
      "playground.session_cancelled": "none",
      "playground.session_expired": "none",
      // Nothing notifies on an evaluation or a lifecycle transition today: the 3-type union has no
      // member for one and no inline writer produces one.
      "evaluation.registered": "none",
      "evaluation.started": "none",
      "evaluation.session_message": "none",
      "evaluation.proctor_claimed": "none",
      "evaluation.completed": "none",
      "agent.registered": "none",
      "agent.registration_expired": "none",
      "agent.claimed": "none",
      "agent.vetting_started": "none",
      "agent.vetted": "none",
      // u3f's eleven kinds: history-only everywhere — no consumer effect and no legacy writer.
      "agent.profile_updated": "none",
      "memory.context_written": "none",
      "memory.context_deleted": "none",
      "class.enrolled": "none",
      "class.dropped": "none",
      "class.session_message": "none",
      "class.evaluation_submitted": "none",
      "admissions.application_submitted": "none",
      "admissions.offer_accepted": "none",
      "admissions.offer_declined": "none",
      "admissions.offer_expired": "none",
      "agent_loop.action": "none",
    });
    expect(activityTrailCoverage).toEqual({
      "system.activation_fence": "none",
      "post.created": "shadow",
      "post.deleted": "shadow",
      "post.pinned": "none",
      "post.unpinned": "none",
      "post.voted": "none",
      "comment.created": "shadow",
      "comment.voted": "none",
      "agent.followed": "shadow",
      "agent.unfollowed": "none",
      // The one group kind with a legacy inline writer, soaking against it from this deploy.
      "group.joined": "shadow",
      "group.created": "none",
      "group.left": "none",
      "group.settings_updated": "none",
      "group.moderator_added": "none",
      "group.moderator_removed": "none",
      "group.subscribed": "none",
      "group.unsubscribed": "none",
      // Six kinds, one session projection; the seventh keys on the action row. Cancellation and
      // expiry are UPSERTS, not deletions — since M11-1 C3 neither store deletes the session.
      "playground.session_created": "shadow",
      "playground.session_joined": "shadow",
      "playground.participant_affiliation_updated": "shadow",
      // No trail row per round (Decision 5): the session's own row already moves.
      "playground.round_opened": "none",
      "playground.action_submitted": "shadow",
      "playground.session_completed": "shadow",
      "playground.session_cancelled": "shadow",
      "playground.session_expired": "shadow",
      // The second `legacy` entry in the table — see this test's header for why, and for what has
      // to happen before it becomes `shadow`.
      "evaluation.completed": "legacy",
      "evaluation.registered": "none",
      "evaluation.started": "none",
      "evaluation.session_message": "none",
      "evaluation.proctor_claimed": "none",
      "agent.registered": "none",
      "agent.registration_expired": "none",
      "agent.claimed": "none",
      "agent.vetting_started": "none",
      "agent.vetted": "none",
      // u3f's eleven kinds: history-only everywhere — no consumer effect and no legacy writer.
      "agent.profile_updated": "none",
      "memory.context_written": "none",
      "memory.context_deleted": "none",
      "class.enrolled": "none",
      "class.dropped": "none",
      "class.session_message": "none",
      "class.evaluation_submitted": "none",
      "admissions.application_submitted": "none",
      "admissions.offer_accepted": "none",
      "admissions.offer_declined": "none",
      "admissions.offer_expired": "none",
      "agent_loop.action": "shadow",
    });
    expect(memoryIngestCoverage).toEqual({
      "system.activation_fence": "none",
      "post.created": "shadow",
      "post.deleted": "shadow",
      "post.pinned": "none",
      "post.unpinned": "none",
      "post.voted": "none",
      "comment.created": "shadow",
      "comment.voted": "none",
      // Follows have no legacy ingest effect at all, so `none` rather than `legacy`.
      "agent.followed": "none",
      "agent.unfollowed": "none",
      "group.created": "none",
      "group.joined": "none",
      "group.left": "none",
      "group.settings_updated": "none",
      "group.moderator_added": "none",
      "group.moderator_removed": "none",
      "group.subscribed": "none",
      "group.unsubscribed": "none",
      // A `legacy` entry — see this test's header for why, and for what has to happen before it
      // becomes `shadow`.
      "playground.action_submitted": "legacy",
      // Ingest rides what participants DID, not the prompt that opened the round.
      "playground.round_opened": "none",
      "playground.session_created": "none",
      "playground.session_joined": "none",
      "playground.participant_affiliation_updated": "none",
      "playground.session_completed": "none",
      "playground.session_cancelled": "none",
      "playground.session_expired": "none",
      // Evaluations and lifecycle transitions schedule no memory ingest anywhere.
      "evaluation.registered": "none",
      "evaluation.started": "none",
      "evaluation.session_message": "none",
      "evaluation.proctor_claimed": "none",
      "evaluation.completed": "none",
      "agent.registered": "none",
      "agent.registration_expired": "none",
      "agent.claimed": "none",
      "agent.vetting_started": "none",
      "agent.vetted": "none",
      // u3f's eleven kinds: history-only everywhere — no consumer effect and no legacy writer.
      "agent.profile_updated": "none",
      "memory.context_written": "none",
      "memory.context_deleted": "none",
      "class.enrolled": "none",
      "class.dropped": "none",
      "class.session_message": "none",
      "class.evaluation_submitted": "none",
      "admissions.application_submitted": "none",
      "admissions.offer_accepted": "none",
      "admissions.offer_declined": "none",
      "admissions.offer_expired": "none",
      "agent_loop.action": "none",
    });
  });

  /**
   * The fourth manifest, pinned separately — **it is the only one with no `legacy` and no `shadow`
   * anywhere, and that is structural rather than incidental.**
   *
   * Protocol M cuts a projection over from an inline writer; the wakeup queue has none, in either
   * store, because it is new in this deploy. So every entry is `on` or `none`, and the consumer must
   * NOT appear in `DECLARED_LEGACY_WRITERS` — the `none`-with-a-declared-writer rule above already
   * fails it from the other direction.
   *
   * Two kinds route, and the shortfall against P3.2's prose is the KIND UNION's doing: the plan also
   * describes `agent.mentioned` (with mention suppression) and `dm.sent`, and neither kind exists in
   * this build — they belong to a later train (P6.1 / b2). There is no producer, no payload and
   * nothing to suppress against. `agent.followed` routes to nothing on purpose, which is what the
   * plan says too.
   */
  it("ships the a4 wakeup-router manifest, on for exactly two kinds", () => {
    expect(wakeupRouterCoverage).toEqual({
      "system.activation_fence": "none",
      "post.created": "none",
      "post.deleted": "none",
      "post.pinned": "none",
      "post.unpinned": "none",
      "post.voted": "none",
      // A comment on your post, or a reply to your comment, is a reason to check in.
      "comment.created": "on",
      "comment.voted": "none",
      // A new follower asks nothing of the followee.
      "agent.followed": "none",
      "agent.unfollowed": "none",
      "group.created": "none",
      "group.joined": "none",
      "group.left": "none",
      "group.settings_updated": "none",
      "group.moderator_added": "none",
      "group.moderator_removed": "none",
      "group.subscribed": "none",
      "group.unsubscribed": "none",
      "playground.session_created": "none",
      "playground.session_joined": "none",
      "playground.participant_affiliation_updated": "none",
      // The one kind an agent genuinely owes a turn to.
      "playground.round_opened": "on",
      // The action IS the turn.
      "playground.action_submitted": "none",
      "playground.session_completed": "none",
      "playground.session_cancelled": "none",
      "playground.session_expired": "none",
      "evaluation.registered": "none",
      "evaluation.started": "none",
      "evaluation.session_message": "none",
      "evaluation.proctor_claimed": "none",
      "evaluation.completed": "none",
      "agent.registered": "none",
      "agent.registration_expired": "none",
      "agent.claimed": "none",
      "agent.vetting_started": "none",
      "agent.vetted": "none",
      "agent.profile_updated": "none",
      "memory.context_written": "none",
      "memory.context_deleted": "none",
      "class.enrolled": "none",
      "class.dropped": "none",
      "class.session_message": "none",
      "class.evaluation_submitted": "none",
      "admissions.application_submitted": "none",
      "admissions.offer_accepted": "none",
      "admissions.offer_declined": "none",
      "admissions.offer_expired": "none",
      "agent_loop.action": "none",
    });
    // No `legacy`, no `shadow` — the structural claim, asserted rather than merely written down.
    expect(Object.values(wakeupRouterCoverage).filter((state) => state !== "on" && state !== "none"))
      .toEqual([]);
    expect(DECLARED_LEGACY_WRITERS["wakeup-router"]).toBeUndefined();
  });

  /**
   * The discharge, asserted where the list lives.
   *
   * Each kind left `OCCURRED_AT_STAMP_PENDING_KINDS` in the deploy that flipped it to `shadow`,
   * which is the only order that makes sense: the list exists to keep a kind out of `shadow`.
   * `post.created` went in u3; `comment.created` and `agent.followed` went in u3b, by the two
   * different routes the list allows for (shared subject clock, and a transitional clock stamp).
   * **u3d answered it for the seven playground kinds by `post.created`'s route**: both trail rows
   * project a timestamp their SUBJECT carries — the session's `COALESCE(started_at, completed_at,
   * created_at)` and the action's `created_at` — and the consumer re-reads the same row through the
   * same shared SELECT, so a stamp would have introduced the mismatch rather than removed it.
   *
   * **The list is empty and the assertion stays**, because the next migrated kind with a projected
   * timestamp has to answer the same question and an unasserted empty list would look like the
   * question had gone away.
   */
  it("has no kind left owing the occurred-at obligation", () => {
    expect([...OCCURRED_AT_STAMP_PENDING_KINDS]).toEqual([]);
  });
});

/**
 * The barrier compares CONTRACT IDENTITY, never liveness: an old runtime that is alive and healthy
 * can still receipt an event under an old effect set. So the hash has to move whenever the contract
 * does — and with the real manifests wired in, that now includes a single state flip on a single
 * kind, which is exactly the change every Protocol M step makes.
 */
describe("consumer contract hash over the real manifests", () => {
  it("hashes the manifests, not merely the consumer names", () => {
    const withEmptyManifests = computeConsumerContractHash(
      [...EVENT_KINDS],
      eventConsumers.map((consumer) => ({ name: consumer.name, coverage: [] }))
    );
    expect(computeConsumerContractHash()).not.toBe(withEmptyManifests);
  });

  it("moves when one kind's state flips on one consumer", () => {
    const base = computeConsumerContractHash();
    const flipped = realContractInputs().map((consumer) =>
      consumer.name === "notifications"
        ? {
            name: consumer.name,
            coverage: consumer.coverage.map(([kind, state]) =>
              // Flipped BACKWARDS, to a state the manifest does not currently hold: u3b moved
              // `comment.created` to `shadow`, and a "flip" onto its own value proves nothing.
              kind === "comment.created" ? ([kind, "legacy"] as const) : ([kind, state] as const)
            ),
          }
        : consumer
    );
    expect(computeConsumerContractHash([...EVENT_KINDS], flipped)).not.toBe(base);
  });

  /**
   * The hash must depend on the CONTRACT and on nothing else about how it was written down.
   *
   * Three orderings can vary independently — the kind list, the consumer list, and each consumer's
   * coverage entries — and every one of them is incidental: `Object.entries` order follows insertion
   * order, so a reordered manifest literal or a reordered registry would move the hash and the
   * deployment-version barrier would refuse a deploy whose effect set is identical. Shuffling all
   * three at once is what proves the canonicalization covers each of them.
   */
  it("is invariant under shuffling kinds, consumers and coverage entries", () => {
    const shuffle = <T,>(items: readonly T[], seed: number): T[] => {
      const copy = [...items];
      // Deterministic, so a failure reproduces rather than appearing one run in ten.
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = (i * 7 + seed * 13 + 5) % (i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    };

    const base = computeConsumerContractHash();
    const shuffled = computeConsumerContractHash(
      shuffle(EVENT_KINDS, 1),
      shuffle(realContractInputs(), 2).map((consumer, index) => ({
        name: consumer.name,
        coverage: shuffle(consumer.coverage, index + 3),
      }))
    );
    expect(shuffled).toBe(base);
  });

  it("moves when a kind enters the union", () => {
    // A kind this build does NOT have, deliberately: `round_opened` was the example until P3.2
    // deploy 1 admitted it, and a "new" kind that is already in the union proves nothing about the
    // barrier — it only proves that `canonicalize` does not deduplicate.
    expect(computeConsumerContractHash([...EVENT_KINDS, "playground.round_resolved"], realContractInputs())).not.toBe(
      computeConsumerContractHash()
    );
  });
});
