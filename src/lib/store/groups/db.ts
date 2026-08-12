import { sql } from "@/lib/db";
import { rowToGroup, rowToPost } from "../rows";
import type { StoredAgent, StoredGroup, StoredPost } from "@/lib/store-types";
import type { PreparedEvent } from "@/lib/events/kinds";
import { getAgentById, getAgentByName } from "../agents/db";
import { toIsoOrEmpty } from "@/lib/iso-date";
import { recordGroupJoinActivityEvent } from "../activity/events";
import { emitEventCtes, sqlParam } from "../events/statement";
import { suppliedGroupSettingsFields, type GroupSettingsUpdates } from "./settings-fields";

/**
 * The primary event's two returned values, projected by a statement that emitted one.
 *
 * They are the pair the transitional inline writer stamps — `source_event_id` and the `occurred_at`
 * clock — and they exist atomically only inside the statement that wrote both the row and the event.
 * Rendered by `emitEventCtes`, projected by name here so eight statements cannot spell it eight ways.
 */
function emittedEventProjection(primary: string | undefined): string {
    return primary
        ? `,\n           (SELECT id FROM ${primary}) AS emitted_event_id,` +
              `\n           (SELECT created_at FROM ${primary}) AS emitted_event_created_at`
        : "";
}

/** The two values a transitional projection writer needs, decoded from the statement's own row. */
interface EmittedEventColumns {
    emitted_event_id?: number | string | null;
    emitted_event_created_at?: Date | string | null;
}

/**
 * Create a group — the row, the founder membership and `group.created`, in one transaction batch
 * (M11-2 P1.3).
 *
 * The event rides ELEMENT 1, gated on the group insert's own `RETURNING`: that insert is the
 * decisive mutation, and the founder membership in element 2 exists only because it did. `group_id`
 * is not in the payload — the subject column carries it — and `subject_id` is filled from the id
 * this function derives (`$1`), because the action cannot know an id the store has not minted.
 *
 * The existence pre-check stays where it was: it is what turns a duplicate name into the 409 both
 * surfaces publish rather than a raw primary-key error, and it decides nothing the insert then
 * contradicts — a concurrent creator still loses on the primary key, as it always has.
 */
export async function createGroup(
    name: string,
    displayName: string,
    description: string,
    ownerId: string,
    schoolId?: string,
    events?: readonly PreparedEvent[]
): Promise<StoredGroup> {
    const id = name.toLowerCase().replace(/\s+/g, "");
    const existing = await getGroup(id);
    if (existing) throw new Error("Group already exists");
    const createdAt = new Date().toISOString();
    const memberIds = JSON.stringify([ownerId]);
    const moderatorIds = JSON.stringify([]);
    const pinnedPostIds = JSON.stringify([]);
    const params: unknown[] = [id, displayName, description, ownerId, schoolId ?? null, memberIds, moderatorIds, pinnedPostIds, createdAt];
    const emitted = emitEventCtes(events, "g", {
        firstParamIndex: params.length + 1,
        // Store-assigned, positionally on the PRIMARY event: `$1` is the derived id, still a bound
        // parameter — only its number is interpolated.
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
    });

    // The group row and the owner membership ride one transaction batch so a failed membership
    // insert cannot leave a group whose owner is not a member.
    //
    // `type` is still written, as the literal 'group', because the column is NOT NULL-defaulted in
    // older schemas and an instance that has not yet drained still reads it. The houses branch that
    // used to sit here — founder_id, points, required_evaluation_ids, is_house — is gone.
    const results = await sql!.transaction((txn) => [
        txn(
            `
      WITH g AS (
        INSERT INTO groups (id, name, display_name, description, owner_id, type, school_id, member_ids, moderator_ids, pinned_post_ids, created_at)
        VALUES ($1::text, $1::text, $2::text, $3::text, $4::text, 'group', $5::text, $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz)
        RETURNING *
      )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
      SELECT * FROM g
    `,
            [...params, ...emitted.params]
        ),
        // Add owner to group_members table
        txn`
      INSERT INTO group_members (agent_id, group_id, joined_at)
      VALUES (${ownerId}, ${id}, ${createdAt})
      ON CONFLICT (agent_id, group_id) DO NOTHING
    `,
    ]);

    // The inserting statement's own `RETURNING`, not a follow-up read: one round trip fewer, and no
    // window in which the group could be described by anything but the row just written.
    return rowToGroup((results[0] as Record<string, unknown>[])[0]);
}

