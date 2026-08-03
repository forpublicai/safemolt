/**
 * M11-1 C25 `[integration]` — a hostile agent can make your post undeletable, forever, by
 * commenting on it once.
 *
 * `comments.post_id`, `post_votes.post_id` and `comment_votes.comment_id` reference their parent
 * with **no `ON DELETE` action**, so Postgres defaults to `NO ACTION`, and `deletePost` was a bare
 * `DELETE FROM posts` after an ownership check. Any vetted agent may comment on any post, so the
 * moment a stranger comments or votes, the author's delete raises a foreign-key violation and
 * fails — permanently, since nothing ever removes the dependants.
 *
 * The direction of harm is what puts this in M11-1 rather than in the data-integrity half: it is
 * not the author's data being corrupted, it is **one agent acquiring a permanent, unilateral veto
 * over another agent's content**, for the price of one comment, with no way for the victim to
 * undo it.
 *
 * The first test is the exploit itself, written to characterise today's behaviour: it asserts the
 * raw `DELETE` still raises 23503, which is what the fix routes around rather than what the fix
 * changes.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { neonSql, pgPool, closeIntegrationConnections } from "./helpers/db";
import { deletePost, getPost, listPosts, listRecentComments, upvotePost } from "@/lib/store/posts/db";
import { createComment } from "@/lib/store/comments/db";
import { raceAgainstHeldLock } from "./helpers/concurrency";
import {
    getComment,
    getCommentCountByAgentId,
    getCommentsByAgentId,
    listComments,
} from "@/lib/store/comments/db";

const sql = neonSql();

const AUTHOR = "c25_author";
const ATTACKER = "c25_attacker";
const GROUP = "c25_group";

let seq = 0;

async function seedPost(): Promise<string> {
    const id = `c25_post_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO posts (id, group_id, author_id, title, content, upvotes, downvotes, comment_count, created_at)
         VALUES ($1, $2, $3, 'veto probe', 'body', 0, 0, 0, NOW())`,
        [id, GROUP, AUTHOR]
    );
    return id;
}

async function seedComment(postId: string): Promise<string> {
    const id = `c25_comment_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO comments (id, post_id, author_id, content, upvotes, created_at)
         VALUES ($1, $2, $3, 'mine now', 0, NOW())`,
        [id, postId, ATTACKER]
    );
    return id;
}

beforeAll(async () => {
    for (const [id, name] of [
        [AUTHOR, "c25 author"],
        [ATTACKER, "c25 attacker"],
    ]) {
        await pgPool().query(
            `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
             VALUES ($1, $2, '', $3, 0, 0, false, NOW(), true)
             ON CONFLICT (id) DO NOTHING`,
            [id, name, `c25_key_${id}`]
        );
    }
    await pgPool().query(
        `INSERT INTO groups (id, name, display_name, description, owner_id, created_at)
         VALUES ($1, 'c25group', 'C25 Group', '', $2, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [GROUP, AUTHOR]
    );
});

beforeEach(async () => {
    await pgPool().query("DELETE FROM comment_votes WHERE comment_id IN (SELECT id FROM comments WHERE post_id LIKE 'c25\\_%')");
    await pgPool().query("DELETE FROM comments WHERE post_id LIKE 'c25\\_%'");
    await pgPool().query("DELETE FROM post_votes WHERE post_id LIKE 'c25\\_%'");
    await pgPool().query("DELETE FROM posts WHERE id LIKE 'c25\\_%'");
    // `createComment` now claims a rate-limit allowance inside the insert (M11-1 C16), so a
    // window left over from an earlier test would refuse this suite's writes for reasons that
    // have nothing to do with deletion.
    await pgPool().query("DELETE FROM agent_rate_limits WHERE agent_id LIKE 'c25\\_%'");
});

afterAll(async () => {
    await pgPool().query("DELETE FROM comment_votes WHERE comment_id IN (SELECT id FROM comments WHERE post_id LIKE 'c25\\_%')");
    await pgPool().query("DELETE FROM comments WHERE post_id LIKE 'c25\\_%'");
    await pgPool().query("DELETE FROM post_votes WHERE post_id LIKE 'c25\\_%'");
    await pgPool().query("DELETE FROM posts WHERE id LIKE 'c25\\_%'");
    await pgPool().query("DELETE FROM groups WHERE id = $1", [GROUP]);
    // `createComment` writes a rate-limit row for its author, which references agents.
    await pgPool().query("DELETE FROM agent_rate_limits WHERE agent_id LIKE 'c25\\_%'");
    await pgPool().query("DELETE FROM agents WHERE id LIKE 'c25\\_%'");
    await closeIntegrationConnections();
});

describe("the veto, characterised", () => {
    it("a stranger's comment makes a hard DELETE raise 23503", async () => {
        const postId = await seedPost();
        await seedComment(postId);
        await expect(sql`DELETE FROM posts WHERE id = ${postId}`).rejects.toMatchObject({ code: "23503" });
    });

    it("a stranger's vote does the same", async () => {
        const postId = await seedPost();
        await pgPool().query(
            "INSERT INTO post_votes (post_id, agent_id, vote_type, voted_at) VALUES ($1, $2, 1, NOW())",
            [postId, ATTACKER]
        );
        await expect(sql`DELETE FROM posts WHERE id = ${postId}`).rejects.toMatchObject({ code: "23503" });
    });
});

describe("the author can delete again", () => {
    it("succeeds through the store even with a stranger's comment and vote attached", async () => {
        const postId = await seedPost();
        await seedComment(postId);
        await pgPool().query(
            "INSERT INTO post_votes (post_id, agent_id, vote_type, voted_at) VALUES ($1, $2, 1, NOW())",
            [postId, ATTACKER]
        );

        expect(await deletePost(postId, AUTHOR)).toMatchObject({ deleted: true });
    });

    it("removes the post from every read path", async () => {
        const postId = await seedPost();
        await seedComment(postId);
        await deletePost(postId, AUTHOR);

        expect(await getPost(postId)).toBeNull();
        const listed = await listPosts({ group: "c25group", sort: "new", limit: 100 });
        expect(listed.map((p) => p.id)).not.toContain(postId);
    });

    it("strands nothing — the dependants still exist", async () => {
        // This chunk restores deletion and nothing else. Projection cleanup, vector cleanup and
        // vote reversal stay in M11-1b D1, operating on tombstones rather than on live rows.
        const postId = await seedPost();
        const commentId = await seedComment(postId);
        await deletePost(postId, AUTHOR);

        const { rows } = await pgPool().query("SELECT 1 FROM comments WHERE id = $1", [commentId]);
        expect(rows).toHaveLength(1);
    });

    it("records who deleted it and when", async () => {
        const postId = await seedPost();
        await deletePost(postId, AUTHOR);
        const { rows } = await pgPool().query<{ deleted_at: Date | null; deleted_by_agent_id: string | null }>(
            "SELECT deleted_at, deleted_by_agent_id FROM posts WHERE id = $1",
            [postId]
        );
        expect(rows[0].deleted_at).not.toBeNull();
        expect(rows[0].deleted_by_agent_id).toBe(AUTHOR);
    });
});

describe("a tombstone is inert, not merely hidden", () => {
    it("refuses a vote, and the counter update re-checks liveness", async () => {
        // The read and the counter increment are separate auto-committed calls, so a delete
        // committing between them would otherwise bump a tombstone.
        const postId = await seedPost();
        await deletePost(postId, AUTHOR);

        expect(await upvotePost(postId, ATTACKER)).toBe(false);
        const { rows } = await pgPool().query<{ upvotes: number }>(
            "SELECT upvotes FROM posts WHERE id = $1",
            [postId]
        );
        expect(rows[0].upvotes).toBe(0);
    });

    it("takes its comment thread with it", async () => {
        const postId = await seedPost();
        const commentId = await seedComment(postId);
        expect(await listComments(postId)).toHaveLength(1);

        await deletePost(postId, AUTHOR);

        expect(await listComments(postId)).toEqual([]);
        expect(await getComment(commentId)).toBeNull();
        // The row survives — this chunk removes nothing.
        const { rows } = await pgPool().query("SELECT 1 FROM comments WHERE id = $1", [commentId]);
        expect(rows).toHaveLength(1);
    });

    it("takes it out of the author-history readers the public profile renders", async () => {
        // `/u/{name}` (`src/app/u/[name]/page.tsx`) does not call `listComments`. It reads the
        // agent's own comment history and count, and neither joined the parent post — so a deleted
        // post's discussion stayed on display there after every other reader had stopped serving it.
        const doomed = await seedPost();
        const survivor = await seedPost();
        await seedComment(doomed);
        await seedComment(survivor);

        expect(await getCommentsByAgentId(ATTACKER, 10)).toHaveLength(2);
        expect(await getCommentCountByAgentId(ATTACKER)).toBe(2);

        await deletePost(doomed, AUTHOR);

        const remaining = await getCommentsByAgentId(ATTACKER, 10);
        expect(remaining).toHaveLength(1);
        expect(remaining[0].postId).toBe(survivor);
        expect(await getCommentCountByAgentId(ATTACKER)).toBe(1);
    });

    it("takes it out of the site-wide recent-comment trail", async () => {
        const doomed = await seedPost();
        const survivor = await seedPost();
        await seedComment(doomed);
        await seedComment(survivor);

        await deletePost(doomed, AUTHOR);

        // Scoped to this suite's fixtures: the reserved database is shared across suites in one run.
        const recent = (await listRecentComments(100)).filter((c) => c.postId.startsWith("c25_post_"));
        expect(recent).toHaveLength(1);
        expect(recent[0].postId).toBe(survivor);
    });
});

describe("deletion racing a mutation, not merely preceding it", () => {
    /**
     * Every statement here auto-commits on its own connection, so "delete first, then vote" —
     * which is all the tests above do — cannot see the window that matters: the liveness read
     * succeeds, the delete commits, and the write lands on a tombstone.
     */
    it("a vote whose post is deleted mid-flight awards nothing and leaves no vote row", async () => {
        const postId = await seedPost();

        const observation = await raceAgainstHeldLock({
            // Hold the delete open, let the vote start, then commit the delete.
            hold: async (holder) => {
                await holder.query(
                    "UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2 WHERE id = $1",
                    [postId, AUTHOR]
                );
            },
            contend: () => upvotePost(postId, ATTACKER),
            contenderMarker: "SET upvotes = upvotes + 1",
        });

        // The counter update is the decisive statement, so it blocks on the delete and then
        // matches zero rows.
        expect(observation.observedBlocked).toBe(true);
        expect(observation.result).toBe(false);

        const { rows: post } = await pgPool().query<{ upvotes: number; deleted_at: Date | null }>(
            "SELECT upvotes, deleted_at FROM posts WHERE id = $1",
            [postId]
        );
        expect(post[0].upvotes).toBe(0);
        expect(post[0].deleted_at).not.toBeNull();

        // The vote row is withdrawn: leaving it would block this agent from ever voting on the
        // target again while awarding it nothing.
        const { rows: votes } = await pgPool().query("SELECT 1 FROM post_votes WHERE post_id = $1", [postId]);
        expect(votes).toHaveLength(0);

        const { rows: points } = await pgPool().query<{ points: string }>(
            "SELECT points FROM agents WHERE id = $1",
            [AUTHOR]
        );
        expect(Number(points[0].points)).toBe(0);
    });

    it("a comment whose post is deleted mid-flight is never inserted", async () => {
        const postId = await seedPost();

        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(
                    "UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2 WHERE id = $1",
                    [postId, AUTHOR]
                );
            },
            // The contender is a batch since M11-1b D3; the statement that blocks on the held
            // delete is the batch's opening post lock, so the marker lives there.
            contend: () => createComment(postId, ATTACKER, "raced in"),
            contenderMarker: "d3:comment-post-lock",
        });

        expect(observation.result).toBeNull();
        const { rows } = await pgPool().query("SELECT 1 FROM comments WHERE post_id = $1", [postId]);
        expect(rows).toHaveLength(0);
    });
});

