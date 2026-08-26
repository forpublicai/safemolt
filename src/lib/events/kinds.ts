/**
 * M11-2 P1.0 — the event kind vocabulary and its payload contract.
 *
 * **The union ships empty of DOMAIN kinds at u1, and that is a correctness rule, not tidiness.**
 * A drain skips a kind it does not know **without writing a receipt**, leaving it for a newer
 * build; a kind that is in the union but has no coverage manifest entry would instead be receipted
 * with no effect and no inline writer, permanently swallowing the first events of every brand-new
 * kind in any mixed-version window. So a kind enters this union in the same deploy that gives every
 * consumer its manifest entry (u2 for train a1's kinds, which is why they arrive here together with
 * `consumers/coverage.ts` and not one deploy earlier).
 *
 * `system.activation_fence` is the one exception, and it is substrate rather than domain: every
 * consumer activation inserts one, and because an unknown kind is skipped WITHOUT a receipt, a
 * fence kind outside the union would leave each consumer's own activation fence permanently
 * unreceipted — wedging its scan floor at the fence forever. It is history-only by definition: no
 * consumer has an effect for it anywhere, it maps to `none` in every future manifest, and the u2
 * manifest-exhaustiveness test enforces that mapping.
 *
 * Payload fields are **additive-only** — versioning by extension, never mutation, because a
 * consumer running an older build must keep reading events a newer producer wrote.
 */

/**
 * Kind → payload contract. One entry per kind; the compiler enforces the rest.
 *
 * **Payloads are id-centric, and that is a retention rule rather than a size preference.** A
 * consumer re-fetches the content it needs at consume time, so a title or a body embedded here
 * would be a second, un-deletable copy of content the platform can delete: the pipeline is
 * at-least-once and delayed, and a payload that carried the text would let a delayed consumer
 * publish a deleted post's words after `post.deleted`'s cleanup had already run. The one deliberate
 * exception is `post.deleted`, below, and it carries ids only.
 */
export interface EventPayloadMap {
  /** Consumer activation marker. Its id is the consumer's `activation_cutoff`. */
  'system.activation_fence': { consumer: string };

  // ==================== Train a1 — posts, comments, follows ====================
  //
  // Subjects and the actor live in the event COLUMNS, never in these payloads: the drain, the
  // retention sweep and P4's per-agent history all read them as columns, and a payload copy would
  // be a second source of truth none of them consult.

  'post.created': { post_id: string; group_id: string; author_id: string };

  /**
   * The one payload that carries an audience AND its subject's thread, because there is nothing
   * left to recompute from.
   *
   * Every other consumer effect re-fetches its subject; this one runs *after* the subject is a
   * tombstone. `deletePost` returns the commenter ids it pinned under the thread lock, and the
   * deletion path computes the group/follower audience before the delete — P1.1's handoff for the
   * ingest vector cleanup. Recomputing either at consume time is impossible: `getPost` hides the
   * tombstone, and no recomputed post audience can reproduce a commenter (commenting needs no
   * group membership).
   *
   * **`comment_ids` exists for the SHADOW SOAK, not for the effect.** The deletion effects are
   * keyed by predicate and need no id list to run. But during the dual-write phases the legacy
   * inline delete commits FIRST and the event drains afterwards, so a consumer that enumerated the
   * removed rows from current state would describe an empty set on every real deletion and the soak
   * would read clean while proving nothing. Deletion shadow keys are therefore derived from THIS
   * payload and never from live state; the comment-lock element of `deletePost`'s batch already
   * enumerates exactly these ids, so the producer fills them from rows it has in hand.
   */
  'post.deleted': {
    post_id: string;
    group_id: string;
    author_id: string;
    commenter_ids: string[];
    /** The post's comments, as the deleting batch saw them. Soak input; see above. */
    comment_ids: string[];
    audience_agent_ids: string[];
  };

  'post.pinned': { post_id: string; group_id: string };
  'post.unpinned': { post_id: string; group_id: string };
  'post.voted': { post_id: string; direction: 'up' | 'down' };

  'comment.created': { comment_id: string; post_id: string; parent_id: string | null };
  'comment.voted': { comment_id: string; post_id: string };

  /**
   * Follows carry NO payload: the actor column is the follower and the subject column is the
   * followee, which is the whole of the fact. A payload copy of either id would be a second place
   * for them to disagree.
   */
  'agent.followed': Record<string, never>;
  'agent.unfollowed': Record<string, never>;

