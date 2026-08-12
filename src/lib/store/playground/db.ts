import { sql } from "@/lib/db";
import type { StoredRecentPlaygroundAction } from "@/lib/store-types";
import type { PreparedEvent } from "@/lib/events/kinds";
import type {
    CancelPlaygroundOutcome,
    PlaygroundSession,
    CreateSessionInput,
    UpdateSessionInput,
    CreateActionInput,
    SessionAction,
    SessionParticipant,
    PlaygroundSessionListOptions,
    ResolutionMemory,
    SubmitActionOutcome,
} from '@/lib/playground/types';
import { PLAYGROUND_SYSTEM_EXPIRED_REASON } from '@/lib/playground/types';
import {
    buildPlaygroundActionActivityUpsertCtes,
    buildPlaygroundSessionActivityUpsertCtes,
    recordPlaygroundActionActivityEvent,
    recordPlaygroundSessionActivityEvent,
} from "../activity/events";
import { emitEventCtes, sqlColumn, sqlJsonAgg, sqlParam, sqlPayloadObject } from "../events/statement";
import type { ActingJoinPatch } from "@/lib/playground/acting-affiliation";
import type { PlaygroundJoinOutcome } from "./join-outcome";

/**
 * **Every producer here writes its transitional trail row INSIDE its own statement** (u3d fix round,
 * finding 2).
 *
 * Until that round each of the seven emitting statements committed its mutation and its event and
 * *then* called the best-effort `recordPlayground*ActivityEvent` wrapper — a second auto-committed
 * statement whose failure is swallowed. A crash or an upsert error in that gap left the event
 * committed with no legacy projection at all: the drain stamps `legacy_missing`, and `shadow` records
 * only diagnostics, so the public trail row is simply absent and nothing ever writes it. CLAUDE.md
 * states the rule the gap broke — *a transitional projection must be written by the statement that
 * emitted its event* — and the splice restores it: mutation, event and projection commit together or
 * not at all.
 *
 * Two consequences worth stating, because both are load-bearing:
 *
 *  - **The decisive CTE must `RETURNING *`.** The projection reads the SESSION ROW from that CTE, not
 *    from `playground_sessions`: a CTE reads the statement's snapshot, so the table would hand back
 *    the PRE-mutation values and the trail would say `active` for a session the same statement just
 *    cancelled.
 *  - **Nothing post-stamps any more.** There is no `emitted_event_id` projection left to decode —
 *    `source_event_id` is read straight out of the event arm by the spliced upsert, which is the only
 *    place the pair exists atomically.
 *
 * **Playground needs the event's id and NOT its clock.** Both playground trail rows project a
 * timestamp the SUBJECT already carries — the session row's
 * `COALESCE(started_at, completed_at, created_at)` and the action row's `created_at` — so the consumer
 * re-reading either projects the same instant the inline writer does. Stamping the event's
 * `created_at` would *introduce* the mismatch `OCCURRED_AT_STAMP_PENDING_KINDS` exists to prevent,
 * exactly as it would have for `post.created`.
 */
function spliceCtes(ctes: readonly string[]): string {
    return ctes.length > 0 ? `, ${ctes.join(", ")}` : "";
}

export async function listRecentPlaygroundActions(limit = 25): Promise<StoredRecentPlaygroundAction[]> {
    const rows = await sql!`
    SELECT a.id, a.session_id, a.agent_id, a.round, a.content, a.created_at,
      s.game_id, s.status AS session_status
    FROM playground_actions a
    LEFT JOIN playground_sessions s ON s.id = a.session_id
    ORDER BY a.created_at DESC
    LIMIT ${limit}
  `;
    return (rows as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        sessionId: r.session_id as string,
        agentId: r.agent_id as string,
        round: Number(r.round),
        content: r.content as string,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        gameId: (r.game_id as string | undefined) ?? "playground",
        sessionStatus: (r.session_status as string | undefined) ?? "unknown",
    }));
}

function rowToPlaygroundSession(r: Record<string, unknown>): PlaygroundSession {
    return {
        id: r.id as string,
        gameId: r.game_id as string,
        schoolId: (r.school_id as string | undefined) ?? "foundation",
        status: r.status as PlaygroundSession['status'],
        participants: (r.participants as PlaygroundSession['participants']) ?? [],
        transcript: (r.transcript as PlaygroundSession['transcript']) ?? [],
        currentRound: Number(r.current_round),
        currentRoundPrompt: r.current_round_prompt as string | undefined,
        roundDeadline: r.round_deadline ? String(r.round_deadline) : undefined,
        maxRounds: Number(r.max_rounds),
        summary: r.summary as string | undefined,
        createdAt: String(r.created_at),
        startedAt: r.started_at ? String(r.started_at) : undefined,
        completedAt: r.completed_at ? String(r.completed_at) : undefined,
        metadata: r.metadata as Record<string, unknown> | undefined,
        resolveClaimToken: (r.resolve_claim_token as string | null | undefined) ?? null,
        resolveClaimExpiresAt: r.resolve_claim_expires_at ? String(r.resolve_claim_expires_at) : null,
        cancelledAt: r.cancelled_at ? String(r.cancelled_at) : null,
        cancelledByAgentId: (r.cancelled_by_agent_id as string | null | undefined) ?? null,
        cancelledReason: (r.cancelled_reason as string | null | undefined) ?? null,
    };
}

function rowToSessionAction(r: Record<string, unknown>): SessionAction {
    return {
        id: r.id as string,
        sessionId: r.session_id as string,
        agentId: r.agent_id as string,
        round: Number(r.round),
        content: r.content as string,
        createdAt: String(r.created_at),
    };
}

/**
 * Public agent history — cancelled sessions excluded, and the exclusion is load-bearing.
 *
 * Before M11-1 C3 cancellation was a hard DELETE, so a cancelled session left no row and every
 * public reader omitted it for free. C3 made cancellation an attributed *transition*, which keeps
 * the row — so every public reader that did not filter silently started showing cancelled
 * sessions. `/u/{name}` renders this list and derives its playground stat from it, and the pinned
 * contract (CLAUDE.md, C3) is that the API exposes `status: "cancelled"` while the public UI
 * continues to omit it. The filter is what keeps that true now that the row survives.
 */
export async function getPlaygroundSessionsByAgentId(agentId: string, limit: number = 5): Promise<PlaygroundSession[]> {
    const rows = await sql!`
        SELECT * FROM playground_sessions
        WHERE participants @> ${JSON.stringify([{ agentId }])}::jsonb
          AND status <> 'cancelled'
        ORDER BY created_at DESC
        LIMIT ${limit}
    `;
    return (rows as Record<string, unknown>[]).map(rowToPlaygroundSession);
}

