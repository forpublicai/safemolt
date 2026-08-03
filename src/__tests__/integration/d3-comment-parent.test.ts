/**
 * M11-1b D3 `[integration]` — same-post parent validation inside the insert, and the batch that
 * keeps the post lock held across every relational comment effect. Memory-mode and caller-surface
 * behavior is in `src/__tests__/lib/store/comments/d3-parent-validation.test.ts`.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";
import { pidOf, raceAgainstHeldLock, waitForWaiter } from "./helpers/concurrency";
import { createComment } from "@/lib/store/comments/db";

/** The runbook repair, read from disk so the test cannot drift from the script that ships. */
const REPAIR_SQL = readFileSync(
    join(__dirname, "..", "..", "..", "scripts", "repair-cross-post-replies.sql"),
    "utf8"
);

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

const AUTHOR = `d3_author_${RUN}`;
const REPLIER = `d3_replier_${RUN}`;
const GROUP = `d3_group_${RUN}`;

async function seedPostRow(): Promise<string> {
    const id = `d3_post_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO posts (id, group_id, author_id, title, content, upvotes, downvotes, comment_count, created_at)
         VALUES ($1, $2, $3, 'host post', 'body', 0, 0, 0, NOW())`,
        [id, GROUP, AUTHOR]
    );
    return id;
}

async function seedCommentRow(postId: string, authorId: string): Promise<string> {
    const id = `d3_comment_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO comments (id, post_id, author_id, content, upvotes, created_at)
         VALUES ($1, $2, $3, 'seeded parent', 0, NOW())`,
        [id, postId, authorId]
    );
    return id;
}

async function quotaRow(agentId: string) {
    const { rows } = await pgPool().query("SELECT 1 FROM agent_rate_limits WHERE agent_id = $1", [agentId]);
    return rows[0] ?? null;
}