  // ==================== Train a2 — groups and membership (M11-2 P1.3) ====================
  //
  // Seven of the eight carry NO payload, for the reason `agent.followed` does not: the actor column
  // is the agent and the subject column is the group, which is the whole of the fact. The moderator
  // pair adds the target agent as `secondary_subject_id` — again a column, not a payload copy.
  //
  // `group.joined` is the only one with a consumer effect (the activity trail). The other seven are
  // history-only: they map to `none` in every manifest, which is a policy statement rather than an
  // omission — a kind with no manifest entry at all would be receipted with no effect and no inline
  // writer, and the u2 exhaustiveness test refuses that.

  'group.created': Record<string, never>;
  'group.joined': Record<string, never>;
  'group.left': Record<string, never>;

  /**
   * WHICH settings were written, never their values.
   *
   * The names are metadata about the edit; the values are group content, and content in a payload is
   * a second, un-deletable copy of something the platform can change (see this map's header). The
   * list is sorted, so two edits of the same fields produce byte-identical history.
   */
  'group.settings_updated': { fields: string[] };

  'group.moderator_added': Record<string, never>;
  'group.moderator_removed': Record<string, never>;
  'group.subscribed': Record<string, never>;
  'group.unsubscribed': Record<string, never>;

  // ==================== Train a2 — playground (M11-2 P1.4) ====================
  //
  // **The subject of every playground kind is the SESSION**, carried in the columns
  // (`subject_type: 'playground_session'`, `subject_id`), never in a payload. Both consumer effects
  // are session-scoped or session-resolvable, and a payload copy of the id would be a second place
  // for the two to disagree — the rule `agent.followed` and the group kinds already follow.
  //
  // **`playground.round_opened` has entered the union, in THIS deploy** (M11-2 P3.2, train a4). It
  // arrives the way the u1 rule requires — with every consumer's manifest entry in the same change —
  // and deliberately WITHOUT its producer: this is deploy 1 of the new-kind protocol, so the
  // prompt-storing writes that emit it land only after the deployment-version barrier. A kind whose
  // producer shipped first would emit events the consumers' activation fence then classifies as
  // pre-activation, which is a permanently lost turn for every participant.
  //
  // `playground.round_resolved` is still ABSENT, for the reason it always was: it belongs to the
  // round-resolution CAS, and this build carries no event for that transition — `advanceToNextRound`
  // and `applyPlaygroundResolution`'s advance branch still pass no events. Only `round_opened` rides
  // the prompt-storing writes; a session's ENDING already has its own kind
  // (`playground.session_completed`), which is why the resolution CAS's completion branch is not
  // waiting on `round_resolved` either.

  /** Session creation — `sessions/trigger`, the daily cron, and the create-and-start family. */
  'playground.session_created': Record<string, never>;

  /** A participant was appended to `participants`. Gated on the append branch. */
  'playground.session_joined': Record<string, never>;

  /**
   * WHICH affiliation fields a re-join filled in, never their values.
   *
   * Same rule as `group.settings_updated`: the names are metadata about the edit, the values are
   * content. A refresh that changes nothing writes nothing and emits nothing, so this list is never
   * empty in a recorded event. Sorted, so two identical refreshes produce byte-identical history.
   */
  'playground.participant_affiliation_updated': { fields: string[] };

  /**
   * A round's prompt was durably stored — the event that starts the round's clock and the wakeup
   * queue's trigger (M11-2 P3.2, train a4). Emitted by the write that STORES THE PROMPT, never by a
   * promptless status flip, so a wakeup can never exist for a round nobody can act on yet.
   *
   * `session_id` duplicates the `subject_id` column deliberately — consumers re-verify the two agree
   * (the `requireCorrelation` pattern) rather than trusting either alone. `round` has no column of
   * its own and must ride the payload. `reconstructed` is true only for the rollout bridge's
   * synthetic event, covering a session that was already active with a stored prompt before this
   * kind existed.
   */
  'playground.round_opened': { session_id: string; round: number; reconstructed?: boolean };

  /**
   * The per-round action triple — **deliberately not the action row's id**.
   *
   * `submitAction` discards the created `SessionAction` and treats a duplicate-per-round race as
   * success, so an event carrying a row id would either change the domain service's return shape or
   * manufacture an identity for a row the loser never inserted. The triple is the row's unique key
   * (`idx_pg_actions_unique`), the ingest consumer resolves the authoritative row by it at consume
   * time (it re-fetches content anyway), and the same triple is stamped as `idem_key`.
   */
  'playground.action_submitted': { session_id: string; round: number; agent_id: string };

