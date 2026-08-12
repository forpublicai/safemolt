import { sql } from "@/lib/db";
import type { AgentClaimOutcome, CompleteVettingOutcome, DeleteAgentResult, StoredAgent, VettingChallenge, VettingChallengeStartOutcome } from "@/lib/store-types";
import { pickRandomAgentEmoji } from "@/lib/agent-emoji";
import {
    generateChallengeValues,
    generateNonce,
    computeExpectedHash,
    getChallengeExpiry,
} from "@/lib/vetting";
import { buildFollowActivityUpsertCtes, recordEvaluationResultActivityEvent, recordFollowActivityEvent } from "../activity/events";
import { buildFollowNotificationCte, createFollowNotificationIdempotent } from "../notifications/db";
import type { PreparedEvent } from "@/lib/events/kinds";
import { emitEventCtes, sqlColumn, sqlParam, sqlPayloadObject } from "../events/statement";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com";

/**
 * Public entity id. Not a credential — `Math.random` is untidy here but not a vulnerability,
 * and ids are returned in public payloads where predictability costs nothing (M11-1 C17).
 */
function generateId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

import { rowToAgent } from "../rows";
import { DISABLED_CREDENTIAL_PREFIX, generateAgentApiKey, generateClaimToken, generateVerificationCode } from "@/lib/credentials";

/**
 * How long an agent name stays reserved after an unclaimed registration.
 *
 * Validated to a positive integer *before* it reaches SQL. `parseInt` yields `NaN` for a
 * malformed value, and `make_interval(hours => NaN)` is not something to discover in production
 * (M11-1 C4).
 */
const DEFAULT_NAME_RELEASE_HOURS = 1;

function nameReleaseHours(): number {
    // Strict: `Number.parseInt` would accept "24hours" as 24 and silently truncate "1.5" to 1.
    // A window nobody meant to configure is worse than the documented default.
    const raw = (process.env.AGENT_NAME_RELEASE_HOURS || "").trim();
    if (!/^\d+$/.test(raw)) return DEFAULT_NAME_RELEASE_HOURS;
    const parsed = Number(raw);
    // `^\d+$` alone is not "a number": a long enough digit string converts to `Infinity`, which is
    // `> 0` and would reach `make_interval(hours => Infinity)` — an error this path swallows, so the
    // cleanup would silently stop running. `Number.isSafeInteger` is the check that means what the
    // comment above claims.
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_NAME_RELEASE_HOURS;
}

/**
 * The two events a registration may emit, and the stale-name release it may perform (M11-2 P1.4).
 *
 * Kept as one options object rather than two positional parameters because they belong together:
 * `releaseStaleName` is what makes statement 1 exist, and `registrationExpired` is the event that
 * rides it. Supplying the event without the release would silently emit nothing.
 */
export interface CreateAgentEvents {
    /** `agent.registered`, gated on the insert's own `RETURNING`. */
    registered?: readonly PreparedEvent[];
    /** `agent.registration_expired` — ONE per row the release actually deleted. */
    registrationExpired?: readonly PreparedEvent[];
}

export interface CreateAgentOptions {
    /**
     * Release a *pristine* unclaimed registration holding this name, in the SAME transaction as the
     * insert (M11-1 C4's predicate, M11-2 P1.4's batching).
     *
     * **Delete and insert are separate batch STATEMENTS, not one CTE.** Data-modifying CTEs share
     * one snapshot, so an insert in the same statement would collide with the not-yet-deleted unique
     * name; two statements in one transaction take two snapshots and the second sees the delete.
     */
    releaseStaleName?: boolean;
    events?: CreateAgentEvents;
}

export async function createAgent(
    name: string,
    description: string,
    options?: CreateAgentOptions
): Promise<StoredAgent & { claimUrl: string; verificationCode: string }> {
    const id = generateId("agent");
    const apiKey = generateAgentApiKey();
    const claimToken = generateClaimToken();
    const verificationCode = generateVerificationCode();
    const createdAt = new Date().toISOString();
    const metadata = { emoji: pickRandomAgentEmoji() };
    const insertParams: unknown[] = [id, name, description, apiKey, createdAt, claimToken, verificationCode, JSON.stringify(metadata)];
    // Store-assigned subject: the agent id is minted here (`$1`). The actor column stays NULL —
    // registration is unauthenticated, so no agent is acting (see `EventPayloadMap`).
    const registeredEmit = emitEventCtes(options?.events?.registered, "created", {
        firstParamIndex: insertParams.length + 1,
        overrides: options?.events?.registered?.length
            ? [{ columnSql: { subject_id: sqlParam(1, "text") } }]
            : [],
    });
    // The three karma components are named explicitly rather than left to the column defaults
    // (M11-1C). The defaults would cover this INSERT, but naming them keeps this site inside the
    // writer-ownership inventory and keeps the db and memory stores literally parallel — the memory
    // store has no defaults to fall back on, and an omitted field there is `undefined`, which makes
    // the first `+ 1` produce `NaN`.
    const insert = {
        text: `
    WITH created AS (
      INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points, legacy_unattributed_points, follower_count, is_claimed, created_at, claim_token, verification_code, metadata)
      VALUES ($1::text, $2::text, $3::text, $4::text, 0, 0, 0, 0, 0, false, $5::timestamptz, $6::text, $7::text, $8::jsonb)
      RETURNING id
    )${registeredEmit.ctes.length > 0 ? `, ${registeredEmit.ctes.join(", ")}` : ""}
    SELECT id FROM created
  `,
        params: [...insertParams, ...registeredEmit.params],
    };

    if (options?.releaseStaleName) {
        const release = buildStaleNameRelease(name, options.events?.registrationExpired);
        // **One transaction, and the cleanup's swallow is gone with it.** The standalone helper
        // logged and continued, because a registration must not fail for a cleanup it did not ask
        // for; inside the batch that is no longer the choice available — a delete that failed after
        // its event was rendered would leave a released name with no record, so the whole
        // registration rolls back and the caller retries. Recorded behavior change (M11-2 P1.4).
        await sql!.transaction((txn) => [txn(release.text, release.params), txn(insert.text, insert.params)]);
    } else {
        await sql!(insert.text, insert.params);
    }
    const agent: StoredAgent = {
        id,
        name,
        description,
        apiKey,
        points: 0,
        votePoints: 0,
        evaluationPoints: 0,
        legacyUnattributedPoints: 0,
        followerCount: 0,
        isClaimed: false,
        createdAt,
        claimToken,
        verificationCode,
        metadata,
    };
    return {
        ...agent,
        claimUrl: `${BASE_URL}/claim/${claimToken}`,
        verificationCode,
    };
}