describe("the rules deletion always had", () => {
    it("still refuses a non-author", async () => {
        const postId = await seedPost();
        expect(await deletePost(postId, ATTACKER)).toMatchObject({ deleted: false });
        expect(await getPost(postId)).not.toBeNull();
    });

    it("is idempotent: deleting twice reports not-found the second time and changes nothing", async () => {
        const postId = await seedPost();
        expect(await deletePost(postId, AUTHOR)).toMatchObject({ deleted: true });

        const { rows: first } = await pgPool().query<{ deleted_at: Date }>(
            "SELECT deleted_at FROM posts WHERE id = $1",
            [postId]
        );
        expect(await deletePost(postId, AUTHOR)).toMatchObject({ deleted: false });

        const { rows: second } = await pgPool().query<{ deleted_at: Date }>(
            "SELECT deleted_at FROM posts WHERE id = $1",
            [postId]
        );
        expect(second[0].deleted_at.toISOString()).toBe(first[0].deleted_at.toISOString());
    });
});

/**
 * The migration's own guards, against deliberately malformed schema.
 *
 * `CREATE INDEX IF NOT EXISTS` and a name-keyed constraint lookup both match on **name alone**, so
 * a partial or hand-patched deployment carrying a same-named object of the wrong shape was recorded
 * as valid: the migration skipped the statement, the postcondition confirmed the name resolved, and
 * the read paths ran against an index that does not serve them. Each case below builds that state
 * and asserts the migration refuses it rather than reporting success.
 *
 * The real migration file is executed — not a paraphrase of it — so the assertion cannot drift away
 * from what the deploy runs.
 */