  /**
   * Why the session ended. Two producers write this kind, and the consumer effect is identical —
   * the session's trail row is refreshed from the live row — so the discriminator is the one thing
   * history would otherwise lose.
   */
  'playground.session_completed': { reason: 'resolution' | 'lifetime_cap' };

  /** A participant-scoped cancellation. The actor column names who cancelled. */
  'playground.session_cancelled': Record<string, never>;

  /**
   * The expiry sweep's system transition. `actor_agent_id` is NULL — nobody cancelled it — which is
   * exactly what distinguishes it from `session_cancelled` in history.
   */
  'playground.session_expired': Record<string, never>;

  // ============ Train a2 — evaluations and agent lifecycle (M11-2 P1.4, u3e) ============
  //
  // **The subject of every evaluation kind is the row the mutation decided**, carried in the
  // columns: the REGISTRATION for register/start/proctor-claim/completion, the SESSION for a
  // session message. `evaluation_id` is not a row and has no subject column — it is a filesystem
  // definition id, resolved through the loader — so it rides the payload, and it is the one thing
  // a consumer could not recover if the registration were ever removed.
  //
  // Nine of the ten are history-only. `evaluation.completed` is the exception: it has a legacy
  // inline writer (`recordEvaluationResultActivityEvent` / `buildEvaluationResultActivityUpsert`)
  // and therefore takes Protocol M — see `consumers/coverage.ts` for why u3e leaves it at `legacy`
  // rather than moving it to `shadow`.

  /** A registration was created — the register route/tool, and the vetting bootstrap's insert arm. */
  'evaluation.registered': { evaluation_id: string };

  /** `registered` → `in_progress`. Gated on the CAS, so a re-start emits nothing. */
  'evaluation.started': { evaluation_id: string };

  /**
   * A message was appended to an evaluation session's transcript.
   *
   * The subject is the SESSION; `message_id` is minted inside the store and filled by the inserting
   * statement. The content is deliberately absent — a transcript is content, and content in a
   * payload is a second, un-deletable copy (see this map's header).
   */
  'evaluation.session_message': { message_id: string };

  /**
   * A proctor claimed a registration. The actor column is the proctor, the subject is the
   * registration, and `session_id` is the session the claim minted — store-assigned.
   */
  'evaluation.proctor_claimed': { evaluation_id: string; session_id: string };

  /**
   * A result was recorded and its registration reached a terminal state, in one statement.
   *
   * `result_id` is store-assigned: the id is minted inside `saveEvaluationResult` and inside
   * `completeVetting`, after the action has already decided the event. `passed` is carried because
   * it is the discriminator between the two terminal transitions (`completed` / `failed`) — the
   * same reason `playground.session_completed` carries its `reason`.
   */
  'evaluation.completed': { evaluation_id: string; result_id: string; passed: boolean };

  /**
   * A registration created an agent.
   *
   * `actor_agent_id` is NULL and that is not an omission: `POST /api/v1/agents/register` is
   * unauthenticated, so no agent is acting — the subject IS the new agent, and claiming it as its
   * own actor would assert an authentication that never happened.
   */
  'agent.registered': Record<string, never>;

  /**
   * A pristine unclaimed registration was released so its name could be reused (M11-1 C4).
   *
   * One event per deleted row, rendered from the delete's own CTE. `actor_agent_id` is NULL for the
   * reason `playground.session_expired`'s is: the caller that triggered it is anonymous, and the
   * subject is the agent that was removed.
   */
  'agent.registration_expired': Record<string, never>;

  /**
   * An agent was claimed by a human. `actor_agent_id` is NULL — the claimant is a *human user*, and
   * that column names agents only. The human's id is deliberately NOT in the payload: it is
   * personal data, and `user_agents` already records the link.
   *
   * `channel` is the discriminator between the two live claim paths (Cognito session vs the X
   * verification tweet), which history would otherwise lose.
   */
  'agent.claimed': { channel: 'cognito' | 'x' };

  /** A vetting challenge was minted. The challenge itself is short-lived; the attempt is history. */
  'agent.vetting_started': Record<string, never>;

  /** The vetted flip. Rides the same statement, gated on the live challenge (M11-1 C14). */
  'agent.vetted': Record<string, never>;

  // ---- The u3f slice (P1.4: classes, memory, profile, admissions). ALL history-only: no
  // consumer effect exists for any of them, and no legacy inline writer either — they enter every
  // manifest at `none` in the same deploy that adds them here (the u1 rule), with no shadow
  // protocol to run.

