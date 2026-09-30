/**
 * M11-2 P1.4 — the playground slice as **one** action path.
 *
 * Four route handlers and two tool executors each resolved the session, applied (or applied
 * differently) the school rule, called a domain entry point and rendered their own result. The two
 * surfaces had already drifted in a way an agent can see: the routes publish
 * `requireSchoolAccess`'s platform-access envelope ("…to access this school") while the tools
 * publish `sessionSchoolAccessDenial`'s playground wording ("…to take part in its playground
 * sessions"). One decision, two messages. Here the decision is made once and each adapter keeps its
 * own vocabulary — the characterization suite pins both.
 *
 * **The action layer is a POLICY BOUNDARY, not a rewrite of domain logic** (P1.4's Remedy). Every
 * export below delegates to the existing entry point — `session-manager.joinSession`,
 * `session-manager.submitAction`, `session-manager.createPendingSession`, the store's participant-
 * scoped cancellation — and owns exactly three things the surfaces were each owning separately: the
 * school rule, the input validation that decides a refusal, and the EVENT.
 *
 * **The action decides the event; the store executes it** (Decision 2). Each mutation hands its
 * store a `PreparedEvent[]` — typed data, never SQL — and the store renders it into the same
 * statement as the write, gated on the decisive mutation's own `RETURNING`. So a re-join with
 * identical affiliation fields, a duplicate action, a nonparticipant's cancel and a sweep that
 * matched nothing all write nothing and emit nothing.
 *
 * **The event VOCABULARY lives one file over, in `playground-events.ts`, for a structural reason.**
 * The sweeps need the same builders — expiry, the lifetime cap and the completion CAS are Tier-1
 * mutations with public projections and no acting agent (inventory §3a) — and this module imports
 * `session-manager` and `lifecycle` to delegate to them. Keeping the builders here would close that
 * import cycle; keeping them there breaks it outright while still letting ONE module decide what a
 * playground event looks like.
 */
import {
  cancelPlaygroundSession as storeCancelSession,
  getPlaygroundSession,
} from "@/lib/store";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { sessionSchoolAccessDenial } from "@/lib/school-context";
import {
  createPendingSession as domainCreatePendingSession,
  joinSession as domainJoinSession,
  submitAction as domainSubmitAction,
  SUBMIT_REFUSAL_MESSAGES,
} from "@/lib/playground/session-manager";
import type { CancelPlaygroundOutcome, PlaygroundSession, SessionAction } from "@/lib/playground/types";
import type { StoredAgent } from "@/lib/store-types";
import type { ExecutionGuard } from "@/lib/store/execution-guard";

import { playgroundSessionCreatedEvent, playgroundSubjects } from "./playground-events";
import { actionError, actionOk, type ActionResult } from "./types";