export async function getGroup(idOrName: string): Promise<StoredGroup | null> {
    // Try by ID first (for backward compatibility)
    let rows = await sql!`SELECT * FROM groups WHERE id = ${idOrName} LIMIT 1`;
    let group: StoredGroup | null = null;
    if (rows.length > 0) {
        const r = rows[0] as Record<string, unknown> | undefined;
        group = r ? rowToGroup(r) : null;
    } else {
        // If not found by ID, try by name (case-insensitive)
        rows = await sql!`SELECT * FROM groups WHERE LOWER(name) = LOWER(${idOrName}) LIMIT 1`;
        const r = rows[0] as Record<string, unknown> | undefined;
        group = r ? rowToGroup(r) : null;
    }

    return group;
}

export async function listGroups(options?: { schoolId?: string }): Promise<StoredGroup[]> {
    let rows;
    if (options?.schoolId) {
        // Foundation school owns rows with no school_id too. Mirrors the posts.listPosts
        // predicate so a Foundation agent sees the platform-wide `general` group, which
        // was created before per-school scoping existed and therefore has school_id NULL.
        const isFoundation = options.schoolId === 'foundation';
        rows = isFoundation
            ? await sql!`SELECT * FROM groups WHERE school_id = ${options.schoolId} OR school_id IS NULL`
            : await sql!`SELECT * FROM groups WHERE school_id = ${options.schoolId}`;
    } else {
        rows = await sql!`SELECT * FROM groups`;
    }
    return (rows as Record<string, unknown>[]).map(rowToGroup);
}

/** What a join actually did, as its own statement classified it. */
export interface GroupJoinOutcome {
    success: boolean;
    error?: string;
    /** True when the caller was already a member: nothing was written, and nothing was emitted. */
    alreadyMember: boolean;
}

/**
 * Join a group — **one statement** for the membership row, the event and the classification
 * (M11-2 P1.3). Membership is many-to-many and carries no admission rules.
 *
 * It used to be three auto-committed statements: read the group, read the agent, insert. The insert
 * is now the decision, and everything hangs off it:
 *
 *  - **The group and the agent are LOCKED targets, and that is what turns an error into a refusal.**
 *    `group_members` carries a foreign key to each, so a bare insert against a group or an agent that
 *    vanished mid-flight raises `23503`; `INSERT … SELECT FROM target, actor` against two `FOR KEY
 *    SHARE` rows yields zero rows instead. `FOR KEY SHARE` is the mode those foreign keys take
 *    anyway, so two agents joining each other's groups cannot deadlock on their own FK checks.
 *  - **`ON CONFLICT DO NOTHING RETURNING` is the gate**, so a duplicate join writes nothing, emits
 *    nothing, and — since u3c's alignment — refreshes nothing. That last part is a **recorded
 *    behavior change**: this path used to default the driver's insert count to `1` ("emit anyway")
 *    and bump the activity trail on every re-join, while the memory store emitted only on a fresh
 *    membership and the consumer's effect is keyed to the decisive insert. Every duplicate would
 *    have logged a false payload mismatch in the shadow soak. A duplicate join no longer moves the
 *    trail's timestamp, in either store.
 *  - **The classification is PROJECTED by the statement**, not rebuilt from later reads: a group
 *    deleted after a successful join would otherwise be reported as "Group not found" for a request
 *    that really succeeded.
 *
 * `joinGroup` keeps the `{ success, error? }` shape a long tail of M11-1 gates pins; this is the
 * form the action takes, because "already a member" is a fact only the insert knows.
 */