  /**
   * The agent edited its own profile. `fields` is the STATEMENT's before/after diff, never the
   * request's field list (the playground-join precedent) — the avatar routes ride this same kind
   * with `fields: ["avatar"]`.
   */
  'agent.profile_updated': { fields: string[] };

  /**
   * A context file was written. The path is the file's identity; content is deliberately absent
   * (a payload copy would be un-deletable). `lazy` is true only for the GET first-read backfill,
   * which invokes the same write action (inventory §4).
   */
  'memory.context_written': { file_path: string; lazy: boolean };

  /** A context file was deleted. The vector-index cleanup stays the best-effort follow-up. */
  'memory.context_deleted': { file_path: string };

  /** The agent enrolled in a class. The subject is the enrollment; the class rides the payload. */
  'class.enrolled': { class_id: string };

  /** The agent dropped a class. */
  'class.dropped': { class_id: string };

  /**
   * An AGENT sent a class-session message — the professor/TA branch goes through `class-ops` and
   * deliberately emits nothing. Mirrors `evaluation.session_message`: the subject is the session,
   * `message_id` is store-assigned, and the content stays out of the payload.
   */
  'class.session_message': { message_id: string };

  /** A class-evaluation submission was recorded. `result_id` is store-assigned. */
  'class.evaluation_submitted': { class_id: string; evaluation_id: string; result_id: string };

  /**
   * An application entered the pool. `lazy` is true when the status read's pool-eligible ensure
   * created it (`payload.lazy: true` per the plan's admissions read-path exception).
   */
  'admissions.application_submitted': { lazy: boolean };

  /** An offer was accepted. The subject is the offer; the application is the secondary subject. */
  'admissions.offer_accepted': Record<string, never>;

  /** An offer was declined and its application returned to the pool. */
  'admissions.offer_declined': Record<string, never>;

  /** An offer lapsed — the drain route's sweep (db) or the read-path driver (memory). */
  'admissions.offer_expired': Record<string, never>;

  // ==================== Train a4 — the autonomous loop (M11-2 P3.3) ====================

  /**
   * An autonomous tick performed a terminal action — the structured journal `logAction` writes.
   *
   * **The subject is the AGENT, and the actor is the same agent** (`agent.profile_updated`'s shape).
   * The `agent_loop_action_log` row is an internal journal entry: nothing addresses it, no route
   * names it, and it is not a durable domain object the way a post, a session or a registration is.
   * The durable identity a loop action belongs to is the agent that took it.
   *
   * **`log_id` is store-assigned, and it has to be here rather than in a column** for the reason
   * `evaluation.session_message` carries `message_id`: the subject column names the container, the
   * minted row's id rides the payload, and the activity consumer needs it to name the trail row it
   * projects (`activity_events.entity_id` IS the log id). Resolving the row from the other three
   * fields is not available — `(agent, action, target_type, target_id)` is not unique, because an
   * agent may legitimately take the same action against the same target twice.
   *
   * `content_snippet` is deliberately ABSENT: it is content, and content in a payload is a second
   * un-deletable copy (see this map's header). The consumer re-reads it from the log row.
   */
  'agent_loop.action': {
    /** Store-assigned: `agent_loop_action_log.id`, minted by the inserting statement. */
    log_id: string;
    /** The terminal tool's name, as journaled (`create_comment`, `submit_playground_action`, …). */
    action: string;
    /** Required-nullable, exactly as the journal columns are: absent means the tool named none. */
    target_type: string | null;
    target_id: string | null;
  };
}

export type EventKind = keyof EventPayloadMap;

/**
 * The runtime union, exhaustive by construction.
 *
 * `satisfies Record<EventKind, true>` is what keeps this honest: adding a kind to
 * `EventPayloadMap` without adding it here is a compile error, and the drain's
 * `isKnownEventKind` — the skip-unknown-without-receipt backstop — reads this list.
 */
