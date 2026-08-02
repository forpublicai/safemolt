import { sql } from "@/lib/db";
import type { StoredRecentPlaygroundAction } from "@/lib/store-types";
import type {
    CancelPlaygroundOutcome,
    PlaygroundSession,
    CreateSessionInput,
    UpdateSessionInput,
    CreateActionInput,
    SessionAction,
    SessionParticipant,
    PlaygroundSessionListOptions,
    SubmitActionOutcome,
} from '@/lib/playground/types';
import { PLAYGROUND_SYSTEM_EXPIRED_REASON } from '@/lib/playground/types';
import {
    recordPlaygroundActionActivityEvent,
    recordPlaygroundSessionActivityEvent,
} from "../activity/events";
import type { ActingJoinPatch } from "@/lib/playground/acting-affiliation";

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

export async function createPlaygroundSession(input: CreateSessionInput): Promise<PlaygroundSession> {
    const now = new Date().toISOString();
    await sql!`
    INSERT INTO playground_sessions (id, game_id, status, participants, transcript, current_round, current_round_prompt, round_deadline, max_rounds, created_at, started_at, school_id)
    VALUES (
      ${input.id},
      ${input.gameId},
      ${input.status},
      ${JSON.stringify(input.participants)}::jsonb,
      '[]'::jsonb,
      ${input.currentRound},
      ${input.currentRoundPrompt || null},
      ${input.roundDeadline || null},
      ${input.maxRounds},
      ${now},
      ${input.startedAt || null},
      ${input.schoolId || 'foundation'}
    )
    `;
    const rows = await sql!`SELECT * FROM playground_sessions WHERE id = ${input.id} LIMIT 1`;
    const session = rowToPlaygroundSession(rows[0] as Record<string, unknown>);
    await recordPlaygroundSessionActivityEvent(session.id);
    return session;
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
    reason: string
): Promise<CancelPlaygroundOutcome> {
    const rows = await sql!`
    WITH prior AS (
      SELECT status FROM playground_sessions WHERE id = ${sessionId}
    ),
    cancelled AS (
      UPDATE playground_sessions
      SET status = 'cancelled',
          cancelled_at = NOW(),
          cancelled_by_agent_id = ${callerAgentId},
          cancelled_reason = ${reason}
      WHERE id = ${sessionId}
        AND status IN ('pending', 'active')
        AND participants @> ${JSON.stringify([{ agentId: callerAgentId }])}::jsonb
        AND (resolve_claim_token IS NULL OR resolve_claim_expires_at <= NOW())
      RETURNING id
    ),
    swept AS (
      DELETE FROM playground_agent_memories
      WHERE session_id IN (SELECT id FROM cancelled)
      RETURNING agent_id
    )
    SELECT cancelled.id, (SELECT status FROM prior) AS previous_status FROM cancelled
  `;

    if (rows.length > 0) {
        await recordPlaygroundSessionActivityEvent(sessionId);
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
export async function expireStalePendingSessions(pendingTimeoutMs: number): Promise<string[]> {
    const seconds = Math.max(1, Math.round(pendingTimeoutMs / 1000));
    const rows = await sql!`
    UPDATE playground_sessions
    SET status = 'cancelled',
        cancelled_at = NOW(),
        cancelled_by_agent_id = NULL,
        cancelled_reason = ${PLAYGROUND_SYSTEM_EXPIRED_REASON}
    WHERE status = 'pending'
      AND created_at <= NOW() - make_interval(secs => ${seconds})
    RETURNING id
  `;
    const ids = (rows as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) {
        await recordPlaygroundSessionActivityEvent(id);
    }
    return ids;
}

export async function joinPlaygroundSession(
    sessionId: string,
    participant: SessionParticipant,
    maxPlayers: number
): Promise<{ success: boolean; session?: PlaygroundSession; reason?: string }> {
    // 1. Fast idempotent path — no longer load-bearing (M11-1 C23): the decisive UPDATE below
    // re-checks membership itself, so this read only saves a write for the common retry.
    const existing = await sql!`
        SELECT * FROM playground_sessions
        WHERE id = ${sessionId}
        AND participants @> ${JSON.stringify([{ agentId: participant.agentId }])}::jsonb
    `;
    if (existing.length > 0) {
        return { success: true, session: rowToPlaygroundSession(existing[0] as Record<string, unknown>) };
    }

    // 2. Atomic append: status, capacity, AND membership checked by the same statement that
    // appends (M11-1 C23) — two concurrent joins by one agent used to both pass the pre-read
    // and both append, one agent occupying two seats.
    const rows = await sql!`
        UPDATE playground_sessions
        SET participants = participants || ${JSON.stringify([participant])}::jsonb
        WHERE id = ${sessionId}
          AND status = 'pending'
          AND jsonb_array_length(participants) < ${maxPlayers}
          AND NOT (participants @> ${JSON.stringify([{ agentId: participant.agentId }])}::jsonb)
        RETURNING *
    `;

    if (rows.length === 0) {
        // Did not update. Find out why — with "already joined" now among the outcomes, reported
        // as SUCCESS: joining twice is idempotent, not an error.
        const check = await getPlaygroundSession(sessionId);
        if (!check) return { success: false, reason: 'Session not found' };
        if (check.participants.some((p) => p.agentId === participant.agentId)) {
            return { success: true, session: check };
        }
        if (check.status !== 'pending') return { success: false, reason: 'Session not pending' };
        if (check.participants.length >= maxPlayers) return { success: false, reason: 'Session full' };
        return { success: false, reason: 'Unknown error' };
    }

    const session = rowToPlaygroundSession(rows[0] as Record<string, unknown>);
    await recordPlaygroundSessionActivityEvent(sessionId);
    return { success: true, session };
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
export async function submitPlaygroundActionGated(input: CreateActionInput): Promise<SubmitActionOutcome> {
    let rows: Record<string, unknown>[];
    try {
        rows = (await sql!`
      INSERT INTO playground_actions (id, session_id, agent_id, round, content, created_at)
      SELECT ${input.id}, s.id, ${input.agentId}, ${input.round}, ${input.content}, NOW()
      FROM (
        SELECT id FROM playground_sessions
        WHERE id = ${input.sessionId}
          AND status = 'active'
          AND current_round = ${input.round}
          AND (resolve_claim_token IS NULL OR resolve_claim_expires_at <= NOW())
          AND participants @> ${JSON.stringify([{ agentId: input.agentId, status: 'active' }])}::jsonb
        FOR UPDATE
      ) s
      WHERE NOT EXISTS (
        SELECT 1 FROM playground_actions a
        WHERE a.session_id = ${input.sessionId} AND a.round = ${input.round} AND a.agent_id = ${input.agentId}
      )
      RETURNING id, session_id, agent_id, round, content, created_at
    `) as Record<string, unknown>[];
    } catch (error) {
        if (isUniqueViolation(error)) return { ok: false, reason: 'duplicate' };
        throw error;
    }

    if (rows.length > 0) {
        await recordPlaygroundActionActivityEvent(input.id);
        return { ok: true, action: rowToSessionAction(rows[0]) };
    }

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
export async function applyPlaygroundResolution(
    sessionId: string,
    fence: { round: number; token: string },
    updates: UpdateSessionInput
): Promise<boolean> {
    const rows = await sql!`
    UPDATE playground_sessions SET
      status = COALESCE(${updates.status ?? null}, status),
      participants = COALESCE(${updates.participants ? JSON.stringify(updates.participants) : null}::jsonb, participants),
      transcript = COALESCE(${updates.transcript ? JSON.stringify(updates.transcript) : null}::jsonb, transcript),
      current_round = COALESCE(${updates.currentRound ?? null}, current_round),
      current_round_prompt = (CASE WHEN ${updates.currentRoundPrompt === null} THEN NULL ELSE COALESCE(${updates.currentRoundPrompt}, current_round_prompt) END),
      round_deadline = (CASE WHEN ${updates.roundDeadline === null} THEN NULL ELSE COALESCE(${updates.roundDeadline}::timestamptz, round_deadline) END),
      summary = COALESCE(${updates.summary ?? null}, summary),
      completed_at = COALESCE(${updates.completedAt ?? null}::timestamptz, completed_at),
      resolve_claim_token = NULL,
      resolve_claim_expires_at = NULL
    WHERE id = ${sessionId}
      AND status = 'active'
      AND current_round = ${fence.round}
      AND resolve_claim_token = ${fence.token}
      AND resolve_claim_expires_at > NOW()
    RETURNING id
  `;
    if (rows.length > 0) {
        await recordPlaygroundSessionActivityEvent(sessionId);
    }
    return rows.length > 0;
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
