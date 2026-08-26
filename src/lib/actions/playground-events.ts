/**
 * M11-2 P1.4 — the playground event vocabulary, in ONE module.
 *
 * Split out of `actions/playground.ts` for a structural reason rather than a stylistic one: the
 * SWEEPS need these builders too — `session-manager.checkDeadlines` for expiry, `session-manager`'s
 * completion CAS, `lifecycle.enforceSessionLifetimeCap` for the cap — and the action module imports
 * those same modules to delegate to them. Keeping the builders here breaks that import cycle
 * outright instead of relying on every one of its edges staying lazy.
 *
 * Why the sweeps decide their events HERE at all: they have no acting agent and therefore no action
 * to route through, but they are Tier-1 mutations with public projections (inventory §3a). One
 * module deciding what a playground event looks like is what keeps three files from inventing
 * subject columns independently.
 */
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { FOUNDATION_SCHOOL_ID } from "@/lib/school-context";

/**
 * The subject columns every playground event carries.
 *
 * The SESSION is the subject of all seven kinds, and it lives in the columns rather than in a
 * payload for the reason `agent.followed` and the group kinds state: a payload copy of an id the
 * columns already carry is a second place for the two to disagree.
 *
 * `subjectId` is store-assigned wherever the store mints or resolves the id itself — session
 * creation derives it inside the statement, and the expiry sweep produces one event per row.
 */
export function playgroundSubjects(options: {
  sessionId: string | null;
  actorAgentId: string | null;
  schoolId: string | null;
}) {
  return {
    actorAgentId: options.actorAgentId,
    subjectType: "playground_session" as const,
    subjectId: options.sessionId ?? STORE_ASSIGNED_PAYLOAD_ID,
    // NULL means Foundation for every session created before per-school scoping, exactly as
    // `groupSchoolId` reads a NULL group. An event stamped NULL would put the platform's oldest
    // sessions in no school at all.
    schoolId: options.schoolId ?? FOUNDATION_SCHOOL_ID,
  };
}

/**
 * `playground.session_created` — for the trigger route, the daily cron and the create-and-start
 * family. `subject_id` is store-assigned: the id is minted inside `createPendingSession`.
 */
export function playgroundSessionCreatedEvent(options: {
  actorAgentId: string | null;
  schoolId: string | null;
}): PreparedEvent<"playground.session_created"> {
  return {
    ...playgroundSubjects({ sessionId: null, ...options }),
    kind: "playground.session_created",
    payload: {},
  };
}

/**
 * `playground.session_completed` — both producers, discriminated by `reason`.
 *
 * The consumer effect is identical (the session's trail row is rebuilt from the live row), so the
 * reason is the one thing history would otherwise lose about why a session ended.
 */
export function playgroundSessionCompletedEvent(options: {
  sessionId: string;
  schoolId: string | null;
  reason: "resolution" | "lifetime_cap";
}): PreparedEvent<"playground.session_completed"> {
  return {
    ...playgroundSubjects({
      sessionId: options.sessionId,
      // Neither producer has an acting agent: a resolution is the GM's and the cap is the sweep's.
      actorAgentId: null,
      schoolId: options.schoolId,
    }),
    kind: "playground.session_completed",
    payload: { reason: options.reason },
  };
}

/**
 * `playground.session_expired` — the sweep's system transition, ONE TEMPLATE for the whole batch.
 *
 * The store fans it out: the db side renders it with `rowSource`, emitting one event per expired
 * row with that row's id as `subject_id`; the memory twin substitutes the id per session. So the
 * `subject_id` here is the store-assigned marker, and `actor_agent_id` is NULL — which is exactly
 * what distinguishes a system expiry from a participant's cancellation in history.
 *
 * `school_id` is NULL rather than Foundation, and that is the one deliberate exception to
 * `playgroundSubjects`' rule: a batch sweep spans schools, so naming one would be a lie about the
 * others. It is the only event here whose school genuinely is not knowable per batch.
 */
export function playgroundSessionExpiredEvent(): PreparedEvent<"playground.session_expired"> {
  return {
    kind: "playground.session_expired",
    actorAgentId: null,
    subjectType: "playground_session",
    subjectId: STORE_ASSIGNED_PAYLOAD_ID,
    schoolId: null,
    payload: {},
  };
}

/**
 * `playground.round_opened` — the event that starts a round's clock (M11-2 P3.2, train a4).
 *
 * THREE producers share this builder: the round-1 async prompt write, `advanceToNextRound`'s CAS for
 * rounds >= 2, and the rollout bridge's synthetic reconstruction. All three name a round whose prompt
 * is (or is being) durably stored — a promptless status flip never emits it, which is what makes a
 * wakeup impossible for a round nobody can act on.
 *
 * `subject_id` is supplied DIRECTLY rather than through the store-assigned marker, unlike
 * `playgroundSessionCreatedEvent`: every call site here already holds a concrete session id, because
 * the session exists before any of its rounds can open. `actorAgentId` is NULL — no agent opens a
 * round, the GM/system does, the same reasoning `session_completed` and `session_expired` carry.
 */
export function playgroundRoundOpenedEvent(options: {
  sessionId: string;
  round: number;
  schoolId: string | null;
  /** True only for the rollout bridge's synthetic reconstruction of a pre-existing prompted round. */
  reconstructed?: boolean;
  /**
   * Only the rollout bridge sets this: `playground_round_opened:{session_id}:{round}` makes repeated
   * sweep passes emit exactly one synthetic event for a session that predates this kind. The two
   * REAL producers carry no idem key at all — their uniqueness comes from the conditional
   * statement's own predicate, not from a key.
   */
  idemKey?: string;
}): PreparedEvent<"playground.round_opened"> {
  return {
    ...playgroundSubjects({
      sessionId: options.sessionId,
      actorAgentId: null,
      schoolId: options.schoolId,
    }),
    kind: "playground.round_opened",
    ...(options.idemKey !== undefined ? { idemKey: options.idemKey } : {}),
    payload: {
      session_id: options.sessionId,
      round: options.round,
      ...(options.reconstructed ? { reconstructed: true } : {}),
    },
  };
}