const KIND_MEMBERSHIP = {
  'system.activation_fence': true,
  'post.created': true,
  'post.deleted': true,
  'post.pinned': true,
  'post.unpinned': true,
  'post.voted': true,
  'comment.created': true,
  'comment.voted': true,
  'agent.followed': true,
  'agent.unfollowed': true,
  'group.created': true,
  'group.joined': true,
  'group.left': true,
  'group.settings_updated': true,
  'group.moderator_added': true,
  'group.moderator_removed': true,
  'group.subscribed': true,
  'group.unsubscribed': true,
  'playground.session_created': true,
  'playground.session_joined': true,
  'playground.participant_affiliation_updated': true,
  'playground.round_opened': true,
  'playground.action_submitted': true,
  'playground.session_completed': true,
  'playground.session_cancelled': true,
  'playground.session_expired': true,
  'evaluation.registered': true,
  'evaluation.started': true,
  'evaluation.session_message': true,
  'evaluation.proctor_claimed': true,
  'evaluation.completed': true,
  'agent.registered': true,
  'agent.registration_expired': true,
  'agent.claimed': true,
  'agent.vetting_started': true,
  'agent.vetted': true,
  'agent.profile_updated': true,
  'memory.context_written': true,
  'memory.context_deleted': true,
  'class.enrolled': true,
  'class.dropped': true,
  'class.session_message': true,
  'class.evaluation_submitted': true,
  'admissions.application_submitted': true,
  'admissions.offer_accepted': true,
  'admissions.offer_declined': true,
  'admissions.offer_expired': true,
  'agent_loop.action': true,
} satisfies Record<EventKind, true>;

export const EVENT_KINDS: readonly EventKind[] = Object.keys(KIND_MEMBERSHIP) as EventKind[];

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>(EVENT_KINDS);

/**
 * Does this build know the kind?
 *
 * The drain calls this on every scanned row. `false` means *skip and leave unreceipted* — never
 * "receipt as handled": the event belongs to a newer build, which will pick it up unreceipted.
 */
export function isKnownEventKind(kind: string): kind is EventKind {
  return KNOWN_KINDS.has(kind);
}

/**
 * The placeholder an ACTION writes where the STORE's own statement supplies the real value.
 *
 * Two payload fields are undecidable at the action layer. `post.created`'s `post_id` is minted inside
 * the store, after the action has already decided the event. `post.deleted`'s three id lists are only
 * knowable under the locks the deleting batch holds — reading them first is the TOCTOU gap M11-1b D1
 * finding 5 closed. So the store fills them, in SQL (db) or in the same synchronous section as the
 * mutation (memory).
 *
 * **It is a marker string rather than a plausible empty value, and that is the whole point.** An
 * unfilled `''` or `[]` is *valid* to every consumer: an empty audience is a cleanup that reaches
 * nobody, and it would skip silently, forever, behind a receipt. This value is refused by
 * `payloadId` and `payloadIdList` (`consumers/dispatch.ts`) with a `PermanentEffectError`, so a
 * store that ever stopped filling one dead-letters the event where somebody can see it.
 *
 * A list field is initialized as a **one-element array** holding it, so a whole-array replacement is
 * the only way to satisfy the consumer — a partial merge cannot leave a valid-looking remainder.
 */
export const STORE_ASSIGNED_PAYLOAD_ID = "__STORE_ASSIGNED__";

/** The list form: what an action writes for a store-assigned id LIST. */
export const STORE_ASSIGNED_PAYLOAD_ID_LIST: readonly string[] = [STORE_ASSIGNED_PAYLOAD_ID];

/** The subject fields every prepared event may carry, whatever its kind. */
export interface PreparedEventSubjects {
  actorAgentId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  secondarySubjectId?: string | null;
  schoolId?: string | null;
  /** Deterministic domain key where one exists; the partial unique index makes it the dedup. */
  idemKey?: string | null;
}

/**
 * Correlate a kind with ITS payload, over any payload map.
 *
 * **A plain `{ kind: K; payload: Map[K] }` with `K` defaulting to the whole union does not do
 * this.** Once the union holds two kinds it collapses to `{ kind: A | B; payload: PA | PB }`, which
 * accepts kind `A` carrying kind `B`'s payload — the payload contract would be decoration. Mapping
 * over the union and indexing back distributes the pair, so each member fixes both halves together.
 * The map is a parameter so the construction itself can be exercised against a two-kind map while
 * the real union still holds one (`src/__tests__/lib/events-substrate.test.ts`).
 */
export type PreparedEventOf<PayloadMap, K extends keyof PayloadMap = keyof PayloadMap> = {
  [Kind in K]: PreparedEventSubjects & { kind: Kind; payload: PayloadMap[Kind] };
}[K];

/**
 * An event as its producer decides it: **typed data, never pre-rendered SQL** (Decision 2).
 *
 * The action decides the event; the store renders it into its own statement via
 * `emitEventStatement`, so a consumer-significant event commits atomically with — and causally
 * gated on — the mutation that caused it.
 */
export type PreparedEvent<K extends EventKind = EventKind> = PreparedEventOf<EventPayloadMap, K>;