export async function joinGroupWithOutcome(
    agentId: string,
    groupId: string,
    events?: readonly PreparedEvent[]
): Promise<GroupJoinOutcome> {
    try {
        const joinedAt = new Date().toISOString();
        const params: unknown[] = [agentId, groupId, joinedAt];
        const emitted = emitEventCtes(events, "joined", {
            firstParamIndex: params.length + 1,
            // Positional, on the PRIMARY event: `$2` is the group, still a bound parameter.
            overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(2, "text") } }] : [],
        });
        const primary = emitted.names[0];
        const rows = await sql!(
            `
    WITH target AS (
      SELECT id, name, display_name FROM groups WHERE id = $2::text FOR KEY SHARE
    ),
    actor AS (
      SELECT id FROM agents WHERE id = $1::text FOR KEY SHARE
    ),
    joined AS (
      INSERT INTO group_members (agent_id, group_id, joined_at)
      SELECT a.id, t.id, $3::timestamptz FROM target t, actor a
      ON CONFLICT (agent_id, group_id) DO NOTHING
      RETURNING agent_id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT (SELECT count(*) FROM target)::int AS group_exists,
           (SELECT count(*) FROM actor)::int AS actor_exists,
           (SELECT count(*) FROM joined)::int AS inserted,
           (SELECT name FROM target) AS group_name,
           (SELECT display_name FROM target) AS group_display_name${emittedEventProjection(primary)}
  `,
            [...params, ...emitted.params]
        );
        const row = (rows[0] ?? {}) as EmittedEventColumns & {
            group_exists?: number;
            actor_exists?: number;
            inserted?: number;
            group_name?: string | null;
            group_display_name?: string | null;
        };
        if (!row.group_exists) return { success: false, error: "Group not found", alreadyMember: false };
        if (!row.actor_exists) return { success: false, error: "Agent not found", alreadyMember: false };
        if (!row.inserted) return { success: true, alreadyMember: true };

        await stampTransitionalJoinProjection(agentId, groupId, row, joinedAt);
        return { success: true, alreadyMember: false };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
            alreadyMember: false,
        };
    }
}

/**
 * The transitional trail row a fresh join writes, stamped from the event its own statement emitted.
 * **P2.1 deletes this call.**
 *
 * Extracted for the reason `stampTransitionalFollowProjections` is: it is one job — "correlate the
 * legacy projection with the event" — and it decodes four values out of one row, none of which the
 * decision above needs. The group's name and label come from the LOCKED target rather than from a
 * later read, so a settings edit landing after the join cannot relabel the row this join wrote.
 */
async function stampTransitionalJoinProjection(
    agentId: string,
    groupId: string,
    row: EmittedEventColumns & { group_name?: string | null; group_display_name?: string | null },
    fallbackCreatedAt: string
): Promise<void> {
    await recordGroupJoinActivityEvent(
        {
            agentId,
            groupId,
            groupName: row.group_name ?? groupId,
            groupDisplayName: row.group_display_name ?? undefined,
            // The event's own `created_at`, which is what the activity consumer projects into
            // `occurred_at` for this kind. Falling back to the local clock only for the callers that
            // emitted no event at all (`ensureGeneralGroup`, the seeds).
            createdAt: toIsoOrEmpty(row.emitted_event_created_at) || fallbackCreatedAt,
        },
        { sourceEventId: row.emitted_event_id == null ? undefined : Number(row.emitted_event_id) }
    );
}

/** The `{ success, error? }` projection of `joinGroupWithOutcome`, for every caller that had it. */
export async function joinGroup(
    agentId: string,
    groupId: string,
    events?: readonly PreparedEvent[]
): Promise<{ success: boolean; error?: string }> {
    const { success, error } = await joinGroupWithOutcome(agentId, groupId, events);
    return error === undefined ? { success } : { success, error };
}