/** Same public contract as the list above: a cancelled session is not counted. */
export async function getPlaygroundSessionCountByAgentId(agentId: string): Promise<number> {
    const rows = await sql!`
        SELECT COUNT(*)::int AS count FROM playground_sessions
        WHERE participants @> ${JSON.stringify([{ agentId }])}::jsonb
          AND status <> 'cancelled'
    `;
    return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}

/**
 * Create a playground session — the row and `playground.session_created`, in ONE statement
 * (M11-2 P1.4).
 *
 * It used to be an insert, then a re-read, then the projection write. The insert is now the
 * decision and everything hangs off its own `RETURNING`: a creation that loses the live-session
 * partial unique index raises 23505 and emits nothing, and the caller receives the row the insert
 * itself produced rather than whatever a second read happens to find.
 *
 * `subject_id` is store-assigned positionally on the primary event — `$1` is the id, still a bound
 * parameter, because the action cannot name a column the statement has not written yet.
 */
export async function createPlaygroundSession(
    input: CreateSessionInput,
    events?: readonly PreparedEvent[]
): Promise<PlaygroundSession> {
    const now = new Date().toISOString();
    const params: unknown[] = [
        input.id,
        input.gameId,
        input.status,
        JSON.stringify(input.participants),
        input.currentRound,
        input.currentRoundPrompt || null,
        input.roundDeadline || null,
        input.maxRounds,
        now,
        input.startedAt || null,
        input.schoolId || 'foundation',
    ];
    const emitted = emitEventCtes(events, "created", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
    });
    const trail = buildPlaygroundSessionActivityUpsertCtes({
        sessionCte: "created",
        sourceEventCtes: emitted.names.slice(0, 1),
    });
    const rows = await sql!(
        `
    WITH created AS (
      INSERT INTO playground_sessions (id, game_id, status, participants, transcript, current_round, current_round_prompt, round_deadline, max_rounds, created_at, started_at, school_id)
      VALUES ($1::text, $2::text, $3::text, $4::jsonb, '[]'::jsonb, $5::int, $6::text, $7::timestamptz, $8::int, $9::timestamptz, $10::timestamptz, $11::text)
      RETURNING *
    )${spliceCtes(emitted.ctes)}${spliceCtes(trail)}
    SELECT created.* FROM created
  `,
        [...params, ...emitted.params]
    );
    return rowToPlaygroundSession(rows[0] as Record<string, unknown>);
}

