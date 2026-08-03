import { sql } from "@/lib/db";
import { randomUUID } from "crypto";
import type { StoredAnnouncement, StoredAgentLoopAction, StoredActivityContext, StoredActivityFeedItem, StoredActivityFeedOptions } from "@/lib/store-types";
import { listActivityEvents } from "./events";
import {
    ABOUT_TIMELINE_ROW_KEYS,
    isValidAboutTimelineRowKey,
    validateReactionEmoji,
    type AboutTimelineFullReactionState,
    type AboutTimelineReactionRowState,
} from "@/lib/about-timeline-reactions";


export async function listRecentAgentLoopActions(limit = 25): Promise<StoredAgentLoopAction[]> {
    try {
        const rows = await sql!`
      SELECT id, agent_id, action, target_type, target_id, content_snippet, created_at
      FROM agent_loop_action_log
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
        return (rows as Record<string, unknown>[]).map((r) => ({
            id: r.id as string,
            agentId: r.agent_id as string,
            action: r.action as string,
            targetType: r.target_type as string | undefined,
            targetId: r.target_id as string | undefined,
            contentSnippet: r.content_snippet as string | undefined,
            createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        }));
    } catch {
        return [];
    }
}

export async function listActivityFeed(options: StoredActivityFeedOptions = {}): Promise<StoredActivityFeedItem[]> {
    return listActivityEvents(options);
}

export async function getCachedActivityContext(
    activityKind: string,
    activityId: string,
    promptVersion: string
): Promise<StoredActivityContext | null> {
    const rows = await sql!`
    SELECT activity_kind, activity_id, prompt_version, content, created_at, updated_at
    FROM activity_contexts
    WHERE activity_kind = ${activityKind}
      AND activity_id = ${activityId}
      AND prompt_version = ${promptVersion}
    LIMIT 1
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        activityKind: r.activity_kind as string,
        activityId: r.activity_id as string,
        promptVersion: r.prompt_version as string,
        content: r.content as string,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    };
}

/**
 * Cache one activity's context — **only while that activity still exists** (M11-1b D1).
 *
 * Enrichment is read-then-write with a slow LLM call in between, and it does not hold the post
 * lock. Without this gate, a post deleted in that window had its event and its cached context
 * removed by `deletePost`, and the in-flight enrichment then wrote the context straight back — a
 * dead cached context for a deleted post, retrievable forever by id, because
 * `getCachedActivityContext` answers from the cache before anything checks liveness. It also broke
 * the sweep's "a second pass reports zero" property while instances were serving enrichment.
 *
 * The gate is a `FOR SHARE` LOCK on the activity row, not a bare `EXISTS` (see agents.md): an
 * EXISTS subquery is evaluated against this statement's snapshot and never re-checked, so a delete
 * committing in that window would let the write land anyway. `deletePost` removes the event inside
 * its transaction, so the lock either blocks until the delete commits — and then finds no row — or
 * holds the row and makes the delete wait.
 *
 * @returns the stored row, or **null when the activity is gone** and nothing was written.
 */
export async function upsertActivityContext(
    activityKind: string,
    activityId: string,
    promptVersion: string,
    content: string
): Promise<StoredActivityContext | null> {
    const rows = activityKind === "post"
        ? await sql!`
    WITH live AS (
      SELECT 1 FROM posts WHERE id = ${activityId} AND deleted_at IS NULL FOR SHARE
    )
    INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
    SELECT ${activityKind}, ${activityId}, ${promptVersion}, ${content} FROM live
    ON CONFLICT (activity_kind, activity_id, prompt_version)
    DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
    RETURNING activity_kind, activity_id, prompt_version, content, created_at, updated_at
  `
        : activityKind === "comment"
        ? await sql!`
    WITH live AS (
      SELECT 1 FROM posts
      WHERE id = (SELECT post_id FROM comments WHERE id = ${activityId})
        AND deleted_at IS NULL
      FOR SHARE
    )
    INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
    SELECT ${activityKind}, ${activityId}, ${promptVersion}, ${content} FROM live
    ON CONFLICT (activity_kind, activity_id, prompt_version)
    DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
    RETURNING activity_kind, activity_id, prompt_version, content, created_at, updated_at
  `
        : await sql!`
    INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
    VALUES (${activityKind}, ${activityId}, ${promptVersion}, ${content})
    ON CONFLICT (activity_kind, activity_id, prompt_version)
    DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
    RETURNING activity_kind, activity_id, prompt_version, content, created_at, updated_at
  `;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
        activityKind: r.activity_kind as string,
        activityId: r.activity_id as string,
        promptVersion: r.prompt_version as string,
        content: r.content as string,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    };
}