export async function getAgentById(id: string): Promise<StoredAgent | null> {
    const rows = await sql!`SELECT * FROM agents WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

/**
 * Returns every matching agent once. Output order is storage-defined, so callers
 * must build an id-indexed map instead of relying on input order.
 */
export async function getAgentsByIds(ids: string[]): Promise<StoredAgent[]> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (uniqueIds.length === 0) return [];
    const rows = await sql!`SELECT * FROM agents WHERE id = ANY(${uniqueIds}::text[])`;
    return (rows as Record<string, unknown>[]).map(rowToAgent);
}

export async function getAgentByName(name: string): Promise<StoredAgent | null> {
    const rows = await sql!`SELECT * FROM agents WHERE LOWER(name) = LOWER(${name}) LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

export async function getAgentByClaimToken(claimToken: string): Promise<StoredAgent | null> {
    // M11-1b: a disabled_-prefixed claim token never resolves (M11-1 C19). The prefix disables
    // the *credential*, and a claim token is a credential — a human who claims the seeded demo
    // agent becomes its owner and could re-issue a working api key against a row that ships
    // vetted+admitted. Structural, before the lookup, mirroring getAgentFromRequest.
    if (claimToken.startsWith(DISABLED_CREDENTIAL_PREFIX)) return null;
    const rows = await sql!`SELECT * FROM agents WHERE claim_token = ${claimToken} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

/**
 * Release a name held by a *pristine* unclaimed registration past the release window.
 *
 * This runs from `POST /api/v1/agents/register`, which is unauthenticated — so whatever it
 * deletes, any anonymous caller can cause to be deleted by attempting that name. That makes the
 * predicate the security boundary, and until M11-1 C4 it was `LOWER(name)` + `is_claimed = false`
 * + age alone: an identity-destruction primitive against any unclaimed agent past the window.
 *
 * Two things had to land together, and shipping either alone would have been worse than shipping
 * neither:
 *
 *  - **The predicate.** `is_vetted = false AND last_active_at IS NULL` narrows it to registrations
 *    that never did anything. `createAgent`'s insert omits `last_active_at`, so NULL is precisely
 *    "never authenticated". A grace-window variant would still destroy an agent that authenticated
 *    once and went idle.
 *  - **The interval.** The previous expression was `(${releaseHours} || 1) * INTERVAL '1 hour'`,
 *    and `||` there is *string concatenation*, not a default: `$1 || 1` resolves through
 *    `text || anynonarray` and yields the text `'11'`, and `text * interval` has no operator. Every
 *    invocation raised **42883** into the catch below, so in DB mode this has never deleted a row.
 *    Fixing the interval is what *activates* the primitive — which is why the predicate ships in
 *    the same commit and the two are gated together.
 *
 * The swallow stays **on this standalone export**, whose one remaining caller is the dashboard
 * provisioning path (`provision-public-ai-agent.ts`, outside the Surface bound): there the cleanup
 * is still its own auto-committed statement and a failure must not fail provisioning. The agent
 * REGISTRATION path no longer calls it — M11-2 P1.4 batches the same delete with the insert through
 * `createAgent({ releaseStaleName: true })`, where a loud failure is the correct one. The predicate
 * lives in one place (`staleNameReleasePredicate`) so the two callers cannot drift.
 */
export async function cleanupStaleUnclaimedAgent(name: string): Promise<void> {
    try {
        const release = buildStaleNameRelease(name);
        await sql!(release.text, release.params);
    } catch (e) {
        // Log but don't fail provisioning if cleanup fails
        console.error(`[cleanupStaleUnclaimedAgent] Failed to cleanup ${name}:`, e);
    }
}

/**
 * The stale-name release as one statement, with its events rendered per DELETED ROW.
 *
 * `rowSource` is what makes that per-row shape possible: the fragment selects `FROM released`, so a
 * release that removed two rows (it cannot today — the name is unique — but the shape is the
 * statement's, not the index's) emits two events, each carrying its own subject. A release that
 * matched nothing emits none, because every event is still gated on the same CTE.
 */
function buildStaleNameRelease(
    name: string,
    events?: readonly PreparedEvent[]
): { text: string; params: unknown[] } {
    const params: unknown[] = [name, nameReleaseHours()];
    const emitted = emitEventCtes(events, "released", {
        firstParamIndex: params.length + 1,
        overrides: events?.length
            ? [{ rowSource: "released", columnSql: { subject_id: sqlColumn("released.id") } }]
            : [],
    });
    return {
        text: `
    WITH released AS (
      DELETE FROM agents
      WHERE LOWER(name) = LOWER($1::text)
        AND is_claimed = false
        AND is_vetted = false
        AND last_active_at IS NULL
        AND created_at < NOW() - make_interval(hours => $2::int)
      RETURNING id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT id FROM released
  `,
        params: [...params, ...emitted.params],
    };
}

/**
 * Authenticate by api key and stamp `last_active_at` in **one** statement.
 *
 * The predicate above treats `last_active_at IS NULL` as "never authenticated", so authentication
 * and cleanup contend on exactly that column. Reading the agent and then touching it — two
 * statements, as `getAgentFromRequest` used to do — leaves a window where a brand-new agent's very
 * first authenticated request reads its row, loses to a concurrent same-name registration's
 * cleanup, and has its touch land on zero rows: destroyed *after* it authenticated, which is the
 * one outcome C4 promises cannot happen. One statement makes the two serialize on the row.
 *
 * The fast path is a plain `SELECT`: the write only has to happen when the stamp is actually
 * stale, and a fresh agent is by definition not the one at risk.
 */
export async function authenticateAndTouchByApiKey(
    apiKey: string,
    staleAfterMs = 5 * 60 * 1000
): Promise<StoredAgent | null> {
    try {
        const staleSeconds = Math.ceil(staleAfterMs / 1000);
        const updated = await sql!`
      UPDATE agents
      SET last_active_at = NOW()
      WHERE api_key = ${apiKey}
        AND (
          last_active_at IS NULL
          OR last_active_at < NOW() - make_interval(secs => ${staleSeconds})
        )
      RETURNING *
    `;
        const touched = updated[0] as Record<string, unknown> | undefined;
        if (touched) return rowToAgent(touched);

        // Zero rows means either "no such key" or "stamp is fresh"; only a read tells them apart.
        const rows = await sql!`SELECT * FROM agents WHERE api_key = ${apiKey} LIMIT 1`;
        const r = rows[0] as Record<string, unknown> | undefined;
        if (!r) {
            const maskedKey = apiKey ? `${apiKey.slice(0, 12)}...${apiKey.slice(-4)}` : "empty";
            console.log(`[Auth] No agent found for key: ${maskedKey}`);
        }
        return r ? rowToAgent(r) : null;
    } catch (error) {
        console.error("[Auth] Database error in authenticateAndTouchByApiKey:", error);
        return null;
    }
}

/**
 * Claim an agent, **only if it is not already claimed** — returns whether this caller won
 * (M11-1 C6).
 *
 * The update used to be unconditional, which is what let a second claimant overwrite the first
 * one's owner: both channels (Cognito claim, X/Twitter verification) read `is_claimed` in one
 * statement and wrote in another, so two racing claims both passed the read. Gating the write on
 * `is_claimed = false` makes the row itself the arbiter — the loser blocks on the winner's lock,
 * re-evaluates after it commits, and matches zero rows.
 *
 * `COALESCE` collapses what were three separate statements: a parameter left undefined keeps the
 * column's current value instead of overwriting it with NULL. The old `x_follower_count` branch
 * also carried a `try/catch` that silently retried without the column "in case the migration has
 * not run" — a swallow that would have hidden any failure of a *claim*, on a column
 * `scripts/schema.sql` has declared for as long as the table has existed.
 */
export async function setAgentClaimed(
    id: string,
    owner?: string,
    xFollowerCount?: number,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    const params: unknown[] = [id, owner ?? null, xFollowerCount ?? null];
    // Gated on the conditional claim: a second claimant matches zero rows, writes nothing, emits
    // nothing. The subject is the agent, which the caller resolved from the claim token — no
    // substitution is needed, unlike the Cognito path, whose statement resolves the token itself.
    const emitted = emitEventCtes(events, "claimed", { firstParamIndex: params.length + 1 });
    const rows = await sql!(
        `
    WITH claimed AS (
      UPDATE agents
      SET is_claimed = true,
          owner = COALESCE($2::text, owner),
          x_follower_count = COALESCE($3::int, x_follower_count)
      WHERE id = $1::text AND is_claimed = false
      RETURNING id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT id FROM claimed
  `,
        [...params, ...emitted.params]
    );
    return rows.length > 0;
}

export async function setAgentClaimedWithOutcome(
    id: string,
    owner?: string,
    xFollowerCount?: number,
    events?: readonly PreparedEvent[]
): Promise<AgentClaimOutcome<StoredAgent>> {
    const params: unknown[] = [id, owner ?? null, xFollowerCount ?? null];
    const emitted = emitEventCtes(events, "claimed", { firstParamIndex: params.length + 1 });
    const rows = await sql!(
        `WITH target AS (SELECT * FROM agents WHERE id = $1::text FOR UPDATE),
         claimed AS (
           UPDATE agents AS a SET is_claimed = true,
             owner = COALESCE($2::text, a.owner),
             x_follower_count = COALESCE($3::int, a.x_follower_count)
           FROM target WHERE a.id = target.id AND target.is_claimed = false
           RETURNING a.*
         )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
         SELECT target.id AS target_id, target.is_claimed AS target_claimed,
                claimed.* FROM target LEFT JOIN claimed ON true`,
        [...params, ...emitted.params]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const claimed = Boolean(row?.id && row?.target_id);
    return {
        agentExists: Boolean(row?.target_id),
        claimed,
        ...(claimed ? { agent: rowToAgent(row!) } : {}),
    };
}

/**
 * The Cognito claim, as **one statement**: claim the agent and record the human's ownership, or do
 * neither (M11-1 C6).
 *
 * The route used to call `setAgentClaimed` and then `linkUserToAgent` as two auto-committed
 * writes. A failure of the second left the agent **claimed but unowned** — and permanently
 * unclaimable, because every retry hit the "already claimed" check the first write had just made
 * true. That is a lockout with no operator path back.
 *
 * The ownership insert is gated on the claim's `RETURNING`, so a losing claimant writes no
 * `user_agents` row. A `sql.transaction` batch cannot express this: batch elements cannot read one
 * another's `RETURNING`, so the insert would fire for the loser too.
 *
 * **This function writes `user_agents`, which belongs to the human-users module.** The crossing is
 * deliberate and is what atomicity costs here: the guarantee is that these two writes commit
 * together or not at all, and two modules cannot share one statement.
 *
 * Returns the claimed agent, or null when the token is unknown or the agent is already claimed.
 * The caller cannot distinguish those two, by design — both are "you did not get this agent".
 */
export async function claimAgentForHumanUser(
    claimToken: string,
    humanUserId: string,
    owner?: string,
    events?: readonly PreparedEvent[]
): Promise<StoredAgent | null> {
    if (claimToken.startsWith(DISABLED_CREDENTIAL_PREFIX)) return null;
    const params: unknown[] = [claimToken, owner ?? null, humanUserId];
    // **`subject_id` is STORE-ASSIGNED here, and that is a correctness rule.** This statement
    // resolves the claim TOKEN, and its resolution is the one that claimed the row; the caller's
    // pre-read exists only for the 404. Taking the id from that read would let a token re-issued in
    // the window name an agent this statement never touched — the rule `followAgent` follows.
    const emitted = emitEventCtes(events, "claimed", {
        firstParamIndex: params.length + 1,
        overrides: events?.length
            ? [{ rowSource: "claimed", columnSql: { subject_id: sqlColumn("claimed.id") } }]
            : [],
    });
    const rows = await sql!(
        `
    WITH claimed AS (
      UPDATE agents
      SET is_claimed = true, owner = COALESCE($2::text, owner)
      WHERE claim_token = $1::text AND is_claimed = false
      RETURNING *
    ),
    linked AS (
      INSERT INTO user_agents (user_id, agent_id, role)
      SELECT $3::text, id, 'owner' FROM claimed
      ON CONFLICT (user_id, agent_id) DO UPDATE SET role = EXCLUDED.role
      RETURNING agent_id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT * FROM claimed
  `,
        [...params, ...emitted.params]
    );
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

export async function claimAgentForHumanUserWithOutcome(
    claimToken: string,
    humanUserId: string,
    owner?: string,
    events?: readonly PreparedEvent[]
): Promise<AgentClaimOutcome<StoredAgent>> {
    if (claimToken.startsWith(DISABLED_CREDENTIAL_PREFIX)) return { agentExists: false, claimed: false };
    const params: unknown[] = [claimToken, owner ?? null, humanUserId];
    const emitted = emitEventCtes(events, "claimed", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ rowSource: "claimed", columnSql: { subject_id: sqlColumn("claimed.id") } }] : [],
    });
    const rows = await sql!(
        `WITH target AS (SELECT * FROM agents WHERE claim_token = $1::text FOR UPDATE),
         claimed AS (
           UPDATE agents AS a SET is_claimed = true, owner = COALESCE($2::text, a.owner)
           FROM target WHERE a.id = target.id AND target.is_claimed = false RETURNING a.*
         ),
         linked AS (
           INSERT INTO user_agents (user_id, agent_id, role)
           SELECT $3::text, id, 'owner' FROM claimed
           ON CONFLICT (user_id, agent_id) DO UPDATE SET role = EXCLUDED.role
         )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
         SELECT target.id AS target_id, claimed.* FROM target LEFT JOIN claimed ON true`,
        [...params, ...emitted.params]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const claimed = Boolean(row?.id);
    return { agentExists: Boolean(row?.target_id), claimed, ...(claimed ? { agent: rowToAgent(row!) } : {}) };
}

export async function setAgentUnclaimed(id: string): Promise<void> {
    await sql!`UPDATE agents SET is_claimed = false, owner = null WHERE id = ${id}`;
}

export async function listAgents(sort: "recent" | "points" | "followers" = "recent"): Promise<StoredAgent[]> {
    let rows: Record<string, unknown>[];
    if (sort === "points") {
        rows = await sql!`SELECT * FROM agents ORDER BY points DESC LIMIT 500`;
    } else if (sort === "followers") {
        // Don't reference x_follower_count in SQL so this works before migration; sort in JS
        rows = await sql!`SELECT * FROM agents WHERE is_claimed = true LIMIT 500`;
    } else {
        rows = await sql!`SELECT * FROM agents ORDER BY created_at DESC LIMIT 500`;
    }
    const agents = (rows as Record<string, unknown>[]).map(rowToAgent);
    if (sort === "followers") {
        agents.sort((a, b) => (b.xFollowerCount ?? 0) - (a.xFollowerCount ?? 0));
    }
    return agents;
}

export async function countAgents(): Promise<number> {
    const rows = await sql!`SELECT COUNT(*)::int AS count FROM agents`;
    return Number((rows[0] as Record<string, unknown> | undefined)?.count ?? 0);
}

/**
 * Follow an agent — **one statement** for the row, the counter and the event (M11-2 P1.2).
 *
 * It used to be a SELECT, then an INSERT, then a separate counter bump, each auto-committed on this
 * driver: two concurrent follows of one agent could both read "not following" and one of them lost
 * its counter increment, and a crash between the insert and the bump left the count permanently
 * short. `ON CONFLICT DO NOTHING RETURNING` makes the insert itself the decision, and everything
 * else — the counter, the event, and the two transitional projections below — hangs off it.
 *
 * **The followee is a LOCKED target, and that is what turns an error into a refusal.**
 * `following.followee_id` is an FK, so a bare insert against an agent who withdrew mid-flight raises
 * `23503`; `INSERT … SELECT FROM followee` against a `FOR KEY SHARE` row yields zero rows instead.
 * `FOR KEY SHARE` and not a stronger mode: it conflicts with the `FOR UPDATE` a withdrawal's
 * `DELETE FROM agents` takes — the liveness fact that matters — while leaving the `FOR NO KEY
 * UPDATE` the counter bump and every karma write take alone, so two agents following each other at
 * the same moment cannot deadlock on their own FK checks.
 *
 * **Both transitional projections are now gated on FIRST INSERTION, and the activity one is a
 * recorded behavior change** (P1.2's follow-alignment paragraph). The inline writer used to refresh
 * the trail on every re-follow while notifying only on the first, but the consumer's effect is keyed
 * to the decisive insert and a re-follow emits no event at all — so without this every duplicate
 * follow would log a false payload mismatch in the shadow soak. A re-follow no longer bumps the
 * trail timestamp. The memory store makes the same change.
 */
export async function followAgent(
    followerId: string,
    followeeName: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    // **The one authoritative resolution.** Everything below — the locked target, the `following`
    // row, the counter, both projections and the event's `subject_id` — uses THIS id. The action
    // resolves the name too, but only to choose between its two refusal strings; an event built
    // from that read would name a different agent the moment a rename (or a withdrawal and a
    // re-registration of the freed name) landed between the two.
    const followee = await getAgentByName(followeeName);
    if (!followee || followee.id === followerId) return false;
    const params: unknown[] = [followerId, followee.id];
    if (events?.length) {
        params.push(`notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`);
    }
    const emitted = emitEventCtes(events, "followed", {
        firstParamIndex: params.length + 1,
        // Store-assigned, positionally on the PRIMARY event: `$2` is the id resolved above, still a
        // bound parameter — only its number is interpolated.
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(2, "text") } }] : [],
    });
    const primary = emitted.names[0] ?? null;
    const rows = await sql!(
        `
    WITH target AS (
      SELECT id, name FROM agents WHERE id = $2::text FOR KEY SHARE
    ),
    followed AS (
      INSERT INTO following (follower_id, followee_id)
      SELECT $1::text, t.id FROM target t
      ON CONFLICT DO NOTHING
      RETURNING follower_id, followee_id
    ),
    bumped AS (
      UPDATE agents SET follower_count = follower_count + 1
      WHERE id IN (SELECT followee_id FROM followed)
      RETURNING id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}, ${buildFollowActivityUpsertCtes({ followCte: "followed", targetCte: "target", sourceEventCte: primary!, namePrefix: "follow_trail" }).join(", ")}, ${buildFollowNotificationCte({ followCte: "followed", targetCte: "target", sourceEventCte: primary!, notificationIdParam: 3 })}` : ""}
    SELECT (SELECT count(*) FROM target)::int AS target_exists,
           (SELECT count(*) FROM followed)::int AS inserted${
               primary
                   ? `,\n           (SELECT id FROM ${primary}) AS emitted_event_id,\n           (SELECT created_at FROM ${primary}) AS emitted_event_created_at`
                   : ""
           }
  `,
        [...params, ...emitted.params]
    );
    const row = (rows[0] ?? {}) as {
        target_exists?: number;
        inserted?: number;
        emitted_event_id?: number | string | null;
        emitted_event_created_at?: Date | string | null;
    };
    // The followee withdrew between the name lookup and the statement: nothing written, nothing
    // emitted, and the same refusal the caller gets for a name that never existed.
    if (!row.target_exists) return false;
    if (!row.inserted) return true;

    // Eventless fixture/seed calls retain the legacy projection contract. Agent-visible calls always
    // supply an event and use the statement-atomic CTEs above.
    if (!events?.length) {
        const createdAt = new Date().toISOString();
        await recordFollowActivityEvent({ followerId, followeeId: followee.id, followeeName: followee.name, followeeDisplayName: followee.displayName, createdAt });
        await createFollowNotificationIdempotent({ dedupKey: null, recipientAgentId: followee.id, actorAgentId: followerId, createdAt });
    }

    return true;
}

/**
 * Returns whether a follow relationship was actually removed (M11-1 C16).
 *
 * The decrement now **rides the delete**. It used to be a second, unconditional statement, so an
 * agent could "unfollow" someone it had never followed and take a point off their public follower
 * count every time — repeat until zero. The DB store also returned `true` in that case while the
 * memory store returned `false`, so this closes a store-parity break as well as the exploit.
 *
 * The CTE deletes from `following` and updates `agents`: two different tables, which is what makes
 * the shape legal. A data-modifying CTE cannot touch the same *row* twice.
 *
 * M11-2 P1.2 adds `agent.unfollowed`, gated on the same `removed` row the decrement is gated on, so
 * an unfollow that removed nothing emits nothing. The kind is history-only: no consumer has an
 * effect for it, in any manifest.
 */
export async function unfollowAgent(
    followerId: string,
    followeeName: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    // The one authoritative resolution — see `followAgent`. The event's `subject_id` is filled from
    // it rather than from any read the caller made.
    const followee = await getAgentByName(followeeName);
    if (!followee) return false;
    const params: unknown[] = [followerId, followee.id];
    const emitted = emitEventCtes(events, "removed", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(2, "text") } }] : [],
    });
    const rows = await sql!(
        `
    WITH removed AS (
      DELETE FROM following
      WHERE follower_id = $1::text AND followee_id = $2::text
      RETURNING followee_id
    ),
    decremented AS (
      UPDATE agents SET follower_count = GREATEST(0, follower_count - 1)
      WHERE id IN (SELECT followee_id FROM removed)
      RETURNING id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT id FROM decremented
  `,
        [...params, ...emitted.params]
    );
    return rows.length > 0;
}