export async function getPlaygroundSession(id: string): Promise<PlaygroundSession | null> {
    const rows = await sql!`SELECT * FROM playground_sessions WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToPlaygroundSession(r) : null;
}

export async function listPlaygroundSessions(options?: PlaygroundSessionListOptions): Promise<PlaygroundSession[]> {
    const status = options?.status;
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const schoolId = options?.schoolId;
    let rows;
    
    if (schoolId) {
        if (status) {
            rows = await sql!`
              SELECT * FROM playground_sessions
              WHERE status = ${status} AND (school_id = ${schoolId} OR (${schoolId} = 'foundation' AND school_id IS NULL))
              ORDER BY created_at DESC
              LIMIT ${limit} OFFSET ${offset}
            `;
        } else {
            rows = await sql!`
              SELECT * FROM playground_sessions
              WHERE (school_id = ${schoolId} OR (${schoolId} = 'foundation' AND school_id IS NULL))
              ORDER BY created_at DESC
              LIMIT ${limit} OFFSET ${offset}
            `;
        }
    } else {
        if (status) {
            rows = await sql!`
              SELECT * FROM playground_sessions
              WHERE status = ${status}
              ORDER BY created_at DESC
              LIMIT ${limit} OFFSET ${offset}
            `;
        } else {
            rows = await sql!`
              SELECT * FROM playground_sessions
              ORDER BY created_at DESC
              LIMIT ${limit} OFFSET ${offset}
            `;
        }
    }
    return (rows as Record<string, unknown>[]).map(rowToPlaygroundSession);
}

/**
 * The sessions the lifetime cap is actually DUE to complete — **the age predicate is in the query**
 * (u3d fix round, finding 4).
 *
 * `enforceSessionLifetimeCap` used to read the 50 NEWEST active sessions and filter them by age in
 * JavaScript. With 51 live sessions the oldest is not in that window at all, so a session that had
 * already blown its budget was skipped by every sweep while the newest 50 were still young —
 * continuous creation stranded it indefinitely. Selecting the due candidates directly, OLDEST FIRST,
 * inverts that: the sweep always sees the sessions that have waited longest, and a run capped by
 * `limit` resumes from the same end next time.
 *
 * `completed_at IS NULL` is part of the predicate rather than a caller-side `continue`, and that is
 * what makes paging terminate: every row this returns is one the conditional completion either
 * transitions (leaving `status = 'active'`) or loses to a writer that already changed one of the two
 * columns. Either way the row is gone from the next page, so the caller can page until a page comes
 * back short without an offset that a concurrent completion would shift under it.
 */
export async function listSessionsDueForLifetimeCap(
    cutoff: string,
    limit: number
): Promise<PlaygroundSession[]> {
    const rows = await sql!`
      SELECT * FROM playground_sessions
      WHERE status = 'active'
        AND completed_at IS NULL
        AND COALESCE(started_at, created_at) <= ${cutoff}::timestamptz
      ORDER BY COALESCE(started_at, created_at) ASC
      LIMIT ${Math.max(1, Math.floor(limit))}
    `;
    return (rows as Record<string, unknown>[]).map(rowToPlaygroundSession);
}

export async function updatePlaygroundSession(id: string, updates: UpdateSessionInput): Promise<boolean> {
    // Build COALESCE-based update to only update provided fields
    await sql!`
    UPDATE playground_sessions SET
      status = COALESCE(${updates.status ?? null}, status),
      participants = COALESCE(${updates.participants ? JSON.stringify(updates.participants) : null}::jsonb, participants),
      transcript = COALESCE(${updates.transcript ? JSON.stringify(updates.transcript) : null}::jsonb, transcript),
      current_round = COALESCE(${updates.currentRound ?? null}, current_round),
      current_round_prompt = (CASE WHEN ${updates.currentRoundPrompt === null} THEN NULL ELSE COALESCE(${updates.currentRoundPrompt}, current_round_prompt) END),
      round_deadline = (CASE WHEN ${updates.roundDeadline === null} THEN NULL ELSE COALESCE(${updates.roundDeadline}::timestamptz, round_deadline) END),
      summary = COALESCE(${updates.summary ?? null}, summary),
      started_at = COALESCE(${updates.startedAt ?? null}::timestamptz, started_at),
      completed_at = COALESCE(${updates.completedAt ?? null}::timestamptz, completed_at)
    WHERE id = ${id}
  `;
    if (
        updates.status !== undefined ||
        updates.participants !== undefined ||
        updates.currentRoundPrompt !== undefined ||
        updates.summary !== undefined ||
        updates.startedAt !== undefined ||
        updates.completedAt !== undefined
    ) {
        await recordPlaygroundSessionActivityEvent(id);
    }
    return true;
}

export async function deletePlaygroundSession(id: string): Promise<boolean> {
    await sql!`
        DELETE FROM playground_sessions
        WHERE id = ${id}
    `;
    return true;
}

/**
 * M11-1 C3 — cancellation as one attributed conditional UPDATE. One statement is *sufficient*
 * because nothing is deleted: the `status IN (...)` predicate closes the cancel-vs-completion
 * race (a session that completed first matches zero rows), the participant containment is the
 * authorization (evaluated by the same statement that mutates), and the lease predicate gives an
 * in-flight paid resolution precedence — cancelling a claimed round would spend the money and
 * discard the result. A *lapsed* lease does not block: a crashed resolver must not make a session
 * uncancellable, and if its stalled write later arrives, C12's fence rejects it against the
 * now-cancelled row.
 *
 * The zero-row classification read is participant-scoped, so a nonparticipant's `not_found` is
 * byte-identical whether the session is completed, cancelled, or nonexistent.
 *
 * The episodic-memory sweep is a **data-modifying CTE of the same statement**, not a follow-up
 * call. Cancellation is a transition, so the session FK cascade never fires (M11-1 C3) and the
 * sweep has to be driven explicitly (M11-1b D5) — but driving it from a second autocommit
 * statement meant a failure between the two left a cancelled session with orphaned memories that
 * no retry could reach, because the retry matches zero rows against the now-cancelled status.
 * Postgres runs data-modifying CTEs exactly once and to completion whether or not the primary
 * query reads them, and this one targets a *different table*, so it is not the
 * cannot-touch-the-same-row-twice shape. Either both land or neither does.
 */
export async function cancelPlaygroundSession(
    sessionId: string,
    callerAgentId: string,
    reason: string,
    events?: readonly PreparedEvent[]
): Promise<CancelPlaygroundOutcome> {
    const params: unknown[] = [
        sessionId,
        callerAgentId,
        reason,
        JSON.stringify([{ agentId: callerAgentId }]),
    ];
    // Gated on `cancelled`, which is the participant-scoped transition itself: a nonparticipant, a
    // completed session and a live resolution lease all match zero rows, write nothing and emit
    // nothing. The authorization IS the gate — there is no separate check to drift from it.
    const emitted = emitEventCtes(events, "cancelled", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
    });
    const trail = buildPlaygroundSessionActivityUpsertCtes({
        sessionCte: "cancelled",
        sourceEventCtes: emitted.names.slice(0, 1),
    });
    const rows = await sql!(
        `
    WITH prior AS (
      SELECT status FROM playground_sessions WHERE id = $1::text
    ),
    cancelled AS (
      UPDATE playground_sessions
      SET status = 'cancelled',
          cancelled_at = NOW(),
          cancelled_by_agent_id = $2::text,
          cancelled_reason = $3::text
      WHERE id = $1::text
        AND status IN ('pending', 'active')
        AND participants @> $4::jsonb
        AND (resolve_claim_token IS NULL OR resolve_claim_expires_at <= NOW())
      -- The WHOLE row, because the trail projection spliced below reads the cancelled session from
      -- this CTE. Reading the playground_sessions TABLE there would answer with the pre-update snapshot
      -- publish a trail row that still says 'active'.
      RETURNING *
    ),
    swept AS (
      DELETE FROM playground_agent_memories
      WHERE session_id IN (SELECT id FROM cancelled)
      RETURNING agent_id
    )${spliceCtes(emitted.ctes)}${spliceCtes(trail)}
    SELECT cancelled.id, (SELECT status FROM prior) AS previous_status FROM cancelled
  `,
        [...params, ...emitted.params]
    );

    if (rows.length > 0) {
        return {
            outcome: 'cancelled',
            previousStatus: (rows[0] as { previous_status: string }).previous_status as 'pending' | 'active',
        };
    }

    const scoped = await sql!`
    SELECT status, resolve_claim_token, resolve_claim_expires_at
    FROM playground_sessions
    WHERE id = ${sessionId}
      AND participants @> ${JSON.stringify([{ agentId: callerAgentId }])}::jsonb
    LIMIT 1
  `;
    const row = scoped[0] as
        | { status: string; resolve_claim_token: string | null; resolve_claim_expires_at: Date | string | null }
        | undefined;
    if (!row) return { outcome: 'not_found' };
    if (row.status === 'pending' || row.status === 'active') {
        // The only way the update missed a live, participant-owned session is the lease predicate.
        return { outcome: 'resolution_in_progress' };
    }
    return { outcome: 'not_cancellable', status: row.status as PlaygroundSession['status'] };
}

/**
 * M11-1 C3 — the expiry sweep's system transition, replacing the old hard delete. The
 * `status = 'pending'` predicate closes the expiry-vs-activation race in-statement: a session
 * that activates mid-sweep matches zero rows. NULL actor + sentinel reason mark it system-expired.
 */
export async function expireStalePendingSessions(
    pendingTimeoutMs: number,
    events?: readonly PreparedEvent[]
): Promise<string[]> {
    const seconds = Math.max(1, Math.round(pendingTimeoutMs / 1000));
    const params: unknown[] = [PLAYGROUND_SYSTEM_EXPIRED_REASON, seconds];
    // **ONE event per expired row**, which is the `rowSource` shape: the sweep transitions a whole
    // batch in one statement, so a single constant event would describe one of them and lose the
    // rest. `subject_id` is the row's own id, read as a column of the row source — the only form
    // that can vary per row — and the insert stays gated on `expired`, so a sweep that matched
    // nothing emits nothing.
    const emitted = emitEventCtes(events, "expired", {
        firstParamIndex: params.length + 1,
        overrides: events?.length
            ? [{ rowSource: "expired", columnSql: { subject_id: sqlColumn("expired.id", "text") } }]
            : [],
    });
    // **One projected trail row per expired session, each stamped by its OWN event.** The row source
    // is the sweep's own CTE, so the upsert fans out exactly as the event insert does; the stamp is
    // correlated by SUBJECT, never by position, because sibling data-modifying CTEs execute in an
    // unspecified order and "the lower event id is the first row" is not a fact this statement
    // establishes (agents.md, the prepared-events invariants).
    const trail = buildPlaygroundSessionActivityUpsertCtes({
        sessionCte: "expired",
        sourceEventCtes: emitted.names.slice(0, 1),
        correlateBySubject: true,
    });
    const rows = await sql!(
        `
    WITH expired AS (
      UPDATE playground_sessions
      SET status = 'cancelled',
          cancelled_at = NOW(),
          cancelled_by_agent_id = NULL,
          cancelled_reason = $1::text
      WHERE status = 'pending'
        AND created_at <= NOW() - make_interval(secs => $2::int)
      RETURNING *
    )${spliceCtes(emitted.ctes)}${spliceCtes(trail)}
    SELECT expired.id FROM expired
  `,
        [...params, ...emitted.params]
    );
    return (rows as Array<{ id: string }>).map((row) => row.id);
}

/**
 * The lifetime cap's completion — a CONDITIONAL transition carrying `playground.session_completed`
 * with `payload.reason: 'lifetime_cap'` (M11-2 P1.4).
 *
 * `enforceSessionLifetimeCap` used to force-complete through the generic `updatePlaygroundSession`,
 * whose `WHERE id = $1` matches whatever it finds and whose boolean return is an unconditional
 * `true`. That is not a gate an event can ride: two sweeps overlapping, or a sweep racing a genuine
 * GM completion, would each have "succeeded" and each emitted. The predicate here is the one the
 * caller actually means — still active, not already completed — so exactly one of them writes and
 * exactly one event exists.
 */
export async function completePlaygroundSessionAtLifetimeCap(
    sessionId: string,
    input: { summary: string; completedAt: string },
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    const params: unknown[] = [sessionId, input.summary, input.completedAt];
    const emitted = emitEventCtes(events, "capped", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
    });
    const trail = buildPlaygroundSessionActivityUpsertCtes({
        sessionCte: "capped",
        sourceEventCtes: emitted.names.slice(0, 1),
    });
    const rows = await sql!(
        `
    WITH capped AS (
      UPDATE playground_sessions
      SET status = 'completed',
          summary = COALESCE(summary, $2::text),
          completed_at = $3::timestamptz,
          current_round_prompt = NULL,
          round_deadline = NULL
      WHERE id = $1::text
        AND status = 'active'
        AND completed_at IS NULL
      RETURNING *
    )${spliceCtes(emitted.ctes)}${spliceCtes(trail)}
    SELECT capped.id FROM capped
  `,
        [...params, ...emitted.params]
    );
    return rows.length > 0;
}

/** The three affiliation fields a re-join may fill, in the order the event's payload sorts them. */
export const PLAYGROUND_AFFILIATION_FIELDS = [
    "actingAsCompanyId",
    "actingAsLabel",
    "actingAsDisplaySummary",
] as const;

/**
 * Join a playground session — **ONE conditional statement** for the append, the affiliation merge,
 * both events and the classification (M11-2 P1.4).
 *
 * It used to be three auto-committed statements and then a fourth: a membership pre-read, the
 * atomic append, a classification re-read, and then `mergePlaygroundParticipantAffiliationFields`
 * as a *separate* whole-column rewrite that ran **even when the append had no-opped**. The
 * participant list is mutable JSONB with no per-element row, so two writers of it in two statements
 * is exactly the shape that loses a concurrent join — and an event coupled to either half alone
 * would be a ghost for the other.
 *
 * The one statement decides between two **mutually exclusive** branches over the same row:
 *
 *  - `do_append` — not a member, still pending, still under capacity. The participant JSON already
 *    carries its affiliation fields, so there is nothing to merge afterwards.
 *  - `do_merge` — already a member, and the fill-if-empty rewrite would actually CHANGE the array.
 *
 * Neither ⇒ the `UPDATE` matches no row: nothing written, nothing emitted. That is what makes a
 * re-join with identical fields idempotent instead of a silent trail refresh.
 *
 * **`FOR UPDATE` on `prior` is what serialises the array**, and it is the same lock
 * `submitPlaygroundActionGated` takes. Two joins by two agents queue on it and each rebuilds the
 * array from the value the other committed; the pre-C23 shape let both read one snapshot and one
 * append vanish.
 *
 * **The classification is PROJECTED, never re-read.** `prior` is read under that lock inside this
 * statement, so "not pending" and "full" describe the instant the write was decided — a re-read
 * after a concurrent activation reported "not pending" for a join that had really succeeded.
 */
export async function joinPlaygroundSessionWithOutcome(
    sessionId: string,
    participant: SessionParticipant,
    maxPlayers: number,
    events?: {
        /** Gated on the append branch. */
        joined?: readonly PreparedEvent[];
        /** Gated on the merge branch; its `fields` payload is filled by the statement. */
        affiliationUpdated?: readonly PreparedEvent[];
    }
): Promise<PlaygroundJoinOutcome> {
    const membership = JSON.stringify([{ agentId: participant.agentId }]);
    const affiliation = participant as Partial<Record<(typeof PLAYGROUND_AFFILIATION_FIELDS)[number], string>>;
    const params: unknown[] = [
        sessionId,
        participant.agentId,
        JSON.stringify([participant]),
        membership,
        affiliation.actingAsCompanyId?.trim() ?? "",
        affiliation.actingAsLabel?.trim() ?? "",
        affiliation.actingAsDisplaySummary?.trim() ?? "",
        maxPlayers,
    ];
    // Two renders, one statement — the composition `emitEventCtes` documents. Distinct prefixes so
    // the CTE names cannot collide, a moving `firstParamIndex`, and a PINNED `callerParamBoundary`:
    // the second render's own start sits above the first render's placeholders, and without the pin
    // a `sqlParam` there could silently read a prior EVENT's bound column.
    const callerParamBoundary = params.length + 1;
    const joinedEmit = emitEventCtes(events?.joined, "appended", {
        firstParamIndex: callerParamBoundary,
        callerParamBoundary,
        // Distinct prefixes are what make two renders compose: names restart at index 0 on every
        // call, so a shared prefix would define `ev_0` twice and the statement would not parse.
        namePrefix: "joined_ev",
        overrides: events?.joined?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
    });
    const affiliationEmit = emitEventCtes(events?.affiliationUpdated, "refreshed", {
        firstParamIndex: callerParamBoundary + joinedEmit.params.length,
        callerParamBoundary,
        namePrefix: "affiliation_ev",
        overrides: events?.affiliationUpdated?.length
            ? [
                  {
                      columnSql: { subject_id: sqlParam(1, "text") },
                      // The fields that actually MOVED, aggregated from the statement's own diff —
                      // never the fields the request offered. A request may supply three and change
                      // one, and history must record the one.
                      payloadMergeSql: sqlPayloadObject({
                          fields: sqlJsonAgg({ cte: "affiliation_fields", column: "field" }),
                      }),
                  },
              ]
            : [],
    });
    const eventCtes = [...joinedEmit.ctes, ...affiliationEmit.ctes];
    // ONE projection for BOTH branches — they are mutually exclusive arms of one `UPDATE`, so the
    // row source is `written` and the stamp is the first non-null of the two event arms. Splicing it
    // here rather than post-committing it is what makes a join and its event indivisible.
    //
    // **All arms or none, and that is not tidiness.** The stamp is a COALESCE over the arms, so a
    // caller that renders only ONE of them leaves the OTHER branch's write with a NULL
    // `source_event_id` — and the monotonic guard compares `<= NULL`, which is NULL, so an EXISTING
    // trail row would silently not refresh at all. Every production caller
    // (`actions/playground.joinSession`) supplies both. A partial caller gets the pre-stamp
    // behaviour — a plain upsert with no watermark — rather than a lost projection.
    const joinedArm = joinedEmit.names[0];
    const affiliationArm = affiliationEmit.names[0];
    const trail = buildPlaygroundSessionActivityUpsertCtes({
        sessionCte: "written",
        sourceEventCtes: joinedArm && affiliationArm ? [joinedArm, affiliationArm] : [],
    });

    const rows = await sql!(
        `
    WITH prior AS (
      SELECT ps.*,
             (ps.participants @> $4::jsonb) AS is_member,
             jsonb_array_length(COALESCE(ps.participants, '[]'::jsonb)) AS participant_count
      FROM playground_sessions ps
      WHERE ps.id = $1::text
      FOR UPDATE
    ),
    -- The fill-if-empty rewrite, in-statement and over the committed array (M11-1b review B3):
    -- only this agent's element is touched, and only its still-empty affiliation fields. Every
    -- other element passes through unchanged, including one a racing join just appended.
    rewritten AS (
      SELECT p.id,
             (SELECT COALESCE(jsonb_agg(
                CASE WHEN elem->>'agentId' = $2::text THEN
                  elem
                  || (CASE WHEN $5::text <> '' AND COALESCE(elem->>'actingAsCompanyId', '') = ''
                        THEN jsonb_build_object('actingAsCompanyId', $5::text) ELSE '{}'::jsonb END)
                  || (CASE WHEN $6::text <> '' AND COALESCE(elem->>'actingAsLabel', '') = ''
                        THEN jsonb_build_object('actingAsLabel', $6::text) ELSE '{}'::jsonb END)
                  || (CASE WHEN $7::text <> '' AND COALESCE(elem->>'actingAsDisplaySummary', '') = ''
                        THEN jsonb_build_object('actingAsDisplaySummary', $7::text) ELSE '{}'::jsonb END)
                ELSE elem END
                ORDER BY ord), '[]'::jsonb)
              FROM jsonb_array_elements(p.participants) WITH ORDINALITY AS t(elem, ord)) AS participants
      FROM prior p
    ),
    plan AS (
      SELECT p.id,
             (NOT p.is_member AND p.status = 'pending' AND p.participant_count < $8::int) AS do_append,
             (p.is_member AND r.participants IS DISTINCT FROM p.participants) AS do_merge,
             r.participants AS merged_participants
      FROM prior p JOIN rewritten r ON r.id = p.id
    ),
    written AS (
      UPDATE playground_sessions ps
      SET participants = CASE WHEN pl.do_append THEN ps.participants || $3::jsonb ELSE pl.merged_participants END
      FROM plan pl
      WHERE ps.id = pl.id AND (pl.do_append OR pl.do_merge)
      RETURNING ps.*, pl.do_append
    ),
    appended AS (SELECT id FROM written WHERE do_append),
    refreshed AS (SELECT id FROM written WHERE NOT do_append),
    -- WHICH fields moved, per field, by diffing this agent's element before and after. Empty
    -- unless the merge branch fired, so the aggregate over it is an empty array on every other path.
    affiliation_fields AS (
      SELECT f.field
      FROM written w
      JOIN prior p ON p.id = w.id
      CROSS JOIN LATERAL (
        SELECT e.elem FROM jsonb_array_elements(w.participants) AS e(elem)
        WHERE e.elem->>'agentId' = $2::text LIMIT 1
      ) nw
      CROSS JOIN LATERAL (
        SELECT e.elem FROM jsonb_array_elements(p.participants) AS e(elem)
        WHERE e.elem->>'agentId' = $2::text LIMIT 1
      ) old
      CROSS JOIN LATERAL (
        VALUES ('actingAsCompanyId'), ('actingAsLabel'), ('actingAsDisplaySummary')
      ) AS f(field)
      WHERE NOT w.do_append
        AND COALESCE(nw.elem->>f.field, '') IS DISTINCT FROM COALESCE(old.elem->>f.field, '')
    )${spliceCtes(eventCtes)}${spliceCtes(trail)}
    SELECT (SELECT count(*) FROM prior)::int AS session_exists,
           (SELECT status FROM prior) AS prior_status,
           (SELECT is_member FROM prior) AS was_member,
           (SELECT participant_count FROM prior)::int AS participant_count,
           (SELECT count(*) FROM appended)::int AS appended,
           (SELECT count(*) FROM refreshed)::int AS refreshed,
           (SELECT COALESCE(jsonb_agg(field ORDER BY field), '[]'::jsonb) FROM affiliation_fields) AS changed_fields,
           (SELECT to_jsonb(w) FROM written w) AS written_row,
           (SELECT to_jsonb(p) FROM prior p) AS prior_row
  `,
        [...params, ...joinedEmit.params, ...affiliationEmit.params]
    );

    const row = (rows[0] ?? {}) as {
        session_exists?: number;
        prior_status?: string | null;
        was_member?: boolean | null;
        participant_count?: number | null;
        appended?: number;
        refreshed?: number;
        changed_fields?: string[] | null;
        written_row?: Record<string, unknown> | null;
        prior_row?: Record<string, unknown> | null;
    };

    if (!row.session_exists) return { result: "refused", reason: "Session not found" };
    const session = row.written_row
        ? rowToPlaygroundSession(row.written_row)
        : row.prior_row
          ? rowToPlaygroundSession(row.prior_row)
          : undefined;

    // Both branches' trail rows were written by the statement above, stamped by whichever event arm
    // fired — there is nothing left to do here but classify.
    if (row.appended) return { result: "appended", session };
    if (row.refreshed) {
        return {
            result: "affiliation_updated",
            session,
            affiliationFields: row.changed_fields ?? [],
        };
    }
    // Nothing was written. Which of the four reasons, decided from the SAME locked snapshot.
    if (row.was_member) return { result: "unchanged", session };
    if (row.prior_status !== "pending") return { result: "refused", reason: "Session not pending", session };
    if ((row.participant_count ?? 0) >= maxPlayers) {
        return { result: "refused", reason: "Session full", session };
    }
    return { result: "refused", reason: "Unknown error", session };
}

/**
 * The `{ success, session?, reason? }` projection a long tail of M11-1 gates pins.
 *
 * Same relationship `createComment` has to `createCommentWithOutcome`: the outcome form is the
 * writer, this drops the classification the action needs and keeps the shape everything else reads.
 * "Already joined" has always been reported as SUCCESS here — joining twice is idempotent.
 */
export async function joinPlaygroundSession(
    sessionId: string,
    participant: SessionParticipant,
    maxPlayers: number,
    events?: {
        joined?: readonly PreparedEvent[];
        affiliationUpdated?: readonly PreparedEvent[];
    }
): Promise<{ success: boolean; session?: PlaygroundSession; reason?: string }> {
    const outcome = await joinPlaygroundSessionWithOutcome(sessionId, participant, maxPlayers, events);
    return outcome.result === "refused"
        ? { success: false, reason: outcome.reason }
        : { success: true, session: outcome.session };
}

export async function mergePlaygroundParticipantAffiliationFields(
    sessionId: string,
    agentId: string,
    patch: ActingJoinPatch
): Promise<PlaygroundSession | null> {
    const company = patch.actingAsCompanyId?.trim() ?? "";
    const label = patch.actingAsLabel?.trim() ?? "";
    const summary = patch.actingAsDisplaySummary?.trim() ?? "";
    if (!company && !label && !summary) return null;

    // M11-1b review B3: one in-statement rewrite of the array, NOT a read-modify-write. The
    // previous shape read the whole participant list, patched one element in JS, and wrote the
    // whole list back in a second auto-committed call — so a concurrent join that committed
    // between the read and the write was erased even though it returned success. Here the array
    // is rebuilt from its committed value inside the same statement: only the caller's own
    // element is touched, and only its still-empty affiliation fields are filled (fill-if-empty,
    // matching mergeAffiliationIntoParticipant). Every other element, including one a racing join
    // just appended, passes through unchanged.
    const rows = await sql!`
    UPDATE playground_sessions ps
    SET participants = (
      SELECT jsonb_agg(
        CASE WHEN elem->>'agentId' = ${agentId} THEN
          elem
          || (CASE WHEN ${company} <> '' AND COALESCE(elem->>'actingAsCompanyId', '') = ''
                THEN jsonb_build_object('actingAsCompanyId', ${company}::text) ELSE '{}'::jsonb END)
          || (CASE WHEN ${label} <> '' AND COALESCE(elem->>'actingAsLabel', '') = ''
                THEN jsonb_build_object('actingAsLabel', ${label}::text) ELSE '{}'::jsonb END)
          || (CASE WHEN ${summary} <> '' AND COALESCE(elem->>'actingAsDisplaySummary', '') = ''
                THEN jsonb_build_object('actingAsDisplaySummary', ${summary}::text) ELSE '{}'::jsonb END)
        ELSE elem END
        ORDER BY ord
      )
      FROM jsonb_array_elements(ps.participants) WITH ORDINALITY AS t(elem, ord)
    )
    WHERE ps.id = ${sessionId}
      AND ps.participants @> ${JSON.stringify([{ agentId }])}::jsonb
    RETURNING *
  `;
    if (rows.length === 0) return null;
    await recordPlaygroundSessionActivityEvent(sessionId);
    return rowToPlaygroundSession(rows[0] as Record<string, unknown>);
}

export async function createPlaygroundAction(input: CreateActionInput): Promise<SessionAction> {
    const now = new Date().toISOString();
    await sql!`
    INSERT INTO playground_actions (id, session_id, agent_id, round, content, created_at)
    VALUES (${input.id}, ${input.sessionId}, ${input.agentId}, ${input.round}, ${input.content}, ${now})
  `;
    await recordPlaygroundActionActivityEvent(input.id);
    return {
        ...input,
        createdAt: now,
    };
}

function isUniqueViolation(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === '23505');
}

/**
 * M11-1 C12 — the decisive action insert, conditioned inside the statement.
 *
 * `submitAction`'s pre-checks (status, membership, forfeiture, duplicate) were separate reads, so
 * everything they verified could go stale before the blind insert. Here the INSERT ... SELECT
 * verifies live status, current round, an *active* participant entry (JSONB containment on
 * `{agentId, status}`), and an unclaimed (or lapsed) resolution lease — with the session row
 * taken FOR UPDATE, so the insert serializes against a resolver's claim or terminal CAS on the
 * same row. The `NOT EXISTS` plus the unique index close the duplicate race from both sides.
 *
 * Zero rows is a refusal; the follow-up read classifies which, for the caller's error copy. The
 * classification is advisory — the statement already refused — so its read racing another writer
 * costs accuracy of the message, never correctness of the state.
 */
export async function submitPlaygroundActionGated(
    input: CreateActionInput,
    events?: readonly PreparedEvent[]
): Promise<SubmitActionOutcome> {
    const params: unknown[] = [
        input.id,
        input.sessionId,
        input.agentId,
        input.round,
        input.content,
        JSON.stringify([{ agentId: input.agentId, status: 'active' }]),
    ];
    const emitted = emitEventCtes(events, "inserted", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(2, "text") } }] : [],
    });
    const trail = buildPlaygroundActionActivityUpsertCtes({
        actionCte: "inserted",
        sourceEventCtes: emitted.names.slice(0, 1),
    });
    let rows: Record<string, unknown>[];
    try {
        rows = (await sql!(
            `
      WITH inserted AS (
        INSERT INTO playground_actions (id, session_id, agent_id, round, content, created_at)
        SELECT $1::text, s.id, $3::text, $4::int, $5::text, NOW()
        FROM (
          SELECT id FROM playground_sessions
          WHERE id = $2::text
            AND status = 'active'
            AND current_round = $4::int
            AND (resolve_claim_token IS NULL OR resolve_claim_expires_at <= NOW())
            AND participants @> $6::jsonb
          FOR UPDATE
        ) s
        WHERE NOT EXISTS (
          SELECT 1 FROM playground_actions a
          WHERE a.session_id = $2::text AND a.round = $4::int AND a.agent_id = $3::text
        )
        -- **The duplicate-race loser inserts nothing and emits nothing** (P1.4's pinned mechanic).
        -- Before u3d the same race raised 23505, which rolled the whole statement back — harmless
        -- while the statement held only the insert, and a lost event the moment it also holds one.
        ON CONFLICT (session_id, agent_id, round) DO NOTHING
        RETURNING id, session_id, agent_id, round, content, created_at
      )${spliceCtes(emitted.ctes)}${spliceCtes(trail)}
      SELECT inserted.* FROM inserted
    `,
            [...params, ...emitted.params]
        )) as Record<string, unknown>[];
    } catch (error) {
        if (isUniqueViolation(error)) return { ok: false, reason: 'duplicate' };
        throw error;
    }

    if (rows.length > 0) return { ok: true, action: rowToSessionAction(rows[0]) };

    const session = await getPlaygroundSession(input.sessionId);
    if (!session) return { ok: false, reason: 'not_found' };
    if (session.status !== 'active') return { ok: false, reason: 'not_active' };
    const participant = session.participants.find((p) => p.agentId === input.agentId);
    if (!participant) return { ok: false, reason: 'not_participant' };
    if (participant.status === 'forfeited') return { ok: false, reason: 'forfeited' };
    if (session.currentRound !== input.round) return { ok: false, reason: 'stale_round' };
    const existing = await getPlaygroundActions(input.sessionId, input.round);
    if (existing.some((a) => a.agentId === input.agentId)) return { ok: false, reason: 'duplicate' };
    return { ok: false, reason: 'resolving' };
}

/**
 * M11-1 C12 — claim the current round for resolution. Succeeds only while the session is active
 * on exactly this round and no live lease exists (a lapsed lease is reclaimable).
 */
export async function claimPlaygroundResolution(
    sessionId: string,
    round: number,
    token: string,
    leaseMs: number
): Promise<boolean> {
    const leaseSeconds = Math.max(1, Math.round(leaseMs / 1000));
    const rows = await sql!`
    UPDATE playground_sessions
    SET resolve_claim_token = ${token},
        resolve_claim_expires_at = NOW() + make_interval(secs => ${leaseSeconds})
    WHERE id = ${sessionId}
      AND status = 'active'
      AND current_round = ${round}
      AND (resolve_claim_token IS NULL OR resolve_claim_expires_at <= NOW())
    RETURNING id
  `;
    return rows.length > 0;
}

/**
 * Renew a held lease mid-inference (GM calls routinely outlive a fixed lease). Token-fenced AND
 * liveness-fenced: an **expired** lease cannot be renewed (M11-1b review round 2, B1). Renewing a
 * dead lease would resurrect exactly the blocker the terminal fence closes — once a lease lapses
 * the gated insert admits new actions, so a stalled resolver whose delayed renewal timer fired
 * could revive its claim and then commit a pre-action transcript, silently dropping the accepted
 * action. A resolver that has lapsed must lose the round to a reclaimer, not reclaim it blindly.
 */
export async function renewPlaygroundResolutionClaim(
    sessionId: string,
    token: string,
    leaseMs: number
): Promise<boolean> {
    const leaseSeconds = Math.max(1, Math.round(leaseMs / 1000));
    const rows = await sql!`
    UPDATE playground_sessions
    SET resolve_claim_expires_at = NOW() + make_interval(secs => ${leaseSeconds})
    WHERE id = ${sessionId}
      AND resolve_claim_token = ${token}
      AND resolve_claim_expires_at > NOW()
    RETURNING id
  `;
    return rows.length > 0;
}

/**
 * M11-1 C12 — the terminal write of a claimed resolution: advancement or completion committed
 * through a (status, current_round, resolve_claim_token, LEASE LIVE) CAS, clearing the lease.
 * Zero rows is the loser — a reclaimer already resolved the round, OR the caller's own lease
 * lapsed. The lease-liveness clause is load-bearing (M11-1b review B2): once a lease lapses the
 * gated insert admits new actions for the round, so a stalled resolver committing its
 * pre-action transcript would silently drop an action that was accepted after its lease expired.
 * Rejecting the lapsed committer leaves the round for a reclaimer, which re-reads the full set.
 */
/**
 * The terminal resolution CAS, with the round's episodic memories written INSIDE it
 * (M11-1b D5 atomic follow-up).
 *
 * Before this, the memory upserts were a separate auto-committed statement gated on the *lease*,
 * and D5 recorded the gap honestly as a residual: a lease that lapsed between the memory write and
 * this CAS left a round's memory written for a round that never advanced, and a mid-loop failure
 * could leave some participants written and others not. Both are closed here by construction —
 * `stored` reads `advanced`'s `RETURNING`, so a losing CAS contributes zero rows to the insert, and
 * the whole set lands in one statement.
 *
 * Two Postgres facts this leans on, stated so nobody "simplifies" them away:
 * 1. A data-modifying CTE runs exactly once and to completion, so `stored` cannot be skipped; and
 * 2. reading `advanced` (the CTE's output) is the only way a sibling sees its rows — a fresh
 *    `SELECT … FROM playground_sessions` would read the pre-update snapshot and admit a loser.
 *
 * The top-level `SELECT` counts both arms rather than returning the insert's rows, because an
 * empty memory payload is legitimate (the all-forfeited path writes none) and would otherwise be
 * indistinguishable from a lost CAS.
 */
export async function applyPlaygroundResolution(
    sessionId: string,
    fence: { round: number; token: string },
    updates: UpdateSessionInput,
    memories: ResolutionMemory[] = [],
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    // One row per agent, last wins. `participants` is unvalidated JSONB, so an agent listed twice
    // would put two rows with the same conflict key into one insert — which Postgres rejects with
    // 21000 ("ON CONFLICT DO UPDATE command cannot affect row a second time"). Now that the insert
    // shares a statement with the advance, that would wedge the session permanently: every retry
    // rebuilds the same payload. Deduping here rather than in the caller keeps the rule where the
    // constraint is, and makes db mode agree with memory mode, whose map overwrites by the same key.
    const deduped = Array.from(new Map(memories.map((m) => [m.agentId, m])).values());
    const payload = JSON.stringify(
        deduped.map((m) => ({
            id: m.id,
            agent_id: m.agentId,
            agent_name: m.agentName,
            content: m.content,
            importance: m.importance,
            round_created: m.roundCreated,
            // Omitted rather than JSON-null when absent: `jsonb_to_recordset` maps a missing key to
            // SQL NULL, which is what a memory without an embedding must store.
            ...(m.embedding ? { embedding: m.embedding } : {}),
            created_at: m.createdAt,
        }))
    );
    // The CAS is the gate: a resolver that lost its lease advances nothing, writes no memories and
    // — since u3d — emits nothing. `advanceToNextRound` passes no events at all, because
    // `playground.round_resolved` is not in this build's kind union; only the COMPLETION branch
    // supplies one, and it names why the session ended.
    const casParams: unknown[] = [
        sessionId,
        updates.status ?? null,
        updates.participants ? JSON.stringify(updates.participants) : null,
        updates.transcript ? JSON.stringify(updates.transcript) : null,
        updates.currentRound ?? null,
        updates.currentRoundPrompt === null,
        updates.currentRoundPrompt ?? null,
        updates.roundDeadline === null,
        updates.roundDeadline ?? null,
        updates.summary ?? null,
        updates.completedAt ?? null,
        fence.round,
        fence.token,
        payload,
    ];
    const emitted = emitEventCtes(events, "advanced", {
        firstParamIndex: casParams.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
    });
    const trail = buildPlaygroundSessionActivityUpsertCtes({
        sessionCte: "advanced",
        sourceEventCtes: emitted.names.slice(0, 1),
    });
    const rows = await sql!(
        `
    /* d5:resolution-cas */
    WITH advanced AS (
      UPDATE playground_sessions SET
        status = COALESCE($2::text, status),
        participants = COALESCE($3::jsonb, participants),
        transcript = COALESCE($4::jsonb, transcript),
        current_round = COALESCE($5::int, current_round),
        current_round_prompt = (CASE WHEN $6::boolean THEN NULL ELSE COALESCE($7::text, current_round_prompt) END),
        round_deadline = (CASE WHEN $8::boolean THEN NULL ELSE COALESCE($9::timestamptz, round_deadline) END),
        summary = COALESCE($10::text, summary),
        completed_at = COALESCE($11::timestamptz, completed_at),
        resolve_claim_token = NULL,
        resolve_claim_expires_at = NULL
      WHERE id = $1::text
        AND status = 'active'
        AND current_round = $12::int
        AND resolve_claim_token = $13::text
        AND resolve_claim_expires_at > NOW()
      -- The whole row: the trail projection spliced below reads the ADVANCED session from here, and
      -- the playground_sessions TABLE would answer with this statement's pre-update snapshot.
      RETURNING *
    ), live_agents AS (
      -- Pinned, not merely read. A plain join would be a snapshot read: a delete committing between
      -- the join and the insert's FK check still raises 23503 and rolls back the advance with it.
      -- FOR KEY SHARE is exactly the lock the FK check itself takes, so either this pins the agent
      -- and the delete waits, or the delete wins and this re-reads it as absent and drops the row.
      -- What is guaranteed is that an agent is pinned before any tuple naming it reaches FK
      -- enforcement -- the insert consumes this CTE. The order in which the planner evaluates this
      -- CTE against the advanced CTE is NOT guaranteed and nothing relies on it: agent deletion goes
      -- agents -> playground_agent_memories and never asks for a session lock, so no cycle exists
      -- in either evaluation order.
      SELECT a.id FROM agents a
      WHERE a.id IN (SELECT jsonb_array_elements_text(jsonb_path_query_array($14::jsonb, '$[*].agent_id')))
      FOR KEY SHARE
    ), stored AS (
      INSERT INTO playground_agent_memories
        (id, agent_id, agent_name, session_id, content, importance, round_created, embedding, created_at)
      SELECT m.id, m.agent_id, m.agent_name, advanced.id, m.content, m.importance,
             m.round_created, m.embedding, m.created_at
      FROM advanced
      CROSS JOIN jsonb_to_recordset($14::jsonb) AS m(
        id text, agent_id text, agent_name text, content text, importance text,
        round_created int, embedding jsonb, created_at timestamptz
      )
      -- The memory insert must never be able to VETO the advance. playground_sessions.participants
      -- is JSONB with no FK, so an agent deleted mid-session stays listed as a participant, while
      -- playground_agent_memories.agent_id carries a hard FK: a bare insert would raise 23503 and,
      -- now that the two share a statement, take the round advance down with it. The session would
      -- then be permanently unresolvable, because every retry re-reads the same participant and
      -- re-raises. Joining the pinned live agents drops that participant's memory instead, which is
      -- the outcome the FK's ON DELETE CASCADE would have produced a moment later anyway.
      JOIN live_agents a ON a.id = m.agent_id
      ON CONFLICT (agent_id, session_id) DO UPDATE SET
        id = EXCLUDED.id,
        agent_name = EXCLUDED.agent_name,
        content = EXCLUDED.content,
        importance = EXCLUDED.importance,
        round_created = EXCLUDED.round_created,
        embedding = EXCLUDED.embedding,
        created_at = EXCLUDED.created_at
      RETURNING agent_id
    )${spliceCtes(emitted.ctes)}${spliceCtes(trail)}
    SELECT
      (SELECT count(*) FROM advanced) AS advanced_count,
      (SELECT count(*) FROM stored) AS stored_count
  `,
        [...casParams, ...emitted.params]
    );
    const row = rows[0] as Record<string, unknown>;
    return Number(row.advanced_count) > 0;
}

export async function getPlaygroundActions(sessionId: string, round: number): Promise<SessionAction[]> {
    const rows = await sql!`
    SELECT * FROM playground_actions
    WHERE session_id = ${sessionId} AND round = ${round}
    ORDER BY created_at ASC
  `;
    return (rows as Record<string, unknown>[]).map(rowToSessionAction);
}

export async function activatePlaygroundSession(
    sessionId: string,
    initialRound: number,
    roundDeadline: string,
    startedAt: string
): Promise<boolean> {
    const rows = await sql!`
        UPDATE playground_sessions
        SET status = 'active', 
            current_round = ${initialRound}, 
            round_deadline = ${roundDeadline}, 
            started_at = ${startedAt}
        WHERE id = ${sessionId} AND status = 'pending'
        RETURNING id
    `;
    if (rows.length > 0) {
        await recordPlaygroundSessionActivityEvent(sessionId);
    }
    return rows.length > 0;
}