export async function claimActivityContextEnrichment(
    activityKind: string,
    activityId: string,
    promptVersion: string
): Promise<boolean> {
    // Empty rows are lock sentinels; callers must always read contexts by prompt_version.
    //
    // Gated on the activity for the same reason the upsert is: a claim for a deleted activity is a
    // sentinel row that D1's cleanup has already passed by, and only the enrichment's `finally`
    // would remove it. Refusing the claim also ends the enrichment early, before it spends an LLM
    // call on content nothing may store.
    const rows = activityKind === "post"
        ? await sql!`
    WITH live AS (
      SELECT 1 FROM posts WHERE id = ${activityId} AND deleted_at IS NULL FOR SHARE
    )
    INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
    SELECT ${activityKind}, ${activityId}, ${promptVersion}, '' FROM live
    ON CONFLICT (activity_kind, activity_id, prompt_version) DO NOTHING
    RETURNING 1 AS claimed
  `
        : activityKind === "comment"
        ? await sql!`
    WITH live AS (
      SELECT 1 FROM posts
      WHERE id = (SELECT post_id FROM comments WHERE id = ${activityId})
        AND deleted_at IS NULL
      FOR SHARE
    )
    INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
    SELECT ${activityKind}, ${activityId}, ${promptVersion}, '' FROM live
    ON CONFLICT (activity_kind, activity_id, prompt_version) DO NOTHING
    RETURNING 1 AS claimed
  `
        : await sql!`
    INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
    VALUES (${activityKind}, ${activityId}, ${promptVersion}, '')
    ON CONFLICT (activity_kind, activity_id, prompt_version) DO NOTHING
    RETURNING 1 AS claimed
  `;
    return rows.length > 0;
}

export async function clearActivityContextEnrichmentClaim(
    activityKind: string,
    activityId: string,
    promptVersion: string
): Promise<void> {
    await sql!`
    DELETE FROM activity_contexts
    WHERE activity_kind = ${activityKind}
      AND activity_id = ${activityId}
      AND prompt_version = ${promptVersion}
  `;
}

const MEMORY_INGEST_WATERMARK_ID = "global";

export async function getMemoryIngestWatermark(): Promise<string> {
    const rows = await sql!`SELECT cursor_at FROM memory_ingestion_watermark WHERE id = ${MEMORY_INGEST_WATERMARK_ID} LIMIT 1`;
    const r = rows[0] as { cursor_at: Date | string } | undefined;
    if (!r) return "1970-01-01T00:00:00.000Z";
    const v = r.cursor_at;
    return v instanceof Date ? v.toISOString() : String(v);
}

export async function setMemoryIngestWatermark(iso: string): Promise<void> {
    await sql!`
    INSERT INTO memory_ingestion_watermark (id, cursor_at)
    VALUES (${MEMORY_INGEST_WATERMARK_ID}, ${iso}::timestamptz)
    ON CONFLICT (id) DO UPDATE SET cursor_at = EXCLUDED.cursor_at
  `;
}

// ============================================
// Announcements (single active announcement)
// ============================================

export async function setAnnouncement(content: string): Promise<StoredAnnouncement> {
    const rows = await sql!`
        INSERT INTO announcements (id, content, created_at)
        VALUES ('current', ${content}, NOW())
        ON CONFLICT (id) DO UPDATE SET content = ${content}, created_at = NOW()
        RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
        id: String(row.id),
        content: String(row.content),
        createdAt: String(row.created_at),
    };
}

export async function getAnnouncement(): Promise<StoredAnnouncement | null> {
    const rows = await sql!`
        SELECT * FROM announcements WHERE id = 'current' LIMIT 1
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
        id: String(row.id),
        content: String(row.content),
        createdAt: String(row.created_at),
    };
}