export async function isFollowing(followerId: string, followeeName: string): Promise<boolean> {
    const followee = await getAgentByName(followeeName);
    if (!followee) return false;
    const rows = await sql!`SELECT 1 FROM following WHERE follower_id = ${followerId} AND followee_id = ${followee.id} LIMIT 1`;
    return rows.length > 0;
}

export async function getFollowingCount(agentId: string): Promise<number> {
    const rows = await sql!`SELECT COUNT(*)::int AS c FROM following WHERE follower_id = ${agentId}`;
    return Number((rows[0] as { c: number }).c);
}

/**
 * Update scalar agent fields.
 *
 * **`metadata` is deliberately absent** (M11-1 C7). An earlier design tried to have this function
 * "reject whole-object metadata writes structurally"; it cannot, because a delta and a stale full
 * copy have identical types and identical runtime shapes, so no assertion can recover the caller's
 * intent. Removing the parameter is the only enforcement that works, and it makes the structural
 * test assert something real. Metadata goes through `mergeAgentMetadata`.
 */
export async function updateAgent(
    agentId: string,
    updates: {
        name?: string;
        description?: string;
        displayName?: string;
        lastActiveAt?: string;
    }
): Promise<StoredAgent | null> {
    const a = await getAgentById(agentId);
    if (!a) return null;
    if (updates.name !== undefined) {
        const trimmed = updates.name.trim();
        if (trimmed) await sql!`UPDATE agents SET name = ${trimmed} WHERE id = ${agentId}`;
    }
    if (updates.description !== undefined)
        await sql!`UPDATE agents SET description = ${updates.description} WHERE id = ${agentId}`;
    if (updates.displayName !== undefined)
        await sql!`UPDATE agents SET display_name = ${updates.displayName.trim() || null} WHERE id = ${agentId}`;
    if (updates.lastActiveAt !== undefined)
        await sql!`UPDATE agents SET last_active_at = ${updates.lastActiveAt} WHERE id = ${agentId}`;
    return getAgentById(agentId);
}

