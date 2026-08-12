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

