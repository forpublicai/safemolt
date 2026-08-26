/**
 * M11-2 P2.1 — the checked-in coverage manifests: one per consumer, kind → state.
 *
 * **Cutover state is per (consumer, kind), and changing it is a code change.** A single global
 * consumer mode cannot express the trains: after a1 deletes the post/comment inline writers,
 * dropping a consumer to `shadow` for an a2 kind would stop real a1-kind projections, while `on`
 * without shadow would skip the new kind's verification. So each state lives here, reviewable,
 * versioned, and atomic with the deploy that carries it.
 *
 * **Exhaustive over the build's kind union, never defaulted.** `satisfies Record<EventKind,
 * CoverageState>` makes an unmapped kind a compile error, and
 * `src/__tests__/lib/events/consumer-coverage.test.ts` re-asserts it at runtime — the compiler binds
 * this object literal, while the drain dispatches on a `kind` string read from a JSONB row.
 * An absent-means-`legacy` default is specifically rejected: a build that knew a kind's
 * name but predated its coverage would receipt it with no effect and no inline writer, permanently
 * swallowing the first events of every brand-new kind in any mixed-version window.
 */
import type { EventKind } from "../kinds";

/**
 * What a consumer does with one kind.
 *
 *  - `legacy` — receipt, no effect: that kind's declared inline writer still owns the projection.
 *  - `shadow` — compute the intended effects and record them for comparison, write no projection.
 *  - `on`     — apply the real effect.
 *  - `none`   — history-only by policy: receipted deliberately, because an unreceipted kind wedges
 *               the consumer's scan floor at that id forever.
 */
export type CoverageState = "legacy" | "shadow" | "on" | "none";

export type CoverageManifest = Record<EventKind, CoverageState>;

/**
 * **Deletion kinds are KEY-ONLY in the soak, and their flip precondition is different.**
 *
 * Every other kind's shadow row carries the canonical projection its `apply` would write, and the
 * verification script diffs both the key sets and the payloads. A deletion has no such payload: the
 * rows are gone, so neither side can produce content to compare. Worse, the keys cannot be read from
 * live state either — in the deployed ordering the legacy inline delete commits FIRST and the event
 * drains afterwards, so a consumer that enumerated the removed rows would describe an empty set on
 * every real deletion and the soak would read clean while proving nothing.
 *
 * So `post.deleted` describes KEYS ONLY, derived from the event payload:
 *   - activity-trail: `post:{post_id}` plus `comment:{id}` for each `comment_ids` entry;
 *   - notifications: the predicate-identity key `notifications-for-post:{post_id}`, because the
 *     effect is a predicate over `metadata.post_id` and its rows were never enumerable;
 *   - memory-ingest: `{recipient}:{chunk_id_stem}` per payload audience member per subject, the
 *     chunk INDEX being underivable once the content is gone.
 *
 * **The flip precondition for these kinds is therefore the both-orders convergence gates, not the
 * payload diff.** Consume-then-delete must remove the projection and delete-then-consume must never
 * create it — proven in `src/__tests__/integration/m11-2-u2-consumers.test.ts` and against the
 * legacy writers in `m11-2-u2-legacy-parity.test.ts`.
 */
export const DELETION_KINDS: readonly EventKind[] = ["post.deleted"];