/**
 * Merge a metadata delta **inside the statement**.
 *
 * An application-level merge cannot be correct here. Every writer used to read the agent, spread
 * the whole metadata object, and hand the entire result to `updateAgent`, which wrote it verbatim
 * — so a write that read old metadata, lost a race to a credential write, and then wrote its stale
 * copy back would silently revoke the credential. Doing the merge in SQL closes that from every
 * side at once, which is why every platform writer converts, not just the caller-facing PATCH.
 *
 * The `COALESCE` is load-bearing, not decoration: `agents.metadata` is nullable and Postgres's
 * `||` is strict, so a bare `agents.metadata || $delta` yields **NULL** for every agent that has
 * never had metadata — the update would silently erase the write it was asked to make.
 */
export async function mergeAgentMetadata(
    agentId: string,
    delta: Record<string, unknown>
): Promise<StoredAgent | null> {
    const rows = await sql!`
    UPDATE agents
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(delta)}::jsonb
    WHERE id = ${agentId}
    RETURNING *
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : null;
}

export async function touchAgentLastActiveAtIfStale(
    agentId: string,
    staleAfterMs = 5 * 60 * 1000
): Promise<void> {
    await sql!`
    UPDATE agents
    SET last_active_at = NOW()
    WHERE id = ${agentId}
      AND (
        last_active_at IS NULL
        OR last_active_at < NOW() - make_interval(secs => ${Math.ceil(staleAfterMs / 1000)})
      )
  `;
}

/**
 * M11-1 C17 (opt-in re-issue): mint a fresh CSPRNG api key for an **owned** agent in one
 * conditional statement. The old key stops authenticating the moment this commits — no
 * dual-accept window, because the path is user-initiated and the user has the new key in hand.
 *
 * **Ownership is the statement's own predicate** (M11-1b review round 2, B2), not a caller
 * pre-check: the route's `userOwnsAgent` call and the rotation are two round trips, so an owner
 * whose request stalled while the agent was transferred away could resume and overwrite the new
 * owner's key — handing a working credential to a former owner. The `EXISTS (SELECT 1 FROM
 * user_agents …)` clause makes revocation-between-check-and-mutation a zero-row refusal.
 *
 * @returns the new key, or null when the agent does not exist or the caller no longer owns it.
 */
export async function rotateAgentApiKey(agentId: string, humanUserId: string): Promise<string | null> {
    const newKey = generateAgentApiKey();
    const rows = await sql!`
    UPDATE agents SET api_key = ${newKey}
    WHERE id = ${agentId}
      AND EXISTS (
        SELECT 1 FROM user_agents
        WHERE user_id = ${humanUserId} AND agent_id = ${agentId} AND role = 'owner'
      )
    RETURNING id
  `;
    return rows.length > 0 ? newKey : null;
}

export async function setAgentAdmitted(agentId: string, admitted: boolean): Promise<void> {
    await sql!`UPDATE agents SET is_admitted = ${admitted} WHERE id = ${agentId}`;
}

export async function setAgentAvatar(agentId: string, avatarUrl: string): Promise<StoredAgent | null> {
    await sql!`UPDATE agents SET avatar_url = ${avatarUrl} WHERE id = ${agentId}`;
    return getAgentById(agentId);
}

export async function clearAgentAvatar(agentId: string): Promise<StoredAgent | null> {
    await sql!`UPDATE agents SET avatar_url = NULL WHERE id = ${agentId}`;
    return getAgentById(agentId);
}

// ==================== Vetting Challenge Functions ====================
// M11-1 C14: challenges are durable rows. The previous Map lived in one process, so on
// serverless the start and complete requests routinely landed on different instances and
// vetting randomly 404'd for legitimate agents. `"values"` is quoted throughout — reserved word,
// column name pinned by the plan's table spec.

function generateChallengeId(): string {
    return `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function rowToVettingChallenge(r: Record<string, unknown>): VettingChallenge {
    return {
        id: r.id as string,
        agentId: r.agent_id as string,
        values: r.values as number[],
        nonce: r.nonce as string,
        expectedHash: r.expected_hash as string,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        expiresAt: r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at),
        fetched: r.fetched_at != null,
        consumed: r.consumed_at != null,
    };
}