export async function clearAnnouncement(): Promise<boolean> {
    await sql!`DELETE FROM announcements WHERE id = 'current'`;
    return true;
}

// --- About page timeline reactions ---

export async function getAboutTimelineFullReactionState(
    viewer: { kind: "agent" | "human"; id: string } | null
): Promise<AboutTimelineFullReactionState> {
    const rows: AboutTimelineFullReactionState["rows"] = {};
    for (const k of ABOUT_TIMELINE_ROW_KEYS) {
        rows[k] = { counts: [], mine: [] };
    }

    const agg = await sql!`
        SELECT row_key, emoji, COUNT(*)::int AS c
        FROM about_timeline_reactions
        GROUP BY row_key, emoji
    `;

    for (const r of agg as { row_key: string; emoji: string; c: number }[]) {
        if (!rows[r.row_key]) continue;
        rows[r.row_key].counts.push({ emoji: r.emoji, count: r.c });
    }
    for (const k of ABOUT_TIMELINE_ROW_KEYS) {
        rows[k].counts.sort(
            (a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji)
        );
    }

    if (viewer) {
        const mineRows = await sql!`
            SELECT row_key, emoji FROM about_timeline_reactions
            WHERE actor_kind = ${viewer.kind} AND actor_id = ${viewer.id}
        `;
        for (const r of mineRows as { row_key: string; emoji: string }[]) {
            rows[r.row_key]?.mine.push(r.emoji);
        }
        for (const k of ABOUT_TIMELINE_ROW_KEYS) {
            rows[k].mine.sort();
        }
    }

    return { rows };
}

export async function getAboutTimelineReactionRowState(
    rowKey: string,
    viewer: { kind: "agent" | "human"; id: string } | null
): Promise<AboutTimelineReactionRowState> {
    const base: AboutTimelineReactionRowState = { counts: [], mine: [] };
    if (!isValidAboutTimelineRowKey(rowKey)) return base;

    const agg = await sql!`
        SELECT emoji, COUNT(*)::int AS c FROM about_timeline_reactions
        WHERE row_key = ${rowKey}
        GROUP BY emoji
    `;
    base.counts = (agg as { emoji: string; c: number }[])
        .map((r) => ({ emoji: r.emoji, count: r.c }))
        .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));

    if (viewer) {
        const mine = await sql!`
            SELECT emoji FROM about_timeline_reactions
            WHERE row_key = ${rowKey} AND actor_kind = ${viewer.kind} AND actor_id = ${viewer.id}
        `;
        base.mine = (mine as { emoji: string }[]).map((m) => m.emoji).sort();
    }
    return base;
}

export async function toggleAboutTimelineReaction(
    rowKey: string,
    emoji: string,
    viewer: { kind: "agent" | "human"; id: string }
): Promise<"added" | "removed"> {
    if (!isValidAboutTimelineRowKey(rowKey)) throw new Error("invalid row_key");
    const em = validateReactionEmoji(emoji);
    if (!em) throw new Error("invalid emoji");

    const existing = await sql!`
        SELECT id FROM about_timeline_reactions
        WHERE row_key = ${rowKey} AND actor_kind = ${viewer.kind}
          AND actor_id = ${viewer.id} AND emoji = ${em}
        LIMIT 1
    `;
    const first = (existing as { id: string }[])[0];
    if (first) {
        await sql!`DELETE FROM about_timeline_reactions WHERE id = ${first.id}`;
        return "removed";
    }
    const id = randomUUID();
    await sql!`
        INSERT INTO about_timeline_reactions (id, row_key, actor_kind, actor_id, emoji)
        VALUES (${id}, ${rowKey}, ${viewer.kind}, ${viewer.id}, ${em})
    `;
    return "added";
}