/**
 * **The obligation a kind must discharge before it may enter `shadow`.**
 *
 * A kind listed here projects `occurred_at` from a source the legacy inline writer does not share,
 * so a soak would mismatch on the trail's **ordering key** for every one of its events and the
 * mismatch count would be noise rather than signal. Two things clear a kind from this list, in the
 * same change:
 *
 *  1. **The transitional inline writer agrees with the consumer about the instant**, and stamps
 *     `source_event_id` so the dual-write phase is ordered by which event is newer rather than by
 *     which writer landed last. `emitEventStatement` returns `id, created_at` for exactly this.
 *  2. **The legacy-parity test asserts EXACT `occurred_at` equality** between the two writers
 *     (`m11-2-u2-legacy-parity.test.ts`).
 *
 * **`post.created` was cleared by u3**, and the clearing is not a stamp: both writers project the
 * POST's `created_at` — `postActivitySelectSql` takes it as `v.created_at`, the consumer re-fetches
 * the post and passes the same field — so they already share one clock, and stamping the event's
 * timestamp would have *introduced* the mismatch this list exists to prevent. What u3 did add is
 * `source_event_id`, and the parity test now asserts the `occurred_at` equality outright.
 *
 * **u3b (P1.2) cleared the last two, by the two different routes the list allows for.**
 * `comment.created` went the way `post.created` did — both writers project the COMMENT's own
 * `created_at` (`commentActivitySelectSql` takes it as `v.created_at`, the consumer re-fetches the
 * comment and passes the same field), so they already shared one clock and a stamp would have
 * *introduced* the mismatch; what u3b added there is `source_event_id`, from the event arm inside
 * `createComment`'s own statement. `agent.followed` is the kind that genuinely needed the clock: a
 * follow carries no timestamp anywhere but its event, so `followAgent` now passes the `created_at`
 * its statement returned into the inline writer's `occurred_at`. Both equalities are asserted
 * outright in `m11-2-u2-legacy-parity.test.ts`.
 *
 * **u3c (P1.3) answered the same question for `group.joined`, and took the follow's route.** The db
 * side does carry a per-membership timestamp (`group_members.joined_at`) — but the MEMORY store has
 * none at all: its membership is a list of ids, and `getGroupMembers` approximates every join time
 * with the group's own `created_at`. A consumer that re-fetched the join time would therefore read
 * two different clocks in the two stores, which is the mismatch this list exists to prevent. So the
 * join carries no timestamp the consumer can share, `joinGroup` passes the `created_at` its own
 * statement returned into the inline writer's `occurred_at`, and the equality is asserted outright
 * in `m11-2-u2-legacy-parity.test.ts`.
 *
 * **u3d (P1.4) answered it for the seven playground kinds, and they took `post.created`'s route.**
 * Both playground trail rows project a timestamp their SUBJECT already carries — the session row's
 * `COALESCE(started_at, completed_at, created_at)` and the action row's `created_at` — and the
 * consumer re-reads that same row through the same shared SELECT. So the two writers already share
 * one clock in both stores, and stamping the event's `created_at` would have *introduced* the
 * mismatch this list exists to prevent. What u3d added is `source_event_id`, taken from the event
 * arm of each emitting statement.
 *
 * **The list is empty, and that is a state rather than an absence.** It stays here because the next
 * migrated kind with a projected timestamp has to answer the same question before it may enter
 * `shadow`.
 */
export const OCCURRED_AT_STAMP_PENDING_KINDS: readonly EventKind[] = [];

/**
 * **`shadow` rides its producer's deploy — Protocol M step 1 — and u3 IS that deploy for posts.**
 *
 * u2 shipped every migrated kind at `legacy` because it landed one deploy before any producer
 * emitted: a kind set to `shadow` there would have soaked against nothing at all. u3 adds the
 * producers (`actions/posts.*` and the four post mutations' prepared events), so the two post kinds
 * move to `shadow` **in the same deploy**, which is the Scope rule the execution order states as
 * "each migrated producer deploys together with its legacy → shadow manifest change".
 *
 * **u3b (P1.2) is that deploy for comments and follows**, and moves them the same way: their
 * producers arrive (`actions/comments.*`, `actions/agents.*`, and the prepared events on the comment
 * insert, the two vote statements and the follow statement) together with the manifest change. The
 * vote kinds and `agent.unfollowed` stay `none` — history-only by policy, so no consumer has an
 * effect to shadow.
 *
 * **u3c (P1.3) is that deploy for groups**, and the same rule applies to the one group kind that has
 * a legacy writer: `group.joined` enters `shadow` on activity-trail together with
 * `actions/groups.*` and the prepared events on the eight group mutations. The other seven group
 * kinds are `none` everywhere — history-only by policy.
 *
 * `post.deleted`'s deletion effects follow the same protocol, and the inventory is why: P2.1's prose
 * calls them a new kind that "ships `on` before P1.1's producer deploys", but the tree contradicts
 * it — `deletePost`'s batch already removes the activity rows, the cached contexts and the
 * post-anchored notifications inline (`src/lib/store/posts/db.ts`, elements 4 and 5), and
 * `post-deletion.ts` already cleans the vectors. There IS a legacy writer, so this is **Protocol M**.
 * (`ai/validation/m11-inventory.md` §7, "Plan-prose drift".) Their soak is key-only and their flip
 * precondition is the both-orders convergence gates, per `DELETION_KINDS` above.
 */