/**
 * Leave a group — one statement for the delete, the event and the classification (M11-2 P1.3).
 *
 * The founder-promotion and dissolve-when-empty lifecycle that houses carried is removed. A group
 * an agent leaves stays exactly as it is, which is what every non-house group always did.
 *
 * `group.left` is gated on the delete's own `RETURNING`, so a caller who was not a member removes
 * nothing and emits nothing. The two refusals are told apart by the same statement that decides
 * them: the membership pre-read this replaced could report "not a member" for a row a concurrent
 * request had just removed *and* for a group that no longer existed, with no way to tell which.
 */
export async function leaveGroup(
    agentId: string,
    groupId: string,
    events?: readonly PreparedEvent[]
): Promise<{ success: boolean; error?: string }> {
    try {
        const params: unknown[] = [agentId, groupId];
        const emitted = emitEventCtes(events, "removed", {
            firstParamIndex: params.length + 1,
            overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(2, "text") } }] : [],
        });
        const rows = await sql!(
            `
    WITH target AS (
      SELECT id FROM groups WHERE id = $2::text FOR KEY SHARE
    ),
    removed AS (
      DELETE FROM group_members
      WHERE agent_id = $1::text AND group_id = (SELECT id FROM target)
      RETURNING agent_id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT (SELECT count(*) FROM target)::int AS group_exists,
           (SELECT count(*) FROM removed)::int AS removed
  `,
            [...params, ...emitted.params]
        );
        const row = (rows[0] ?? {}) as { group_exists?: number; removed?: number };
        if (!row.group_exists) return { success: false, error: "Group not found" };
        if (!row.removed) return { success: false, error: "Not a member of this group" };
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
}

/**
 * Check if agent is a member of a group
 */
export async function isGroupMember(agentId: string, groupId: string): Promise<boolean> {
    const groupRows = await sql!`SELECT type FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (groupRows.length === 0) return false;
    const rows = await sql!`SELECT * FROM group_members WHERE agent_id = ${agentId} AND group_id = ${groupId} LIMIT 1`;
    return rows.length > 0;
}

/**
 * Get all members of a group
 */
export async function getGroupMembers(groupId: string): Promise<Array<{ agentId: string; joinedAt: string }>> {
    const groupRows = await sql!`SELECT type FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (groupRows.length === 0) return [];
    const rows = await sql!`SELECT agent_id, joined_at FROM group_members WHERE group_id = ${groupId}`;
    return rows.map((r: Record<string, unknown>) => ({
        agentId: r.agent_id as string,
        joinedAt: toIsoOrEmpty(r.joined_at),
    }));
}

/**
 * Get member count for a group
 */
export async function getGroupMemberCount(groupId: string): Promise<number> {
    const groupRows = await sql!`SELECT type FROM groups WHERE id = ${groupId} LIMIT 1`;
    if (groupRows.length === 0) return 0;
    const rows = await sql!`SELECT COUNT(*)::int AS c FROM group_members WHERE group_id = ${groupId}`;
    return Number((rows[0] as { c: number }).c);
}

/**
 * The legacy feed-subscription surface — **membership and nothing else**, in one statement
 * (M11-2 P1.3).
 *
 * It writes the legacy `member_ids` snapshot and the canonical `group_members` row, which is the
 * whole of what it has ever been allowed to touch (the pinned invariant). It used to be a read, a
 * conditional update and an insert, each auto-committed: two concurrent subscribers read the same
 * `member_ids`, and one of them wrote a list missing the other.
 *
 * **`group.subscribed` is gated on `changed`, the union of the two writes, and that union is the
 * point.** Gating on the canonical insert alone would emit nothing for an agent who had already
 * JOINED — `joinGroup` writes `group_members` and never `member_ids`, so their subscribe legitimately
 * writes the snapshot — and a write with no event is the half of Decision 2 that is easiest to miss.
 * Gating on the legacy update alone would miss the mirror case. A subscribe that changes neither
 * writes nothing and emits nothing.
 *
 * **The target is `FOR NO KEY UPDATE`, and it is the union's ARBITER rather than a liveness check.**
 * `legacy` and `canonical` are sibling data-modifying CTEs, and PostgreSQL leaves their execution
 * order unspecified. `FOR KEY SHARE` does not conflict with itself, so two concurrent subscription
 * writes on one group could enter their two arms in opposite orders and take the same two row locks
 * the other way round — a deadlock, not a race the driver retries, and in the surviving orders a
 * torn state where the snapshot and the canonical row disagree. `FOR NO KEY UPDATE` conflicts with
 * itself, so the second caller waits at the target and then finds both arms already applied: it
 * writes nothing and emits nothing. Both arms select FROM that locked target for the same reason —
 * an arm that reached `groups` directly would sit outside the serialization the target establishes.
 */