export async function createVettingChallenge(
    agentId: string,
    events?: readonly PreparedEvent[]
): Promise<VettingChallenge> {
    const id = generateChallengeId();
    const values = generateChallengeValues();
    const nonce = generateNonce();
    const expectedHash = computeExpectedHash(values, nonce);
    const createdAt = new Date().toISOString();
    const expiresAt = getChallengeExpiry();
    const params: unknown[] = [id, agentId, JSON.stringify(values), nonce, expectedHash, createdAt, expiresAt];
    // Gated on the insert. The subject is the AGENT (the caller's own id), not the challenge: a
    // challenge is a 15-second credential that the retention sweep deletes, and an event whose
    // subject is a row nothing keeps names nothing afterwards.
    const emitted = emitEventCtes(events, "created", { firstParamIndex: params.length + 1 });

    await sql!(
        `
    WITH created AS (
      INSERT INTO vetting_challenges (id, agent_id, "values", nonce, expected_hash, created_at, expires_at)
      VALUES ($1::text, $2::text, $3::jsonb, $4::text, $5::text, $6::timestamptz, $7::timestamptz)
      RETURNING id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT id FROM created
  `,
        [...params, ...emitted.params]
    );

    return { id, agentId, values, nonce, expectedHash, createdAt, expiresAt, fetched: false, consumed: false };
}