export const notificationsCoverage = {
  "system.activation_fence": "none",
  // No notification is produced by post creation today: mentions are P6.1/train b2, and until then
  // a fresh post notifies nobody. `none`, not `legacy` — there is no inline writer to fall back on.
  "post.created": "none",
  "post.deleted": "shadow",
  "post.pinned": "none",
  "post.unpinned": "none",
  "post.voted": "none",
  "comment.created": "shadow",
  "comment.voted": "none",
  "agent.followed": "shadow",
  "agent.unfollowed": "none",
  // Nothing notifies on a group mutation today, on any surface: the 3-type union has no member for
  // one and no inline writer produces one. `none`, not `legacy` — `legacy` claims a writer that
  // does not exist, which is the configuration error the manifest test rejects.
  "group.created": "none",
  "group.joined": "none",
  "group.left": "none",
  "group.settings_updated": "none",
  "group.moderator_added": "none",
  "group.moderator_removed": "none",
  "group.subscribed": "none",
  "group.unsubscribed": "none",
  // Nothing notifies on any OTHER playground mutation: the 3-type union has no member for one, and
  // no inline writer produces one. `none`, never `legacy` — `legacy` claims a writer that does not
  // exist.
  "playground.session_created": "none",
  "playground.session_joined": "none",
  "playground.participant_affiliation_updated": "none",
  /**
   * **`on` at birth — the NEW-KIND protocol, and it is never `shadow`.**
   *
   * Protocol M (`legacy → shadow → on`) exists to cut a projection over from an inline writer to a
   * consumer without a window where both write or neither does. There is no such writer here: no
   * code anywhere produces a round-open notification today, so `shadow` would soak against nothing
   * and `legacy` would claim a writer that does not exist — the configuration error the manifest
   * test rejects. A kind whose projection is born in the consumer starts `on`.
   *
   * **This deploy wires the STATE, not the effect** (P3.2 rollout deploy 1). No producer emits
   * `playground.round_opened` yet — the prompt-storing writes land after the deployment-version
   * barrier — so `plan()` falling through to its `null` default is the correct and reachable
   * behavior for now, and `describe`/`apply` no-op on this kind. The `playground_round_open`
   * projection itself is a later deliverable of this same lane, and it belongs HERE rather than in
   * the router: one owner per projection is what keeps per-kind cutover and retry ownership
   * unambiguous, so the notifications consumer writes the markable row and the router writes only
   * wakeups.
   */
  "playground.round_opened": "on",
  "playground.action_submitted": "none",
  "playground.session_completed": "none",
  "playground.session_cancelled": "none",
  "playground.session_expired": "none",
  // Nothing notifies on an evaluation or a lifecycle transition today: the 3-type union has no
  // member for one and no inline writer produces one. A vetting completion mails nobody, a claim
  // mails the OWNER (through Resend at registration time, not through `notifications`), and a
  // proctor claim is discovered by polling. `none`, never `legacy` — `legacy` claims a writer that
  // does not exist, which is the configuration error the manifest test rejects.
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
} satisfies CoverageManifest;