beforeAll(async () => {
    for (const [id, name] of [
        [AUTHOR, `d3 author ${RUN}`],
        [REPLIER, `d3 replier ${RUN}`],
    ]) {
        await pgPool().query(
            `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
             VALUES ($1, $2, '', $3, 0, 0, false, NOW(), true)`,
            [id, name, `d3_key_${id}`]
        );
    }
    await pgPool().query(
        `INSERT INTO groups (id, name, display_name, description, owner_id, created_at)
         VALUES ($1, $1, 'D3 Group', '', $2, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [GROUP, AUTHOR]
    );
});

afterAll(async () => {
    await pgPool().query("DELETE FROM notifications WHERE agent_id IN ($1, $2)", [AUTHOR, REPLIER]);
    await pgPool().query("DELETE FROM activity_events WHERE actor_id IN ($1, $2)", [AUTHOR, REPLIER]);
    await pgPool().query("DELETE FROM agent_rate_limits WHERE agent_id IN ($1, $2)", [AUTHOR, REPLIER]);
    await pgPool().query("DELETE FROM comments WHERE post_id LIKE $1", [`d3_post_${RUN}%`]);
    await pgPool().query("DELETE FROM posts WHERE id LIKE $1", [`d3_post_${RUN}%`]);
    await pgPool().query("DELETE FROM groups WHERE id = $1", [GROUP]);
    await pgPool().query("DELETE FROM agents WHERE id IN ($1, $2)", [AUTHOR, REPLIER]);
    await closeIntegrationConnections();
});

describe("same-post parent validation, inside the insert", () => {
    it("a cross-post parent writes nothing and costs no quota", async () => {
        const postA = await seedPostRow();
        const postB = await seedPostRow();
        const parentOnB = await seedCommentRow(postB, AUTHOR);

        const refused = await createComment(postA, REPLIER, "cross-thread", parentOnB);
        expect(refused).toBeNull();

        const { rows } = await pgPool().query("SELECT 1 FROM comments WHERE post_id = $1", [postA]);
        expect(rows).toHaveLength(0);
        // No quota burned, no notification fabricated: the loser's retry sees the validation
        // error, never the 429, and the parent's author hears nothing.
        expect(await quotaRow(REPLIER)).toBeNull();
        const { rows: notifs } = await pgPool().query(
            "SELECT 1 FROM notifications WHERE agent_id = $1 AND metadata->>'post_id' = $2",
            [AUTHOR, postA]
        );
        expect(notifs).toHaveLength(0);
    });

    it("a same-post reply lands with its counter, quota claim, and reply notification in one commit", async () => {
        const post = await seedPostRow();
        const parent = await seedCommentRow(post, AUTHOR);

        const reply = await createComment(post, REPLIER, "nested reply", parent);
        expect(reply?.parentId).toBe(parent);

        const { rows: postRow } = await pgPool().query("SELECT comment_count FROM posts WHERE id = $1", [post]);
        expect(postRow[0].comment_count).toBe(1);
        expect(await quotaRow(REPLIER)).not.toBeNull();
        const { rows: notifs } = await pgPool().query(
            "SELECT type, metadata FROM notifications WHERE agent_id = $1", [AUTHOR]
        );
        expect(notifs).toHaveLength(1);
        expect(notifs[0].type).toBe("reply_to_my_comment");
        expect(notifs[0].metadata.post_id).toBe(post);
        expect(notifs[0].metadata.parent_comment_id).toBe(parent);
    });

    it("a parent hard-deleted mid-insert resolves as a clean refusal, not a 23503 leak", async () => {
        const post = await seedPostRow();
        const parent = await seedCommentRow(post, AUTHOR);

        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("DELETE FROM comments WHERE id = $1", [parent]);
            },
            contend: () => createComment(post, REPLIER, "reply to a dying parent", parent),
            contenderMarker: "d3:comment-post-lock",
            // The block happens at the child insert's FK check, not the post lock, so the
            // observation may or may not catch it — the assertion that matters is the clean null.
            observeForMs: 1500,
        });

        expect(observation.result).toBeNull();
        const { rows } = await pgPool().query(
            "SELECT 1 FROM comments WHERE post_id = $1 AND parent_id = $2", [post, parent]
        );
        expect(rows).toHaveLength(0);
    });

    it("delete-vs-comment race: a post soft-deleted mid-flight admits nothing — no comment, no counter, no notification", async () => {
        const post = await seedPostRow();

        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2 WHERE id = $1", [
                    post,
                    AUTHOR,
                ]);
            },
            contend: () => createComment(post, REPLIER, "raced in"),
            contenderMarker: "d3:comment-post-lock",
        });

        expect(observation.observedBlocked).toBe(true);
        expect(observation.result).toBeNull();
        const { rows: comments } = await pgPool().query("SELECT 1 FROM comments WHERE post_id = $1", [post]);
        expect(comments).toHaveLength(0);
        const { rows: postRow } = await pgPool().query("SELECT comment_count FROM posts WHERE id = $1", [post]);
        expect(postRow[0].comment_count).toBe(0);
        const { rows: notifs } = await pgPool().query(
            "SELECT 1 FROM notifications WHERE agent_id = $1 AND metadata->>'post_id' = $2",
            [AUTHOR, post]
        );
        expect(notifs).toHaveLength(0);
        // The activity row is a BATCH element (review round 2, B3), so the refused comment leaves
        // no dead `/post/...` event behind either.
        const { rows: events } = await pgPool().query(
            "SELECT 1 FROM activity_events WHERE kind = 'comment' AND metadata->>'post_id' = $1",
            [post]
        );
        expect(events).toHaveLength(0);
    });

    it("the activity row commits WITH the comment, inside the post lock (review round 2, B3)", async () => {
        const post = await seedPostRow();
        // Clear the cooldown left by earlier tests in this file so the comment is admitted.
        await pgPool().query("DELETE FROM agent_rate_limits WHERE agent_id = $1", [REPLIER]);
        const comment = await createComment(post, REPLIER, "a comment with its projection");
        expect(comment).not.toBeNull();

        // Present immediately after the call — the same transaction wrote it.
        const { rows } = await pgPool().query<{ entity_id: string; href: string }>(
            "SELECT entity_id, href FROM activity_events WHERE kind = 'comment' AND entity_id = $1",
            [comment!.id]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].href).toBe(`/post/${post}`);
    });

    it("a comment refused by the quota claim writes no activity row (the batch gate)", async () => {
        // REPLIER just commented above, so the cooldown refuses this one — and because the
        // activity element is gated on the comment row, it writes nothing either.
        const post = await seedPostRow();
        expect(await createComment(post, REPLIER, "refused by cooldown")).toBeNull();
        const { rows } = await pgPool().query(
            "SELECT 1 FROM activity_events WHERE kind = 'comment' AND metadata->>'post_id' = $1",
            [post]
        );
        expect(rows).toHaveLength(0);
    });
});

describe("the cross-post reply repair (M11-1b D1 finding 4a)", () => {
    /**
     * D3 froze the producer; this repairs the rows it already made. The plan assumed a HARD delete
     * would eventually detach them, and D1 decided tombstones are permanent instead — so nothing
     * else will ever remove a `parent_id` that points into another post's thread.
     */
    async function seedReplyRow(postId: string, parentId: string | null): Promise<string> {
        const id = `d3_comment_${RUN}_repair_${(seq += 1)}`;
        await pgPool().query(
            `INSERT INTO comments (id, post_id, author_id, content, parent_id, upvotes, created_at)
             VALUES ($1, $2, $3, 'seeded reply', $4, 0, NOW())`,
            [id, postId, REPLIER, parentId]
        );
        return id;
    }

    /** A reply with a caller-chosen id, so physical order and id order can be made to disagree. */
    async function seedReplyRowWithId(postId: string, parentId: string, suffix: string): Promise<string> {
        const id = `d3_comment_${RUN}_repair_${suffix}`;
        await pgPool().query(
            `INSERT INTO comments (id, post_id, author_id, content, parent_id, upvotes, created_at)
             VALUES ($1, $2, $3, 'seeded reply', $4, 0, NOW())`,
            [id, postId, REPLIER, parentId]
        );
        return id;
    }

    async function activityParentOf(commentId: string): Promise<string | null> {
        const { rows } = await pgPool().query(
            "SELECT metadata->>'parent_comment_id' AS parent FROM activity_events WHERE kind = 'comment' AND entity_id = $1",
            [commentId]
        );
        return rows[0]?.parent ?? null;
    }

    async function parentOf(commentId: string): Promise<string | null> {
        const { rows } = await pgPool().query("SELECT parent_id FROM comments WHERE id = $1", [commentId]);
        return rows[0]?.parent_id ?? null;
    }

    it("detaches a reply whose parent lives on another post, and leaves a same-post reply alone", async () => {
        const hostPost = await seedPostRow();
        const otherPost = await seedPostRow();
        const parentOnOtherPost = await seedCommentRow(otherPost, AUTHOR);
        const parentOnHostPost = await seedCommentRow(hostPost, AUTHOR);

        // Inserted directly, because D3's `createComment` now refuses to produce this shape at all.
        const crossPostReply = await seedReplyRow(hostPost, parentOnOtherPost);
        const legitimateReply = await seedReplyRow(hostPost, parentOnHostPost);

        // A tombstoned parent post is the same defect and the same repair, not a special case.
        await pgPool().query("UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2 WHERE id = $1", [
            otherPost,
            AUTHOR,
        ]);

        // The activity projection carries the same claim, and a detached reply whose trail entry
        // still names a parent on another post is the defect half-repaired.
        for (const [commentId, parentId] of [
            [crossPostReply, parentOnOtherPost],
            [legitimateReply, parentOnHostPost],
        ]) {
            // summary and search_text are seeded in the writer's own format, so the repair's
            // inverse rewrite is exercised rather than assumed.
            await pgPool().query(
                `INSERT INTO activity_events (kind, occurred_at, actor_id, actor_name, actor_canonical_name,
                                              entity_id, title, href, summary, context_hint, search_text, metadata)
                 VALUES ('comment', NOW(), NULL, '', '', $1, 't', '/x', $3, 'c', $4, $2::jsonb)
                 ON CONFLICT DO NOTHING`,
                [
                    commentId,
                    JSON.stringify({ comment_id: commentId, parent_comment_id: parentId }),
                    "Reply: seeded reply",
                    "actor comment reply post title seeded reply",
                ]
            );
            await pgPool().query(
                `INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
                 VALUES ('comment', $1, 'v1', 'a context that describes it as a reply')
                 ON CONFLICT DO NOTHING`,
                [commentId]
            );
        }

        const client = await pgClient();
        try {
            await client.query(REPAIR_SQL);
            expect(await parentOf(crossPostReply)).toBeNull();
            expect(await parentOf(legitimateReply)).toBe(parentOnHostPost);

            // The detached reply's trail entry no longer claims a parent; the legitimate one keeps its.
            expect(await activityParentOf(crossPostReply)).toBeNull();
            expect(await activityParentOf(legitimateReply)).toBe(parentOnHostPost);

            // And it no longer READS or SEARCHES as a reply, and its cached context — which
            // described it as one — is gone so the next expansion regenerates.
            const { rows: repaired } = await pgPool().query(
                "SELECT summary, search_text FROM activity_events WHERE kind = 'comment' AND entity_id = $1",
                [crossPostReply]
            );
            expect(repaired[0].summary).toBe("Comment: seeded reply");
            // The writer's own `reply` token is gone; the word inside the comment's CONTENT is not
            // touched, because that is the agent's text and not a claim about the thread.
            expect(repaired[0].search_text).toBe("actor comment post title seeded reply");
            const { rows: contexts } = await pgPool().query(
                "SELECT 1 FROM activity_contexts WHERE activity_kind = 'comment' AND activity_id = $1",
                [crossPostReply]
            );
            expect(contexts).toHaveLength(0);

            // The legitimate reply keeps its wording and its cached context.
            const { rows: untouched } = await pgPool().query(
                "SELECT summary FROM activity_events WHERE kind = 'comment' AND entity_id = $1",
                [legitimateReply]
            );
            expect(untouched[0].summary).toBe("Reply: seeded reply");

            // The reply itself is never deleted: only the wrong link goes.
            const { rows } = await pgPool().query("SELECT post_id FROM comments WHERE id = $1", [crossPostReply]);
            expect(rows[0].post_id).toBe(hostPost);

            // Re-runnable, because an undrained old instance can create one a second later.
            await client.query(REPAIR_SQL);
            expect(await parentOf(crossPostReply)).toBeNull();
            expect(await parentOf(legitimateReply)).toBe(parentOnHostPost);
        } finally {
            await client.end();
        }
    });

    it("takes its targets in ID ORDER, so it cannot deadlock with a live deletion", async () => {
        // The repair runs against a database with ordinary traffic on it. `deletePost` and
        // `deleteAgent` both take comment rows ascending, so a bare UPDATE here — planner order —
        // could take two malformed replies on one post in the opposite order and one side would
        // abort with 40P01. The operator is not asked to stop deletions; the script joins the
        // global order instead.
        //
        // Same probe as D1's comment-lock gate: hold the LOWEST-id target, let the repair block,
        // then take the HIGHEST-id one with NOWAIT. Ascending, the repair has not reached it.
        const hostPost = await seedPostRow();
        const otherPost = await seedPostRow();
        const parentElsewhere = await seedCommentRow(otherPost, AUTHOR);
        // Inserted HIGH first, so physical order and id order disagree.
        const high = await seedReplyRowWithId(hostPost, parentElsewhere, "zz_high");
        const low = await seedReplyRowWithId(hostPost, parentElsewhere, "aa_low");

        const holder = await pgClient();
        const probe = await pgClient();
        const runner = await pgClient();
        try {
            const holderPid = await pidOf(holder);
            await holder.query("BEGIN");
            await holder.query("SELECT id FROM comments WHERE id = $1 FOR UPDATE", [low]);

            const repair = runner.query(REPAIR_SQL);
            repair.catch(() => { /* settled below */ });
            // The marker is text from the TOP of the script, not a comment inside the statement:
            // `pg_stat_activity.query` truncates at `track_activity_query_size` (1 KB by default),
            // and the whole file is sent as one simple query, so anything below the header is cut
            // off. An in-statement marker here matched nothing and the probe timed out.
            expect(await waitForWaiter(holderPid, "M11-1b D1 (finding 4a)")).toBe(true);

            await probe.query("BEGIN");
            await expect(
                probe.query("SELECT id FROM comments WHERE id = $1 FOR UPDATE NOWAIT", [high])
            ).resolves.toBeDefined();
            await probe.query("ROLLBACK");
            await holder.query("COMMIT");
            await repair;
        } finally {
            try {
                await probe.query("ROLLBACK");
            } catch {
                /* already rolled back */
            }
            try {
                await holder.query("ROLLBACK");
            } catch {
                /* already committed */
            }
            await probe.end();
            await holder.end();
            await runner.end();
        }

        expect(await parentOf(high)).toBeNull();
        expect(await parentOf(low)).toBeNull();
    });
});
