/**
 * M11-1b D3 `[integration]` — same-post parent validation inside the insert, and the batch that
 * keeps the post lock held across every relational comment effect. Memory-mode and caller-surface
 * behavior is in `src/__tests__/lib/store/comments/d3-parent-validation.test.ts`.
 */
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { raceAgainstHeldLock } from "./helpers/concurrency";
import { createComment } from "@/lib/store/comments/db";

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