export const activityTrailCoverage = {
  "system.activation_fence": "none",
  "post.created": "shadow",
  "post.deleted": "shadow",
  // M11 adds no new public activity kinds (Decision 5): pins and votes are history, not trail rows.
  "post.pinned": "none",
  "post.unpinned": "none",
  "post.voted": "none",
  "comment.created": "shadow",
  "comment.voted": "none",
  "agent.followed": "shadow",
  "agent.unfollowed": "none",
  // **u3c (P1.3) is `group.joined`'s producer deploy**, so it enters `shadow` here in the same
  // change — Protocol M step 1, the rule that shadow rides its producer. Its declared inline writer
  // is `recordGroupJoinActivityEvent`, in BOTH stores.
  "group.joined": "shadow",
  // The other seven are history-only: no trail row exists for them today and M11 adds no new public
  // activity kinds (Decision 5). A group's creation, its settings, its moderators and the legacy
  // feed subscription are all invisible on the trail, and that does not change here.
  "group.created": "none",
  "group.left": "none",
  "group.settings_updated": "none",
  "group.moderator_added": "none",
  "group.moderator_removed": "none",
  "group.subscribed": "none",
  "group.unsubscribed": "none",
  // **u3d (P1.4) is the playground producers' deploy**, so every playground kind enters `shadow`
  // here in the same change — Protocol M step 1 again.
  //
  // Six of the seven map to ONE projection: the session's trail row, upserted from the live session
  // (`playground_session:{session_id}`). That is not a simplification of the plan — it is what the
  // legacy writer does: it rebuilds the row from the session on
  // creation, join, affiliation refresh, completion, cancellation and expiry alike, so the title
  // (`{game} {status}`) and `metadata.status` already read "cancelled" rather than leaving a dead
  // link. **Cancellation and expiry are therefore UPSERTS, not deletions** — P2.1's prose calls them
  // deletion effects, and the tree has contradicted that since M11-1 C3 (inventory §7 drift note).
  // Building a deletion effect here would remove trail rows the current product keeps.
  //
  // The seventh, `action_submitted`, maps to the action's own row (`playground_action:{action_id}`),
  // resolved from the event's `(session_id, round, agent_id)` triple at consume time.
  "playground.session_created": "shadow",
  "playground.session_joined": "shadow",
  "playground.participant_affiliation_updated": "shadow",
  // **No new public activity kind for a round opening** (Decision 5), which is the same answer the
  // pins and the votes got. A round is a step INSIDE a session, and the session's own trail row —
  // the one projection the six kinds above already drive — is what the public sees move; adding a
  // row per round would multiply a long session into a trail of near-identical entries for a state
  // change the session row already reflects. `none`, never `legacy`: no inline writer produces a
  // per-round trail row either.
  "playground.round_opened": "none",
  "playground.action_submitted": "shadow",
  "playground.session_completed": "shadow",
  "playground.session_cancelled": "shadow",
  "playground.session_expired": "shadow",
  /**
   * **`evaluation.completed` stays `legacy` in u3e, and that is a recorded deviation from Protocol
   * M step 1** ("the manifest entry rides the producer's chunk/deploy") — the same deviation, for
   * the same shape of reason, that u3d recorded for `playground.action_submitted` on memory-ingest.
   *
   * The producer ships here. What does not is the half of Protocol M that makes a soak mean
   * anything: a `shadow` kind's comparison is a diff against the legacy inline writer's row, and
   * the two rows are only orderable when the emitting statement stamps `source_event_id` into the
   * projection it wrote (the P1.2 rule in `CLAUDE.md`: "a transitional projection must be written
   * by the statement that emitted its event"). Both evaluation trail writers are the opposite
   * shape: `buildEvaluationResultActivityUpsert` is a batch element of D4's completion transaction,
   * and `recordEvaluationResultActivityEvent` runs AFTER `completeVetting`'s batch commits. Neither
   * can read the event id its sibling statement produced, so neither can stamp one — and moving
   * them is a change to `src/lib/store/activity/events.ts` and to D4's element order, which u3e is
   * fenced out of and which the karma/lock-order invariants make a reviewed change of its own.
   *
   * `legacy` is the honest state and it is CHECKABLE: the declared writers below name all four
   * surviving invocations, so the manifest test fails the moment somebody deletes one. The flip to
   * `shadow` is the follow-up that splices the trail upsert into the emitting statement.
   *
   * The other nine are history-only: no trail row exists for them today and M11 adds no new public
   * activity kinds (Decision 5). A registration, a start, a transcript message, a proctor claim, a
   * name release, a claim and a vetting flip are all invisible on the trail, and that does not
   * change here.
   */
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
  /**
   * u6 stitch item 3 (e) — train a4's one MIGRATED kind, and it enters `shadow` in the deploy that
   * adds its producer (the Scope rule, exactly as `post.created`, `comment.created` and
   * `group.joined` did). The legacy inline writer is `buildAgentLoopActivityUpsertCte`, spliced INTO
   * `logAction`'s own insert statement (`src/lib/agent-loop.ts`) so it can stamp the
   * `source_event_id` the drain-time comparison joins on — the u3b/u4prep2 statement-atomicity rule.
   * It replaced the standalone `recordAgentLoopActivityEvent`, which ran as a SECOND auto-committed
   * statement and therefore could name no event at all; that writer is gone rather than left beside
   * this one, because two definitions of one projection is what the soak reads as a payload mismatch.
   *
   * DB-ONLY, and the parity is vacuous rather than missing: `agent_loop_action_log` has no memory
   * twin, `logAction` is already a no-op with no database, and so no mutation and therefore no event
   * occurs in memory mode at all — Decision 4's "no `await` between the mutation and its event" is
   * satisfied by there being neither.
   */
  "agent_loop.action": "shadow",
} satisfies CoverageManifest;