/** Every playground action addresses its subject the same way: by session id. */
export interface PlaygroundActionInput {
  agent: StoredAgent;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// The school rule — resolved once, applied by every export
// ---------------------------------------------------------------------------

type ResolvedSession =
  | { ok: true; session: PlaygroundSession }
  | { ok: false; result: ActionResult<never> };

/**
 * Resolve the session and apply the school rule — the pair every playground mutation starts with.
 *
 * **The SESSION's school decides, not the request's host** (M11-1 C20 review round 5). Session ids
 * are public — `GET /api/v1/playground/sessions` lists them — so without this an AO-unadmitted but
 * Foundation-vetted agent could name an AO session, call the Foundation host and take part under
 * the weaker rule. Participation drives billed GM inference, which is the spend C20 keeps behind
 * the access rule.
 *
 * **Absence is NOT reported here.** It is the caller's own refusal to render, and the two surfaces
 * render it differently (the join route answers 400, the action route 404). Answering "denied" for
 * a nonexistent id would also leak which ids exist.
 */
async function resolveSession(input: PlaygroundActionInput): Promise<ResolvedSession> {
  const session = await getPlaygroundSession(input.sessionId);
  if (!session) return { ok: false, result: actionError("not_found", "Session not found") };
  const denial = sessionSchoolAccessDenial(input.agent, session);
  if (denial) return { ok: false, result: actionError(denial.code, denial.error) };
  return { ok: true, session };
}

// ---------------------------------------------------------------------------
// joinSession
// ---------------------------------------------------------------------------

export interface JoinSessionInput extends PlaygroundActionInput {
  actingAsCompanyId?: string;
  actingAsLabel?: string;
  prefabId?: string;
}

export interface JoinSessionResult {
  session: PlaygroundSession;
}

/**
 * Join a pending session.
 *
 * The store decides between appending the participant and refreshing their affiliation fields in
 * ONE conditional statement, so exactly one of the two events can exist and an identical re-join
 * emits neither. Both are handed down together because the action cannot know which branch the
 * statement will take — and must not decide it from a pre-read, which is what the two whole-column
 * read-modify-writes this replaces effectively did.
 *
 * `session_not_found` is reported through `not_found`; every other domain refusal keeps the message
 * both surfaces already map to their own codes (`Session full`, `Session is not in pending state`,
 * `invalid_prefab_id`, the AO-only affiliation rule).
 */
export async function joinSession(input: JoinSessionInput): Promise<ActionResult<JoinSessionResult>> {
  const resolved = await resolveSession(input);
  if (!resolved.ok) return resolved.result;
  const schoolId = resolved.session.schoolId ?? null;

  try {
    const session = await domainJoinSession(
      input.sessionId,
      input.agent.id,
      {
        ...(input.actingAsCompanyId === undefined ? {} : { actingAsCompanyId: input.actingAsCompanyId }),
        ...(input.actingAsLabel === undefined ? {} : { actingAsLabel: input.actingAsLabel }),
        ...(input.prefabId === undefined ? {} : { prefabId: input.prefabId }),
      },
      {
        joined: [
          {
            ...playgroundSubjects({ sessionId: input.sessionId, actorAgentId: input.agent.id, schoolId }),
            kind: "playground.session_joined",
            payload: {},
          } satisfies PreparedEvent<"playground.session_joined">,
        ],
        affiliationUpdated: [
          {
            ...playgroundSubjects({ sessionId: input.sessionId, actorAgentId: input.agent.id, schoolId }),
            kind: "playground.participant_affiliation_updated",
            // Store-assigned: WHICH fields actually moved is a diff only the statement holding the
            // committed array can make. A list of the fields the REQUEST offered would record three
            // where one changed.
            payload: { fields: [STORE_ASSIGNED_PAYLOAD_ID] },
          } satisfies PreparedEvent<"playground.participant_affiliation_updated">,
        ],
      }
    );
    return actionOk({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to join session";
    return message === "Session not found"
      ? actionError("not_found", message)
      : actionError("bad_request", message);
  }
}

// ---------------------------------------------------------------------------
// submitAction
// ---------------------------------------------------------------------------

export interface SubmitActionInput extends PlaygroundActionInput {
  /** Already trimmed by the adapter, which owns its own input rules. */
  content: string;
  /**
   * An adapter's own input refusal, deferred so **authorization still runs first**.
   *
   * The two surfaces do not share content rules — the REST route bounds the length at 2000
   * characters and the tool never has — so moving that rule into the action would silently add a
   * refusal to the tool. But the route ran its school gate BEFORE reading the body, and Locked
   * decision 3 says a refused principal reaches no validation: handing the message down rather than
   * answering it in the adapter is what keeps that order without the action owning the rule.
   *
   * Nothing is written when it is set, and no event is emitted.
   */
  refuseWith?: string;
  /**
   * M11-2 P3.3 (u6 stitch): the runner's statement-level execution guard, threaded to the gated
   * insert. Populated ONLY by `agent-pulse/runner.ts` (through the `submit_playground_action` tool's
   * executor context); REST callers never supply one — see `ExecutionGuard` and `actions/types.ts`'s
   * `execution_guard_failed` code.
   */
  executionGuard?: ExecutionGuard;
}

export interface SubmitActionResult {
  session: PlaygroundSession;
  action: SessionAction;
}

/**
 * Submit this round's action.
 *
 * The event rides the insert's own CTE, gated on `ON CONFLICT DO NOTHING` — the duplicate-race
 * loser inserts nothing and emits nothing, so there is no ghost event and no manufactured identity
 * for a row it never wrote.
 *
 * **The payload is the `(session_id, round, agent_id)` triple and the `idem_key` is the same
 * triple.** `submitAction` returns the session and discards nothing else the contract promises, so
 * the event deliberately does not carry the action row's id; the consumer resolves the authoritative
 * row by that unique key at consume time. The idem key is defense in depth: a producer retried
 * across a crash cannot write the event twice.
 *
 * The round comes from the session the STORE read under its own lock, not from this action — an
 * action layer that named a round from a pre-read would stamp a key for a round that had moved.
 */
export async function submitAction(input: SubmitActionInput): Promise<ActionResult<SubmitActionResult>> {
  const resolved = await resolveSession(input);
  if (!resolved.ok) return resolved.result;
  // After the gate, before the write — the order the route used to get by reading its body last.
  if (input.refuseWith) return actionError("bad_request", input.refuseWith);

  try {
    const result = await domainSubmitAction(input.sessionId, input.agent.id, input.content, (round) => [
      {
        ...playgroundSubjects({
          sessionId: input.sessionId,
          actorAgentId: input.agent.id,
          schoolId: resolved.session.schoolId ?? null,
        }),
        kind: "playground.action_submitted",
        idemKey: `playground_action:${input.sessionId}:${round}:${input.agent.id}`,
        payload: { session_id: input.sessionId, round, agent_id: input.agent.id },
      } satisfies PreparedEvent<"playground.action_submitted">,
    ], input.executionGuard);
    return actionOk(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit action";
    // M11-2 P3.3 (u6 stitch): the ONE refusal this domain service raises that is not a caller error.
    // Matched by identity against the service's own constant, not a copied literal. The runner is the
    // only caller that can ever see it, and it reads the CODE, not the copy.
    if (message === SUBMIT_REFUSAL_MESSAGES.execution_guard_failed) {
      return actionError("execution_guard_failed", message);
    }
    return actionError("bad_request", message);
  }
}

// ---------------------------------------------------------------------------
// cancelSession
// ---------------------------------------------------------------------------

export interface CancelSessionInput extends PlaygroundActionInput {
  /** Stored verbatim; the adapter owns the emptiness and length refusals (M11-1b review B10). */
  reason: string;
}

/**
 * Cancel a session — **participant-scoped, and the authorization IS the gate**.
 *
 * The store's conditional UPDATE carries the participant containment, so a nonparticipant matches
 * zero rows, writes nothing and emits nothing; the outcome is passed back unchanged because both
 * surfaces already render its four cases.
 *
 * **No school gate, deliberately** — recorded rather than added. Containment already refuses a
 * stranger, and adding a school refusal here would leave an agent whose admission was revoked with
 * no way to leave a session it is listed in. `m11-2-u3d-playground-characterization.test.ts` pins
 * that as a recorded behavior so a later change is visible.
 */
export async function cancelSession(input: CancelSessionInput): Promise<ActionResult<CancelPlaygroundOutcome>> {
  const session = await getPlaygroundSession(input.sessionId);
  const outcome = await storeCancelSession(input.sessionId, input.agent.id, input.reason, [
    {
      ...playgroundSubjects({
        sessionId: input.sessionId,
        actorAgentId: input.agent.id,
        schoolId: session?.schoolId ?? null,
      }),
      kind: "playground.session_cancelled",
      payload: {},
    } satisfies PreparedEvent<"playground.session_cancelled">,
  ]);
  return actionOk(outcome);
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

export interface CreateSessionActionInput {
  agent: StoredAgent;
  gameId?: string;
  /** The requesting school, so the session is scoped and listed by it. */
  schoolId: string;
}

/**
 * Create a pending session through the domain entry point.
 *
 * **No school gate**, and for the reason `createGroup` has none: there is no session yet to be
 * owned by another school, and the creation is scoped to the school the request arrived on — which
 * is the rule the REST surface already applied.
 *
 * The domain service raises for a live session, an unknown game and a lost unique index; the route
 * has always rendered every one of those as a 500 carrying the message, so the classification stays
 * a single `bad_request` and the adapter keeps its own status.
 */
export async function createSession(
  input: CreateSessionActionInput
): Promise<ActionResult<{ session: PlaygroundSession }>> {
  try {
    const session = await domainCreatePendingSession(input.gameId, input.schoolId, [
      playgroundSessionCreatedEvent({ actorAgentId: input.agent.id, schoolId: input.schoolId }),
    ]);
    return actionOk({ session });
  } catch (error) {
    return actionError("bad_request", error instanceof Error ? error.message : "Internal server error");
  }
}