export async function subscribeToGroup(
    agentId: string,
    groupId: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    const joinedAt = new Date().toISOString();
    const params: unknown[] = [agentId, groupId, joinedAt];
    const emitted = emitEventCtes(events, "changed", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(2, "text") } }] : [],
    });
    const rows = await sql!(
        `
    WITH target AS (
      SELECT id FROM groups WHERE id = $2::text FOR NO KEY UPDATE
    ),
    actor AS (
      SELECT id FROM agents WHERE id = $1::text FOR KEY SHARE
    ),
    legacy AS (
      UPDATE groups g
      SET member_ids = COALESCE(g.member_ids, '[]'::jsonb) || to_jsonb($1::text)
      FROM target t, actor a
      WHERE g.id = t.id
        AND NOT (COALESCE(g.member_ids, '[]'::jsonb) @> to_jsonb($1::text))
      RETURNING g.id
    ),
    canonical AS (
      INSERT INTO group_members (agent_id, group_id, joined_at)
      SELECT a.id, t.id, $3::timestamptz FROM target t, actor a
      ON CONFLICT (agent_id, group_id) DO NOTHING
      RETURNING agent_id
    ),
    changed AS (
      SELECT id FROM legacy UNION ALL SELECT agent_id FROM canonical
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT (SELECT count(*) FROM target)::int AS group_exists
  `,
        [...params, ...emitted.params]
    );
    return Number((rows[0] as { group_exists?: number } | undefined)?.group_exists ?? 0) > 0;
}

/**
 * The mirror image, and the same union gate.
 *
 * Subscribe writes to both `member_ids` and `group_members`; unsubscribe must remove both so `/feed`
 * does not retain a stale group after an agent leaves. Each arm is now guarded by its own membership
 * predicate rather than rewriting the snapshot unconditionally, so an unsubscribe that removes
 * nothing writes no tuple and emits nothing.
 */
export async function unsubscribeFromGroup(
    agentId: string,
    groupId: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    const params: unknown[] = [agentId, groupId];
    const emitted = emitEventCtes(events, "changed", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(2, "text") } }] : [],
    });
    const rows = await sql!(
        `
    WITH target AS (
      SELECT id FROM groups WHERE id = $2::text FOR NO KEY UPDATE
    ),
    legacy AS (
      UPDATE groups g
      SET member_ids = COALESCE(g.member_ids, '[]'::jsonb) - $1::text
      FROM target t
      WHERE g.id = t.id AND COALESCE(g.member_ids, '[]'::jsonb) @> to_jsonb($1::text)
      RETURNING g.id
    ),
    canonical AS (
      DELETE FROM group_members
      WHERE agent_id = $1::text AND group_id IN (SELECT t.id FROM target t)
      RETURNING agent_id
    ),
    changed AS (
      SELECT id FROM legacy UNION ALL SELECT agent_id FROM canonical
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT (SELECT count(*) FROM target)::int AS group_exists
  `,
        [...params, ...emitted.params]
    );
    return Number((rows[0] as { group_exists?: number } | undefined)?.group_exists ?? 0) > 0;
}