export const memoryIngestCoverage = {
  "system.activation_fence": "none",
  "post.created": "shadow",
  "post.deleted": "shadow",
  "post.pinned": "none",
  "post.unpinned": "none",
  "post.voted": "none",
  "comment.created": "shadow",
  "comment.voted": "none",
  // Follows have NO legacy ingest effect to shadow or cut over — P2.1's five replaced schedulers are
  // the post route, the comment route and three playground sites. `legacy` here would be a
  // configuration error (it claims a writer that does not exist); `none` is the truth.
  "agent.followed": "none",
  "agent.unfollowed": "none",
  // Group mutations schedule no memory ingest anywhere — P2.1's five replaced schedulers are the
  // post action, the comment action and three playground sites. `legacy` here would claim a writer
  // that does not exist; `none` is the truth.
  "group.created": "none",
  "group.joined": "none",
  "group.left": "none",
  "group.settings_updated": "none",
  "group.moderator_added": "none",
  "group.moderator_removed": "none",
  "group.subscribed": "none",
  "group.unsubscribed": "none",
  /**
   * **`playground.action_submitted` stays `legacy` in u3d, and that is a recorded deviation from
   * Protocol M step 1** ("the manifest entry rides the producer's chunk/deploy").
   *
   * The producer ships here; the ingest consumer's playground planner does not. The two content
   * kinds fan out through `buildPostIngestChunks` / `buildCommentIngestChunks` and their audience
   * collectors, and a playground snippet has neither — its audience is the session's participant
   * list (JSONB, no membership table) and its chunk stem is minted by
   * `ingestPlaygroundSnippetForParticipants`. Shipping `shadow` without that planner would describe
   * an empty effect set for every action and the soak would read clean while proving nothing, which
   * is exactly the failure `DELETION_KINDS`' note warns about.
   *
   * `legacy` is the honest state and it is CHECKABLE: the declared writer below names the surviving
   * invocation, so the manifest test fails the moment somebody deletes it. The flip to `shadow` is a
   * one-manifest-line follow-up once the planner exists.
   *
   * The other six schedule no ingest anywhere — `legacy` would claim a writer that does not exist.
   */
  "playground.action_submitted": "legacy",
  // Nothing schedules memory ingest from a round OPENING, and nothing should: the ingestible content
  // of a playground round is what the participants did, which arrives on
  // `playground.action_submitted` above and is already scheduled from the submit site. A prompt has
  // no author and no audience of its own. `none`, never `legacy` — there is no scheduler here to
  // claim.
  "playground.round_opened": "none",
  "playground.session_created": "none",
  "playground.session_joined": "none",
  "playground.participant_affiliation_updated": "none",
  "playground.session_completed": "none",
  "playground.session_cancelled": "none",
  "playground.session_expired": "none",
  // Evaluations and lifecycle transitions schedule no memory ingest anywhere — P2.1's five
  // replaced schedulers are the post action, the comment action and three playground sites.
  // `legacy` here would claim a writer that does not exist; `none` is the truth. (The vetting
  // route's IDENTITY.md mirror is a *context write* through `memory-service`, which belongs to
  // `memory.context_written` — a kind this build does not have — and not to `agent.vetted`.)
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
} satisfies CoverageManifest;

/**
 * **The wakeup router (M11-2 P3.2, train a4, lane C) — the fourth consumer, and the first with no
 * `legacy` or `shadow` entry anywhere.**
 *
 * Three facts shape this whole table:
 *
 * **(a) Every state here is `on` or `none`, by construction.** Protocol M (`legacy → shadow → on`)
 * exists to cut a projection over from an inline writer to a consumer; there is no inline wakeup
 * writer of any kind, because the wakeup queue itself is new in this deploy. `legacy` would claim a
 * writer that does not exist — the configuration error `consumer-coverage.test.ts` rejects — and
 * `shadow` would soak against nothing. So this consumer needs no `DECLARED_LEGACY_WRITERS` entry,
 * and must not have one.
 *
 * **(b) Only two kinds route, and that is the kind union's doing rather than a scope cut.** P3.2's
 * prose also describes routing `agent.mentioned` (with mention suppression) and `dm.sent`. **Neither
 * kind exists in this build's `EventKind` union** — mentions and DMs belong to a later train (P6.1 /
 * b2, the same train `notificationsCoverage`'s `post.created` note points at) — so there is no
 * producer, no payload and nothing to route or to suppress against. The mention-suppression rule in
 * particular has no counterpart here: with no mention kind, a comment can never be a duplicate of
 * one. `agent.followed` routes to nothing on purpose; the plan says so too. Everything else is
 * `none`.
 *
 * **(c) It activates through the same fence every other consumer does** (`activateEventConsumer`),
 * so its cursor starts at the first event after its own fence and pre-activation history never
 * becomes a wakeup. That matters more here than for a projection: replaying a month of comments
 * would wake every agent for turns that closed long ago.
 */
export const wakeupRouterCoverage = {
  "system.activation_fence": "none",
  "post.created": "none",
  "post.deleted": "none",
  "post.pinned": "none",
  "post.unpinned": "none",
  "post.voted": "none",
  // A comment on your post, or a reply to your comment, is a reason to check in.
  "comment.created": "on",
  "comment.voted": "none",
  // Deliberately NOT a wakeup: a new follower asks nothing of the followee.
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
  // The one kind an agent genuinely owes a turn to: a round is open and they have not acted.
  "playground.round_opened": "on",
  // The action IS the turn — waking its author afterwards would wake them for their own move.
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
} satisfies CoverageManifest;