export async function createVettingChallengeIfNotVetted(
    agentId: string,
    events?: readonly PreparedEvent[]
): Promise<VettingChallengeStartOutcome> {
    const id = generateChallengeId();
    const values = generateChallengeValues();
    const nonce = generateNonce();
    const expectedHash = computeExpectedHash(values, nonce);
    const createdAt = new Date().toISOString();
    const expiresAt = getChallengeExpiry();
    const params: unknown[] = [id, agentId, JSON.stringify(values), nonce, expectedHash, createdAt, expiresAt];
    const emitted = emitEventCtes(events, "created", { firstParamIndex: params.length + 1 });
    const rows = await sql!(
        `WITH target AS (SELECT id, is_vetted FROM agents WHERE id = $2::text FOR UPDATE),
          created AS (
            INSERT INTO vetting_challenges (id, agent_id, "values", nonce, expected_hash, created_at, expires_at)
            SELECT $1::text, $2::text, $3::jsonb, $4::text, $5::text, $6::timestamptz, $7::timestamptz
            FROM target WHERE target.is_vetted = false RETURNING id
          )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
          SELECT EXISTS (SELECT 1 FROM target) AS agent_exists,
                 EXISTS (SELECT 1 FROM created) AS created,
                 COALESCE((SELECT is_vetted FROM target), false) AS already_vetted`,
        [...params, ...emitted.params]
    );
    const result = rows[0] as Record<string, unknown>;
    const created = result.created === true;
    return {
        agentExists: result.agent_exists === true,
        created,
        alreadyVetted: result.already_vetted === true,
        ...(created ? { challenge: { id, agentId, values, nonce, expectedHash, createdAt, expiresAt, fetched: false, consumed: false } } : {}),
    };
}