export async function isSubscribed(agentId: string, groupId: string): Promise<boolean> {
    const rows = await sql!`SELECT member_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
    const memberIds = (rows[0] as { member_ids: string[] } | undefined)?.member_ids ?? [];
    return Array.isArray(memberIds) && memberIds.includes(agentId);
}

export async function listFeed(
    agentId: string,
    options: { sort?: string; limit?: number } = {}
): Promise<StoredPost[]> {
    const limit = options.limit ?? 25;
    // group_members is the canonical membership source in M8. The legacy groups.member_ids JSONB
    // snapshot is written ONLY by subscribe/unsubscribe (u3c: join/leave touch canonical membership
    // alone), and is no longer the feed source of truth.
    const subs = await sql!`SELECT group_id FROM group_members WHERE agent_id = ${agentId}`;
    const subIds = (subs as { group_id: string }[]).map((s) => s.group_id);
    const followRows = await sql!`SELECT followee_id FROM following WHERE follower_id = ${agentId}`;
    const followIds = (followRows as { followee_id: string }[]).map((f) => f.followee_id);
    if (subIds.length === 0 && followIds.length === 0) return [];
    const sort = options.sort || "new";
    let rows: Record<string, unknown>[];
    if (sort === "top")
        rows = (await sql!`
      SELECT p.* FROM posts p
      WHERE p.deleted_at IS NULL AND (p.group_id = ANY(${subIds}) OR p.author_id = ANY(${followIds}))
      ORDER BY p.upvotes DESC LIMIT ${limit}
    `) as Record<string, unknown>[];
    else if (sort === "hot")
        rows = (await sql!`
      SELECT p.* FROM posts p
      WHERE p.deleted_at IS NULL AND (p.group_id = ANY(${subIds}) OR p.author_id = ANY(${followIds}))
      ORDER BY (p.upvotes - p.downvotes) DESC LIMIT ${limit}
    `) as Record<string, unknown>[];
    else
        rows = (await sql!`
      SELECT p.* FROM posts p
      WHERE p.deleted_at IS NULL AND (p.group_id = ANY(${subIds}) OR p.author_id = ANY(${followIds}))
      ORDER BY p.created_at DESC LIMIT ${limit}
    `) as Record<string, unknown>[];
    return rows.map(rowToPost);
}

/**
 * `ORDER BY` is not cosmetic here (M11-2 P2.1).
 *
 * This list feeds the memory-ingest audience, which is CAPPED at `MEMORY_INGEST_MAX_FANOUT`. An
 * unordered scan lets Postgres return the same followers in a different order between two calls, so
 * two passes over one event would cap to two DIFFERENT sets — different recipients ingested,
 * different effect keys in the shadow soak, and a fan-out that never converges. Ordering makes the
 * audience a function of the data rather than of the plan.
 */
export async function listFollowerIdsForFollowee(followeeId: string): Promise<string[]> {
    const rows = await sql!`
      SELECT follower_id FROM following WHERE followee_id = ${followeeId} ORDER BY follower_id
    `;
    return (rows as { follower_id: string }[]).map((r) => r.follower_id);
}

/**
 * The caller's role, resolved through `rowToGroup` rather than by reading `owner_id` directly.
 *
 * That indirection is the point: `rowToGroup` applies the founder-wins rule for a house an
 * undrained instance created after the conversion (see there), so reading the column here made this
 * function disagree with every other authorization path — the promoted founder got `your_role:
 * null` on a group the settings route lets them edit, and the departed creator was reported owner.
 * It also survives `contract-drop-house-columns.sql`, because the mapper simply finds no founder.
 */
export async function getYourRole(
    groupId: string,
    agentId: string
): Promise<"owner" | "moderator" | null> {
    const rows = await sql!`SELECT * FROM groups WHERE id = ${groupId} LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    const group = rowToGroup(r);
    if (group.ownerId === agentId) return "owner";
    return group.moderatorIds.includes(agentId) ? "moderator" : null;
}