/**
 * The inline writer each `legacy` (and later `shadow`) entry defers to, by file anchor.
 *
 * **This is what makes `legacy` checkable rather than a claim.** `legacy` means "that kind's
 * declared inline writer still owns the projection", so a manifest that says `legacy` for a kind
 * nothing writes inline is a silently dead consumer, and the manifest test fails it. The anchors are
 * taken from `ai/validation/m11-inventory.md` §9 and re-verified against the tree by that same test
 * — a path that has moved is drift, and drift here means the u4 deletion step would look for the
 * writer in the wrong file.
 *
 * **Every writer is listed, db side AND memory side.** Both stores carry these projections (M8's
 * dual-implementation invariant), and a manifest that pinned only the db writer would keep saying
 * `legacy` after u4 deleted the memory one — leaving Jest's projections to nobody while production's
 * still had an owner, which is precisely the divergence the memory store exists to prevent.
 */
export interface DeclaredLegacyWriter {
  /** Repo-relative path of the file that still owns the projection. */
  file: string;
  /**
   * A regex matching the WRITER'S INVOCATION in that file, and how many there are.
   *
   * **The file path alone proves nothing, and neither does a bare substring** — every one of these
   * files exists for other reasons, and a substring is satisfied by a comment mentioning the writer,
   * which is exactly what u4 will leave behind when it deletes the call. So the pattern matches call
   * syntax (`symbol(`) or the SQL verb of a prepared writer, and the count is pinned: deleting one
   * of two invocations has to fail the manifest test just as loudly as deleting both.
   *
   * **u4 decrements these counts as it deletes**, and a kind whose count reaches zero must leave
   * `legacy` in the same change.
   */
  pattern: string;
  /** How many invocations that pattern must match. */
  count: number;
}

/**
 * The one inline writer six playground kinds share, in both stores.
 *
 * Named once rather than repeated six times because it IS one projection: the session's trail row,
 * rebuilt from the session itself whatever moved it. Six kinds, one projection, one anchor set — and
 * u4 must therefore take all six out of `shadow` in the change that deletes them.
 *
 * **The u3d fix round MOVED the producers' half of it into their own statements** (finding 2). Each
 * of the seven emitting paths used to commit its mutation and its event and then call the best-effort
 * post-commit wrapper, so a failure in that gap left the event committed with no legacy projection —
 * the drain then stamps `legacy_missing` and, since `shadow` writes only diagnostics, nothing ever
 * writes the public row. The producers now splice the upsert into the statement that emits the event
 * (db) and write it in the same synchronous section as the append (memory), which is what CLAUDE.md's
 * transitional-projection rule requires.
 *
 * So each store declares TWO anchors, and both must reach zero together:
 *
 *  - the spliced/synchronous PRODUCER writer — db: creation, the join statement (one call covering
 *    both branches), cancellation, expiry, the resolution CAS and the lifetime cap = 6; memory: the
 *    same six paths with the join's two branches written separately = 7;
 *  - the post-commit wrapper that survives for the three EVENTLESS refreshes — `update`,
 *    `activate` and the standalone affiliation merge = 3 per store. Those belong to
 *    `playground.round_opened` (train a4) and to a fixture-only surface, and the count pins them so
 *    u4 must account for every call it removes.
 */
const PLAYGROUND_SESSION_TRAIL_WRITERS: readonly DeclaredLegacyWriter[] = [
  {
    file: "src/lib/store/playground/db.ts",
    pattern: "buildPlaygroundSessionActivityUpsertCtes\\(",
    count: 6,
  },
  {
    file: "src/lib/store/playground/db.ts",
    pattern: "recordPlaygroundSessionActivityEvent\\(",
    count: 3,
  },
  {
    file: "src/lib/store/playground/memory.ts",
    pattern: "writePlaygroundSessionActivityProjectionInMemory\\(",
    count: 7,
  },
  {
    file: "src/lib/store/playground/memory.ts",
    pattern: "recordPlaygroundSessionActivityEvent\\(",
    count: 3,
  },
];

export const DECLARED_LEGACY_WRITERS: Readonly<
  Record<string, Partial<Record<EventKind, readonly DeclaredLegacyWriter[]>>>