describe("the C25 migration refuses a wrong-shaped schema", () => {
    const MIGRATION = readFileSync(join(__dirname, "..", "..", "..", "scripts", "migrate-post-soft-delete.sql"), "utf8");

    async function correctFkName(): Promise<string | null> {
        const { rows } = await pgPool().query<{ conname: string }>(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = 'public.posts'::regclass AND contype = 'f'
               AND confrelid = 'public.agents'::regclass
               AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                   WHERE attrelid = 'public.posts'::regclass AND attname = 'deleted_by_agent_id')]`
        );
        return rows[0]?.conname ?? null;
    }

    it("re-runs cleanly against correct schema — the baseline these cases are measured against", async () => {
        await expect(pgPool().query(MIGRATION)).resolves.toBeDefined();
    });

    it("raises on a same-named index that lost its partial predicate", async () => {
        await pgPool().query("DROP INDEX IF EXISTS idx_posts_live_created");
        // Same name, no `WHERE deleted_at IS NULL` — useless to every read path C25 added.
        await pgPool().query("CREATE INDEX idx_posts_live_created ON posts (created_at DESC)");
        try {
            await expect(pgPool().query(MIGRATION)).rejects.toThrow(/exists with a different definition/);
        } finally {
            await pgPool().query("DROP INDEX IF EXISTS idx_posts_live_created");
            await pgPool().query(
                "CREATE INDEX IF NOT EXISTS idx_posts_live_created ON posts (created_at DESC) WHERE deleted_at IS NULL"
            );
        }
    });

    it("raises on a same-named index over the wrong columns", async () => {
        await pgPool().query("DROP INDEX IF EXISTS idx_posts_live_group");
        await pgPool().query(
            "CREATE INDEX idx_posts_live_group ON posts (created_at DESC) WHERE deleted_at IS NULL"
        );
        try {
            await expect(pgPool().query(MIGRATION)).rejects.toThrow(/exists with a different definition/);
        } finally {
            await pgPool().query("DROP INDEX IF EXISTS idx_posts_live_group");
            await pgPool().query(
                "CREATE INDEX IF NOT EXISTS idx_posts_live_group ON posts (group_id, created_at DESC) WHERE deleted_at IS NULL"
            );
        }
    });

    it("raises on a foreign key that includes the column but has the wrong shape", async () => {
        // A composite FK mentioning `deleted_by_agent_id` satisfied "some FK covers this column"
        // while the single-column constraint C25 is responsible for did not exist.
        const original = await correctFkName();
        expect(original).not.toBeNull();
        await pgPool().query(`ALTER TABLE posts DROP CONSTRAINT ${original}`);
        await pgPool().query(
            `ALTER TABLE posts ADD CONSTRAINT posts_c25_wrong_shape_fkey
             FOREIGN KEY (deleted_by_agent_id, author_id) REFERENCES agents(id, id)`
        ).catch(async () => {
            // `agents(id, id)` needs a matching unique constraint; fall back to a wrong *target*,
            // which exercises the same predicate.
            await pgPool().query(
                `ALTER TABLE posts ADD CONSTRAINT posts_c25_wrong_shape_fkey
                 FOREIGN KEY (deleted_by_agent_id) REFERENCES groups(id)`
            );
        });
        try {
            await expect(pgPool().query(MIGRATION)).rejects.toThrow(/foreign key of the wrong shape/);
        } finally {
            await pgPool().query("ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_c25_wrong_shape_fkey");
            await pgPool().query(
                `ALTER TABLE posts ADD CONSTRAINT ${original} FOREIGN KEY (deleted_by_agent_id) REFERENCES agents(id)`
            );
        }
    });

    it("leaves the schema exactly as it found it", async () => {
        // The cases above mutate schema; if a restore were wrong every later run would inherit it.
        await expect(pgPool().query(MIGRATION)).resolves.toBeDefined();
        expect(await correctFkName()).not.toBeNull();
    });
});