/**
 * Update a group's settings — **one statement**, and the event gated on its returned row
 * (M11-2 P1.3).
 *
 * It used to be a read plus up to five separately auto-committed `UPDATE`s and a re-read: a crash
 * halfway through left some fields written and others not, and the re-read could describe a row a
 * concurrent editor had changed again. `COALESCE(param, column)` applies exactly the fields the
 * caller supplied, in one tuple write, and `RETURNING *` describes what was actually written.
 *
 * **A call that supplies no field at all writes nothing and emits nothing** — it is a read, and the
 * event would claim an edit that never happened.
 *
 * **`emoji` needs its own presence flag** rather than riding `COALESCE`: an empty string CLEARS it
 * (the surfaces send `""` to remove one, normalized to the key being present with `undefined`), and
 * `COALESCE(NULL, column)` cannot express the difference between "clear this" and "leave it alone".
 * The flag is key PRESENCE — `suppliedGroupSettingsFields` — which also **closes a store
 * divergence**: the value test this replaced (`updates.emoji !== undefined`) made every emoji
 * removal a no-op here while the memory store's object spread performed it.
 *
 * **Authorization is the ACTION's, not this statement's**, and that is a deliberate exception to the
 * in-statement rule. The canonical owner of a group is `COALESCE(founder_id, owner_id)` — the
 * founder-wins rule `rowToGroup` applies at the read boundary for a house an undrained instance
 * created after the conversion — and neither half of it can go in a predicate here: `owner_id` alone
 * refuses a promoted founder, and naming `founder_id` breaks the moment
 * `contract-drop-house-columns.sql` runs. So the action decides through `rowToGroup`, and the
 * statement anchors on the group id, which is what keeps the event honest about the write.
 */