export async function getVettingChallenge(id: string): Promise<VettingChallenge | null> {
    const rows = await sql!`SELECT * FROM vetting_challenges WHERE id = ${id} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? rowToVettingChallenge(r) : null;
}

export async function markChallengeFetched(id: string): Promise<boolean> {
    const rows = await sql!`
    UPDATE vetting_challenges SET fetched_at = COALESCE(fetched_at, NOW()) WHERE id = ${id} RETURNING id
  `;
    return rows.length > 0;
}

/**
 * Standalone consumption — the PoAW evaluation executor's path (`evaluations/executors/poaw.ts`).
 * The vetting route no longer uses this: its consumption is the final element of the
 * `completeVetting` batch below. Conditional, so a replay returns false rather than re-consuming.
 */
export async function consumeVettingChallenge(id: string): Promise<boolean> {
    const rows = await sql!`
    UPDATE vetting_challenges SET consumed_at = NOW()
    WHERE id = ${id} AND consumed_at IS NULL
    RETURNING id
  `;
    return rows.length > 0;
}

/** Bounded maintenance delete (runs on the fail-closed memory-ingest cron). Retention keeps
 *  recently expired rows so an in-flight retry still classifies as "expired" (410), not 404. */
export async function pruneExpiredVettingChallenges(retentionMs: number): Promise<number> {
    const seconds = Math.max(1, Math.round(retentionMs / 1000));
    const rows = await sql!`
    DELETE FROM vetting_challenges
    WHERE expires_at < NOW() - make_interval(secs => ${seconds})
    RETURNING id
  `;
    return rows.length;
}

// ==================== Atomic Vetting Completion (M11-1 C14) ====================

/** Foundation bootstrap evaluations recorded on successful vetting; school is server-determined. */
export const VETTING_BOOTSTRAP_EVALUATIONS = ["poaw", "identity-check"] as const;

/**
 * One `sql.transaction` batch replacing the route's many auto-committed calls, whose failure
 * anywhere after consumption used to burn a valid challenge with nothing to show for it.
 *
 * Element order is load-bearing:
 *  1. lock the **agent row first, then the challenge** — one global order, identical to the PoAW
 *     completion batch M11-1b D4 specifies, so the two can never deadlock against each other. The
 *     agent lock is also what serializes two completions holding *different* valid challenges:
 *     the active-registration index covers only non-terminal rows and cannot.
 *  2. every later element gates on the challenge still being live (`consumed_at IS NULL AND
 *     expires_at > NOW()` — `NOW()` is the transaction timestamp, constant across the batch, so a
 *     challenge valid at entry stays valid for every element).
 *  3. each bootstrap evaluation is one self-contained data-modifying CTE (Neon batches do not
 *     nest and elements cannot read one another's RETURNING): it writes nothing if a passed
 *     result already exists — re-checked here on this statement's *fresh* snapshot, which is what
 *     sees a concurrent winner after the agent-lock blocks — transitions the newest active
 *     registration or inserts one directly in its terminal state (an unconditional insert would
 *     collide with the active-registration unique index for an agent that pre-registered), and
 *     inserts exactly one result gated on the effective registration id, satisfying C21's unique
 *     `registration_id` index and round 8's one-pass index.
 *  4. the points recompute is a batch element (same single-statement shape as C21's).
 *  5. consumption is **last**; its zero-row outcome is the loser signal the route classifies.
 *
 * A unique-violation (23505) rolls the whole batch back — the challenge stays unconsumed. That
 * shape means a completion raced a concurrent non-vetting path (e.g. a PoAW submit) into one of
 * the bootstrap indexes, so the batch is retried once: the second attempt's fresh snapshot sees
 * the committed pass, skips that insert, and consumes cleanly.
 *
 * Result activity is fired *after* the batch for exactly the results the batch reports created —
 * the same post-decisive-statement placement `saveEvaluationResult` has today. Making activity a
 * batch element is M11-1b D4's "batchable dependencies" work, not this chunk's.
 */
/**
 * The events a vetting completion may emit, grouped by the batch element that gates each one.
 *
 * Keyed by evaluation id rather than positionally, because the caller names the bootstrap
 * evaluations by id (`VETTING_BOOTSTRAP_EVALUATIONS`) and a positional list would silently pair the
 * wrong event with the wrong evaluation if that constant were ever reordered.
 */
export interface CompleteVettingEvents {
    /** `agent.vetted`, gated on the vetted flip. */
    vetted?: readonly PreparedEvent[];
    /** Per bootstrap evaluation: the registration arm's event and the result arm's. */
    bootstrap?: Record<
        string,
        { registered?: readonly PreparedEvent[]; completed?: readonly PreparedEvent[] }
    >;
}

export async function completeVetting(
    agentId: string,
    challengeId: string,
    identityMd: string,
    events?: CompleteVettingEvents
): Promise<CompleteVettingOutcome> {
    // Throwing/derivation work first: the field computation reads the definition loader and may
    // throw; nothing that follows may run without it.
    const { computeEvaluationResultFields } = await import("../evaluations/result-fields");
    const bootstrap = VETTING_BOOTSTRAP_EVALUATIONS.map((evaluationId) => {
        const { pointsEarned, evaluationVersion } = computeEvaluationResultFields({
            evaluationId,
            passed: true,
        });
        return {
            evaluationId,
            pointsEarned,
            evaluationVersion,
            registrationId: generateId("eval_reg"),
            resultId: generateId("eval_res"),
            resultData:
                evaluationId === "poaw"
                    ? { challenge_id: challengeId, completed_within_time_limit: true }
                    : { identity_received: identityMd.length > 0 },
        };
    });

    const completedAt = new Date().toISOString();
    const attempt = () => runCompleteVettingBatch(agentId, challengeId, identityMd, completedAt, bootstrap, events);

    let results: Array<Array<Record<string, unknown>>>;
    try {
        results = await attempt();
    } catch (error) {
        if (!isUniqueViolationError(error)) throw error;
        results = await attempt();
    }

    const consumed = results[results.length - 1];
    if (!Array.isArray(consumed) || consumed.length === 0) {
        const agentRow = (results[0]?.[0] ?? {}) as Record<string, unknown>;
        const challengeRow = (results[1]?.[0] ?? {}) as Record<string, unknown>;
        // Precedence carries two pins at once: a FOREIGN challenge never succeeds (mismatch outranks
        // the vetted fallback), while a vetted agent's OWN dead-or-absent challenge answers
        // already_vetted — the idempotent lost-response retry (C14) and the same-challenge race's
        // losing half. Only an UNVETTED agent sees consumed/expired refusals.
        const reason = !agentRow.id ? "not_found"
            : challengeRow.id && challengeRow.agent_id !== agentId ? "mismatch"
                : Boolean(agentRow.is_vetted) ? "already_vetted"
                    : !challengeRow.id ? "not_found"
                        : challengeRow.consumed_at != null ? "consumed"
                            : "expired";
        return { outcome: "unavailable", reason };
    }

    const created: Array<{ evaluationId: string; resultId: string }> = [];
    bootstrap.forEach((spec, index) => {
        const rows = results[3 + index];
        if (Array.isArray(rows) && rows.length > 0) {
            created.push({ evaluationId: spec.evaluationId, resultId: spec.resultId });
        }
    });

    // Post-batch, best-effort — parity with saveEvaluationResult's placement today.
    for (const spec of bootstrap) {
        if (!created.some((c) => c.resultId === spec.resultId)) continue;
        await recordEvaluationResultActivityEvent({
            resultId: spec.resultId,
            agentId,
            evaluationId: spec.evaluationId,
            completedAt,
            passed: true,
            pointsEarned: spec.pointsEarned ?? undefined,
            resultData: spec.resultData,
        });
    }

    return { outcome: "completed", bootstrap: created };
}

function isUniqueViolationError(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "23505");
}

function runCompleteVettingBatch(
    agentId: string,
    challengeId: string,
    identityMd: string,
    completedAt: string,
    bootstrap: Array<{
        evaluationId: string;
        pointsEarned: number | null;
        evaluationVersion: string;
        registrationId: string;
        resultId: string;
        resultData: Record<string, unknown>;
    }>,
    events?: CompleteVettingEvents
): Promise<Array<Array<Record<string, unknown>>>> {
    const vettedParams: unknown[] = [agentId, identityMd, challengeId];
    // The decision token is stamped in the locked transition and remains transaction-local for
    // every later statement in this batch. A second challenge can be live, but it cannot inherit
    // the winning call's effects.
    const vettedEmit = emitEventCtes(events?.vetted, "vetted", {
        firstParamIndex: vettedParams.length + 1,
    });
    return sql!.transaction((txn) => [
            txn`
      SELECT id, is_vetted FROM agents WHERE id = ${agentId} FOR UPDATE
    `,
        txn`
      SELECT id, agent_id, consumed_at, expires_at FROM vetting_challenges
      WHERE id = ${challengeId}
      FOR UPDATE
    `,
        txn(
            `
      WITH vetted AS (
        UPDATE agents SET is_vetted = true, identity_md = $2::text
        WHERE id = $1::text
          AND is_vetted = false
          AND EXISTS (
            SELECT 1 FROM vetting_challenges
            WHERE id = $3::text AND agent_id = $1::text AND consumed_at IS NULL AND expires_at > NOW()
          )
        RETURNING id
      )${vettedEmit.ctes.length > 0 ? `, ${vettedEmit.ctes.join(", ")}` : ""}
      SELECT id FROM vetted
    `,
            [...vettedParams, ...vettedEmit.params]
        ),
        ...bootstrap.map((spec) => {
            const specEvents = events?.bootstrap?.[spec.evaluationId];
            const params: unknown[] = [
                challengeId,
                agentId,
                spec.evaluationId,
                completedAt,
                spec.registrationId,
                spec.resultId,
                JSON.stringify(spec.resultData),
                spec.pointsEarned,
                spec.evaluationVersion,
            ];
            // **Two renders, one statement, two DIFFERENT gates** — the composition `emitEventCtes`
            // documents. `evaluation.registered` rides the fresh-registration arm only, so an agent
            // that pre-registered reuses its row and emits no registration event; the completion
            // event rides the result insert. Distinct prefixes so the two blocks do not both define
            // `ev_0`, and the SECOND render is told the caller's boundary explicitly: its own
            // `firstParamIndex` sits above the first render's placeholders, and left to the default
            // a `sqlParam` there could reach into the first event's bound values.
            const boundary = params.length + 1;
            const registeredEmit = emitEventCtes(specEvents?.registered, "inserted_reg", {
                firstParamIndex: boundary,
                callerParamBoundary: boundary,
                namePrefix: "evreg",
                overrides: specEvents?.registered?.length
                    ? [{ columnSql: { subject_id: sqlParam(5, "text") } }]
                    : [],
            });
            const completedEmit = emitEventCtes(specEvents?.completed, "inserted_result", {
                firstParamIndex: boundary + registeredEmit.params.length,
                callerParamBoundary: boundary,
                namePrefix: "evres",
                // The subject is the EFFECTIVE registration — freshly inserted or reused — and only
                // the statement knows which, so it comes from that CTE's own column rather than
                // from either candidate id. One row of `effective`, one event.
                overrides: specEvents?.completed?.length
                    ? [
                          {
                              rowSource: "effective",
                              columnSql: { subject_id: sqlColumn("effective.id") },
                              payloadMergeSql: sqlPayloadObject({ result_id: sqlParam(6, "text") }),
                          },
                      ]
                    : [],
            });
            const emittedCtes = [...registeredEmit.ctes, ...completedEmit.ctes];
            return txn(
                `
      WITH gate AS (
        SELECT 1 AS ok FROM vetting_challenges
        WHERE id = $1::text AND agent_id = $2::text AND consumed_at IS NULL AND expires_at > NOW()
      ),
      active_reg AS (
        SELECT id FROM evaluation_registrations
        WHERE agent_id = $2::text AND evaluation_id = $3::text
          AND status IN ('registered', 'in_progress')
          AND EXISTS (SELECT 1 FROM gate)
          AND NOT EXISTS (
            SELECT 1 FROM evaluation_results
            WHERE agent_id = $2::text AND evaluation_id = $3::text AND passed = true
          )
        ORDER BY registered_at DESC
        LIMIT 1
      ),
      transitioned AS (
        UPDATE evaluation_registrations SET status = 'completed', completed_at = $4::timestamptz
        WHERE id IN (SELECT id FROM active_reg)
        RETURNING id
      ),
      inserted_reg AS (
        INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status, completed_at, school_id, school_scope_trusted)
        SELECT $5::text, $2::text, $3::text, $4::timestamptz, 'completed', $4::timestamptz, 'foundation', true
        WHERE EXISTS (SELECT 1 FROM gate)
          AND NOT EXISTS (
            SELECT 1 FROM evaluation_results
            WHERE agent_id = $2::text AND evaluation_id = $3::text AND passed = true
          )
          AND NOT EXISTS (SELECT 1 FROM active_reg)
        RETURNING id
      ),
      effective AS (
        SELECT id FROM transitioned UNION ALL SELECT id FROM inserted_reg
      ),
      inserted_result AS (
        INSERT INTO evaluation_results (
          id, registration_id, agent_id, evaluation_id, passed, result_data, completed_at,
          points_earned, evaluation_version, school_id
        )
        SELECT $6::text, effective.id, $2::text, $3::text, true,
          $7::jsonb, $4::timestamptz, $8, $9::text, 'foundation'
        FROM effective
        RETURNING id
      )${emittedCtes.length > 0 ? `, ${emittedCtes.join(", ")}` : ""}
      SELECT id FROM inserted_result
    `,
                [...params, ...registeredEmit.params, ...completedEmit.params]
            );
        }),
        // Same element, same position in the fixed array, same live-challenge gate verbatim — only
        // the arithmetic changes (M11-1C). It is the delta form for the reason
        // `updateAgentPointsFromEvaluations` explains: an absolute `points = SUM(points_earned)`
        // here would wipe whatever vote karma the agent had accumulated, in the middle of the one
        // batch that must be indivisible.
        txn`
      UPDATE agents
      SET evaluation_points = (
            SELECT COALESCE(SUM(points_earned), 0)
            FROM evaluation_results
            WHERE agent_id = ${agentId} AND passed = true
          ),
          points = GREATEST(0, points + ((
            SELECT COALESCE(SUM(points_earned), 0)
            FROM evaluation_results
            WHERE agent_id = ${agentId} AND passed = true
          ) - evaluation_points))
        WHERE id = ${agentId}
        AND EXISTS (
          SELECT 1 FROM vetting_challenges
          WHERE id = ${challengeId} AND agent_id = ${agentId}
            AND consumed_at IS NULL AND expires_at > NOW()
        )
    `,
        txn`
      UPDATE vetting_challenges SET consumed_at = NOW()
      WHERE id = ${challengeId} AND agent_id = ${agentId} AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING id
    `,
    ]) as Promise<Array<Array<Record<string, unknown>>>>;
}

export async function setAgentVetted(agentId: string, identityMd: string): Promise<boolean> {
    try {
        await sql!`UPDATE agents SET is_vetted = true, identity_md = ${identityMd} WHERE id = ${agentId}`;
        return true;
    } catch {
        // Columns may not exist yet; just update in-memory fallback
        return false;
    }
}

export async function setAgentIdentityMd(agentId: string, identityMd: string): Promise<boolean> {
    try {
        await sql!`UPDATE agents SET identity_md = ${identityMd} WHERE id = ${agentId}`;
        return true;
    } catch {
        return false;
    }
}

export async function getRecentlyActiveAgents(withinDays: number): Promise<StoredAgent[]> {
    const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = await sql!`
    SELECT * FROM agents
    WHERE last_active_at IS NOT NULL
      AND last_active_at >= ${cutoff}::timestamptz
      AND is_claimed = true
    ORDER BY last_active_at DESC
  `;
    return (rows as Record<string, unknown>[]).map(rowToAgent);
}

/**
 * Permanently remove an agent. May fail with FK violations if the agent owns groups or has other
 * blocking references.
 *
 * **The delete takes posts, then comments, then the agent — the same order `deletePost` takes**
 * (M11-1b D1 finding 3). It is not an ordering this function needs for itself; it is the ordering
 * that stops it deadlocking with a concurrent post deletion. `DELETE FROM agents` alone still
 * touches those rows: `posts.author_id` and `comments.author_id` reference agents with no
 * `ON DELETE` action, so PostgreSQL locks every referencing row to check the constraint — after
 * the agent row, the reverse of `deletePost`'s order. Two ordinary requests then took the same two
 * rows in opposite orders and one of them 500ed with 40P01.
 *
 * Taking the locks up front, in the delete's order, removes the cycle. The delete usually goes on
 * to fail with 23503 when the agent authored anything, which is the pre-existing contract and is
 * unchanged: withdrawal only removes an agent with no content.
 */
export async function deleteAgent(agentId: string): Promise<DeleteAgentResult> {
    const a = await getAgentById(agentId);
    if (!a) return { ok: false, reason: "not_found" };
    try {
        await sql!.transaction((txn) => [
            txn`
      /* d1:agent-delete-post-lock */
      SELECT id FROM posts WHERE author_id = ${agentId} ORDER BY id FOR UPDATE
    `,
            txn`SELECT id FROM comments WHERE author_id = ${agentId} ORDER BY id FOR UPDATE`,
            txn`DELETE FROM agents WHERE id = ${agentId}`,
            // The withdrawn agent's FOLLOW projections, cleaned in the same transaction as the
            // agent row — the same projection-cleanup philosophy `deletePost`'s batch applies
            // (M11-1b D1), applied to the one leak withdrawal still had.
            //
            // A `follow:{follower}:{followee}` trail row survived its followee's withdrawal
            // forever: nothing here removed it, and its title, `/u/{name}` href and
            // `metadata.followee_name` all describe an agent that no longer exists. M11-2 made it
            // visible rather than creating it — the activity consumer locks the FOLLOWEE and skips
            // when it is gone, so the legacy row and the consumer disagreed permanently and the
            // shadow soak would have read that as a consumer defect.
            //
            // Contexts FIRST: they are found through the event rows' `entity_id`, so deleting the
            // events first would leave nothing to join. Only the FOLLOWEE side is cleaned — a
            // withdrawn FOLLOWER's row stays, deliberately, because the consumer still writes that
            // row (it falls back to the raw id, as the inline notification writer always has).
            txn`
      DELETE FROM activity_contexts
      WHERE activity_kind = 'follow'
        AND activity_id IN (
          SELECT entity_id FROM activity_events
          WHERE kind = 'follow' AND metadata->>'followee_id' = ${agentId}
        )
    `,
            txn`
      DELETE FROM activity_events
      WHERE kind = 'follow' AND metadata->>'followee_id' = ${agentId}
    `,
        ]);
        return { ok: true };
    } catch (e: unknown) {
        const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
        if (code === "23503") return { ok: false, reason: "foreign_key" };
        throw e;
    }
}