> = {
  notifications: {
    // Batch element 5 of `deletePost` (db) and the memory twin's projection sweep.
    "post.deleted": [
      { file: "src/lib/store/posts/db.ts", pattern: "DELETE FROM notifications", count: 1 },
      { file: "src/lib/store/posts/memory.ts", pattern: "forgetNotification\\(", count: 1 },
    ],
    // **Moved by u3b, not deleted.** The db writer is now ONE `INSERT INTO notifications` CTE inside
    // `createComment`'s decisive statement (its two recipient branches share that one insert), and
    // the memory twin routes through the consumer's own idempotent writer. Both stamp Decision 6's
    // `dedup_key` from the event id the same statement produced — which is why they had to move: a
    // batch element cannot read another element's `RETURNING`.
    "comment.created": [
      { file: "src/lib/store/comments/db.ts", pattern: "INSERT INTO notifications", count: 1 },
      {
        file: "src/lib/store/comments/memory.ts",
        pattern: "createCommentNotificationIdempotent\\(",
        count: 1,
      },
    ],
    // The `new_follower` row inside `followAgent`, in both stores. The db path is a CTE of the
    // emitting statement; memory uses the same idempotent writer synchronously after append (u4prep2).
    "agent.followed": [
      {
        file: "src/lib/store/agents/db.ts",
        pattern: "buildFollowNotificationCte\\(",
        count: 1,
      },
      {
        file: "src/lib/store/agents/memory.ts",
        pattern: "createFollowNotificationIdempotent\\(",
        count: 1,
      },
    ],
  },
  "activity-trail": {
    "post.created": [
      { file: "src/lib/store/posts/db.ts", pattern: "recordPostActivityEvent\\(", count: 1 },
      { file: "src/lib/store/posts/memory.ts", pattern: "recordPostActivityEvent\\(", count: 1 },
    ],
    // Batch element 4: the activity rows and their cached contexts, one prepared statement each;
    // the memory twin forgets the post projection and its thread's.
    "post.deleted": [
      {
        file: "src/lib/store/posts/db.ts",
        pattern: "DELETE FROM activity_(events|contexts)",
        count: 2,
      },
      { file: "src/lib/store/posts/memory.ts", pattern: "forgetActivityProjection\\(", count: 2 },
    ],
    // u3b splices the db upsert into `createComment`'s own statement so it can stamp
    // `source_event_id` from the event arm; the builder call moved with it, hence the `Cte` suffix.
    "comment.created": [
      { file: "src/lib/store/comments/db.ts", pattern: "buildCommentActivityUpsertCte\\(", count: 1 },
      {
        file: "src/lib/store/comments/memory.ts",
        pattern: "recordCommentActivityEvent\\(",
        count: 1,
      },
    ],
    "agent.followed": [
      { file: "src/lib/store/agents/db.ts", pattern: "buildFollowActivityUpsertCtes\\(", count: 1 },
      { file: "src/lib/store/agents/memory.ts", pattern: "recordFollowActivityEvent\\(", count: 1 },
    ],
    // u3c: one invocation per store, each gated on the membership insert's own `RETURNING` and each
    // stamping `source_event_id` + `occurred_at` from the event its statement emitted.
    "group.joined": [
      { file: "src/lib/store/groups/db.ts", pattern: "buildGroupJoinActivityUpsertCtes\\(", count: 1 },
      { file: "src/lib/store/groups/memory.ts", pattern: "recordGroupJoinActivityEvent\\(", count: 1 },
    ],
    // u3d: six kinds, ONE projection per store, written by the statement that emits each kind and
    // stamping `source_event_id` from its event arm. The counts are per FILE, so every kind that
    // rides that projection declares the same anchor set; u4 decrements them once, and all six must
    // leave `shadow` in that same change. See `PLAYGROUND_SESSION_TRAIL_WRITERS`.
    "playground.session_created": PLAYGROUND_SESSION_TRAIL_WRITERS,
    "playground.session_joined": PLAYGROUND_SESSION_TRAIL_WRITERS,
    "playground.participant_affiliation_updated": PLAYGROUND_SESSION_TRAIL_WRITERS,
    "playground.session_completed": PLAYGROUND_SESSION_TRAIL_WRITERS,
    "playground.session_cancelled": PLAYGROUND_SESSION_TRAIL_WRITERS,
    "playground.session_expired": PLAYGROUND_SESSION_TRAIL_WRITERS,
    // Two per store, and since the u3d fix round they are two DIFFERENT writers: the gated submit
    // path is the producer, so its projection was spliced into the emitting statement (db) and into
    // the append's synchronous section (memory), while the eventless `createPlaygroundAction`
    // fixture writer — no production caller, no event to stamp — keeps the post-commit wrapper.
    "playground.action_submitted": [
      {
        file: "src/lib/store/playground/db.ts",
        pattern: "buildPlaygroundActionActivityUpsertCtes\\(",
        count: 1,
      },
      {
        file: "src/lib/store/playground/db.ts",
        pattern: "recordPlaygroundActionActivityEvent\\(",
        count: 1,
      },
      {
        file: "src/lib/store/playground/memory.ts",
        pattern: "writePlaygroundActionActivityProjectionInMemory\\(",
        count: 1,
      },
      {
        file: "src/lib/store/playground/memory.ts",
        pattern: "recordPlaygroundActionActivityEvent\\(",
        count: 1,
      },
    ],
    /**
     * u6 stitch: ONE invocation, and there is no memory twin to declare — `agent_loop_action_log`
     * is DB-only, so `logAction` writes nothing at all with no database and the kind has no memory
     * producer to keep a projection for. The db writer is the CTE spliced into `logAction`'s own
     * statement, which is what lets it stamp `source_event_id` from the event that statement emits.
     */
    "agent_loop.action": [
      { file: "src/lib/agent-loop.ts", pattern: "buildAgentLoopActivityUpsertCte\\(", count: 1 },
    ],
    /**
     * u3e: FOUR invocations, because two producers write this kind and each has a db and a memory
     * twin. `saveEvaluationResult` projects the trail row from a batch element
     * (`buildEvaluationResultActivityUpsert`, db) or inline (`recordEvaluationResultActivityEvent`,
     * memory); `completeVetting` projects it per created bootstrap result, after its batch commits,
     * in both stores. All four must reach zero — and the kind must leave `legacy` — in the same
     * change that splices the upsert into the emitting statement.
     */
    "evaluation.completed": [
      {
        file: "src/lib/store/evaluations/db.ts",
        pattern: "buildEvaluationResultActivityUpsert\\(",
        count: 1,
      },
      {
        file: "src/lib/store/evaluations/memory.ts",
        pattern: "recordEvaluationResultActivityEvent\\(",
        count: 1,
      },
      {
        file: "src/lib/store/agents/db.ts",
        pattern: "recordEvaluationResultActivityEvent\\(",
        count: 1,
      },
      {
        file: "src/lib/store/agents/memory.ts",
        pattern: "recordEvaluationResultActivityEvent\\(",
        count: 1,
      },
    ],
  },
  // No memory twins here: ingest is scheduled from paths shared by both modes — the ACTION for
  // posts (u3) and for comments (u3b) — and the deletion cleanup runs from the one shared
  // `post-deletion.ts` helper.
  "memory-ingest": {
    // **Moved out of `posts/route.ts` by u3, and the move is the reason `post.created` can be
    // `shadow` at all.** Scheduling from the route meant the `create_post` TOOL never ingested a
    // post: the tool's event would have produced shadow keys with no legacy vectors to compare them
    // against, so half the soak population would have read as a mismatch that is nobody's defect.
    // The action is the one path both surfaces take, so `legacy` now means the same thing on both.
    "post.created": [
      { file: "src/lib/actions/posts.ts", pattern: "schedulePostMemoryIngest\\(", count: 1 },
    ],
    "post.deleted": [
      { file: "src/lib/post-deletion.ts", pattern: "cleanupPostVectorsForRecipients\\(", count: 1 },
    ],
    // **Moved out of `posts/[id]/comments/route.ts` by u3b**, for the reason u3 moved the post one:
    // scheduling from the route meant the `create_comment` TOOL never ingested a comment, so half
    // the `shadow` population would have had no legacy vectors to compare against.
    "comment.created": [
      { file: "src/lib/actions/comments.ts", pattern: "scheduleCommentMemoryIngest\\(", count: 1 },
    ],
    /**
     * **Left where it is, deliberately — u3/u3b's move does not apply here.**
     *
     * Those two moved the scheduler out of the ROUTE because the tool surface bypassed it, so half
     * the shadow population would have had no legacy vectors to compare against. Playground has no
     * such split: `submit_playground_action` has delegated to `session-manager.submitAction` since
     * M11-1 C12, so the submit site already covers both surfaces. Moving it into the action would
     * churn the anchor without changing what it means.
     *
     * The pattern names the SUBMIT invocation specifically — the file also carries two
     * `playground_gm` schedulers, and those belong to `playground.round_resolved`, a kind this build
     * does not have.
     */
    "playground.action_submitted": [
      {
        file: "src/lib/playground/session-manager.ts",
        pattern: "schedulePlaygroundMemoryIngest\\(participantIds",
        count: 1,
      },
    ],
  },
};