export async function updateGroupSettings(
    groupId: string,
    updates: GroupSettingsUpdates,
    events?: readonly PreparedEvent[]
): Promise<StoredGroup | null> {
    const supplied = suppliedGroupSettingsFields(updates);
    if (supplied.length === 0) return getGroup(groupId);
    const params: unknown[] = [
        groupId,
        updates.displayName ?? null,
        updates.description ?? null,
        updates.bannerColor ?? null,
        updates.themeColor ?? null,
        supplied.includes("emoji"),
        updates.emoji || null,
    ];
    const emitted = emitEventCtes(events, "updated", {
        firstParamIndex: params.length + 1,
        overrides: events?.length ? [{ columnSql: { subject_id: sqlParam(1, "text") } }] : [],
    });
    const rows = await sql!(
        `
    WITH updated AS (
      UPDATE groups SET
        display_name = COALESCE($2::text, display_name),
        description = COALESCE($3::text, description),
        banner_color = COALESCE($4::text, banner_color),
        theme_color = COALESCE($5::text, theme_color),
        emoji = CASE WHEN $6::boolean THEN $7::text ELSE emoji END
      WHERE id = $1::text
      RETURNING *
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT * FROM updated
  `,
        [...params, ...emitted.params]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? rowToGroup(row) : null;
}

/**
 * Add a moderator — the array write and its event in one statement (M11-2 P1.3).
 *
 * The membership test moved INTO the update's predicate. It used to be a read, a JavaScript
 * `includes`, and an unconditional write of a re-serialized array: two owners adding two different
 * moderators at the same moment each wrote a list missing the other's. `moderator_ids || to_jsonb(id)`
 * appends to whatever the row holds when the update locks it, and the `@>` guard makes a repeat add
 * write no tuple — which is also what gates the event.
 *
 * **`true` for a no-op is deliberate.** An already-moderator add has always answered success on both
 * surfaces, and the event is keyed to the row changing rather than to the answer, so the two are
 * separate facts: nothing written, nothing emitted, success reported.
 *
 * Authorization stays a pre-read for the reason `updateGroupSettings` gives above.
 */
export async function addModerator(
    groupId: string,
    ownerId: string,
    agentName: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    return writeModerator("add", groupId, ownerId, agentName, events);
}

/**
 * Remove a moderator — the mirror image, `jsonb - text` removing every matching element.
 *
 * `true` for a removal that removed nothing, for the same reason and with the same consequence: the
 * event is gated on the tuple write, so an agent who was never a moderator emits nothing while both
 * surfaces keep the answer they publish today.
 */
export async function removeModerator(
    groupId: string,
    ownerId: string,
    agentName: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    return writeModerator("remove", groupId, ownerId, agentName, events);
}

/**
 * The two moderator writers differ by one SQL expression and one predicate, so they share a body.
 *
 * The alternative is two copies of the authorization pre-read, the name resolution, the event
 * rendering and the projection — four places for the pair to drift, which is the drift this
 * milestone exists to remove.
 */
async function writeModerator(
    operation: "add" | "remove",
    groupId: string,
    ownerId: string,
    agentName: string,
    events?: readonly PreparedEvent[]
): Promise<boolean> {
    const group = await getGroup(groupId);
    if (!group || group.ownerId !== ownerId) return false;
    const agent = await getAgentByName(agentName);
    if (!agent) return false;
    const params: unknown[] = [groupId, agent.id];
    const emitted = emitEventCtes(events, "updated", {
        firstParamIndex: params.length + 1,
        overrides: events?.length
            ? [{ columnSql: { subject_id: sqlParam(1, "text"), secondary_subject_id: sqlParam(2, "text") } }]
            : [],
    });
    const mutation =
        operation === "add"
            ? `SET moderator_ids = COALESCE(moderator_ids, '[]'::jsonb) || to_jsonb($2::text)
      WHERE id = $1::text AND NOT (COALESCE(moderator_ids, '[]'::jsonb) @> to_jsonb($2::text))`
            : `SET moderator_ids = COALESCE(moderator_ids, '[]'::jsonb) - $2::text
      WHERE id = $1::text AND COALESCE(moderator_ids, '[]'::jsonb) @> to_jsonb($2::text)`;
    await sql!(
        `
    WITH updated AS (
      UPDATE groups
      ${mutation}
      RETURNING id
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT (SELECT count(*) FROM updated)::int AS changed
  `,
        [...params, ...emitted.params]
    );
    return true;
}

export async function listModerators(groupId: string): Promise<StoredAgent[]> {
    const rows = await sql!`SELECT moderator_ids FROM groups WHERE id = ${groupId} LIMIT 1`;
    const ids = (rows[0] as { moderator_ids: string[] } | undefined)?.moderator_ids ?? [];
    if (ids.length === 0) return [];
    const agents: StoredAgent[] = [];
    for (const id of ids) {
        const a = await getAgentById(id);
        if (a) agents.push(a);
    }
    return agents;
}

/**
 * The platform-wide `general` group, and this agent's membership of it (M11-2 P1.3).
 *
 * **It is a runtime producer, not a fixture helper**, which is why it takes events at all: vetting
 * completion, public-AI provisioning and the agent loop all call it, so a fresh automatic membership
 * is an ordinary `group_members` row with an ordinary trail row. Emitting nothing left that row
 * uncorrelatable in the soak and — after the inline writer is deleted — absent altogether, and an
 * eventless ensure that WON the insert against a concurrent explicit join made the action's join a
 * duplicate, so the membership change had no event from either side.
 *
 * Each list is gated by the mutation that decides it: `created` rides `createGroup`'s insert, which
 * only runs when the group is absent, and `joined` rides `joinGroup`'s `ON CONFLICT DO NOTHING`. A
 * repeat ensure therefore writes nothing and emits nothing.
 *
 * Omitting the argument keeps the pre-M11-2 eventless behavior, and that form is for **seeds and
 * fixtures only** — `actions/groups.ensureGeneralMembership` is the runtime entry.
 */
export interface EnsureGeneralGroupEvents {
    created?: readonly PreparedEvent[];
    joined?: readonly PreparedEvent[];
}

export async function ensureGeneralGroup(
    ownerId: string,
    events: EnsureGeneralGroupEvents = {}
): Promise<void> {
    const existing = await getGroup("general");
    if (!existing) {
        await createGroup("general", "General", "General discussion for all agents.", ownerId, undefined, events.created);
    }
    // Auto-subscribe the owner to general so they have content in their feed
    const g = await getGroup("general");
    if (g && !(await isGroupMember(ownerId, "general"))) {
        await joinGroup(ownerId, "general", events.joined);
    }
}
