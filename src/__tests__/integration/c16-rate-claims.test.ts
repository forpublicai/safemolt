/**
 * M11-1 C16 `[integration]` — the post cooldown, the comment cooldown and the daily comment cap
 * were all **advisory**: read unlocked by the caller, written unconditionally by the store, in
 * separate auto-committed statements. Concurrent requests read the same stale counter, all passed,
 * and all wrote. The unfollow decrement had the mirror-image defect — it fired whether or not the
 * delete removed anything, so an agent could walk a stranger's public follower count to zero.
 *
 * These gates need a real database: every claim here is about what two connections do to one row,
 * which a mocked `sql` cannot observe. The memory-mode equivalents are in
 * `src/__tests__/lib/store/rate-claims.test.ts`.
 */
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { raceAgainstHeldLock, runConcurrently } from "./helpers/concurrency";
import { createPost } from "@/lib/store/posts/db";
import { createComment } from "@/lib/store/comments/db";
import { followAgent, unfollowAgent } from "@/lib/store/agents/db";
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY, POST_COOLDOWN_MS } from "@/lib/store/rate-limit-windows";

const AUTHOR = "c16_author";
const STRANGER = "c16_stranger";
const TARGET = "c16_target";
const GROUP = "c16_group";

let seq = 0;

async function seedPostRow(): Promise<string> {
    const id = `c16_post_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO posts (id, group_id, author_id, title, content, upvotes, downvotes, comment_count, created_at)
         VALUES ($1, $2, $3, 'host post', 'body', 0, 0, 0, NOW())`,
        [id, GROUP, AUTHOR]
    );
    return id;
}

async function rateRow(agentId: string) {
    const { rows } = await pgPool().query<{
        last_post_at: string | null;
        last_comment_at: string | null;
        comment_count_date: Date | null;
        comment_count: number;
    }>("SELECT last_post_at, last_comment_at, comment_count_date, comment_count FROM agent_rate_limits WHERE agent_id = $1", [agentId]);
    return rows[0] ?? null;
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Counts by **group**, not by an id prefix: `createPost` mints its own `post_<ts>_<rand>` id, so a
 * `LIKE 'c16_%'` filter here would silently count zero of the rows the store actually wrote and
 * every "exactly one winner" assertion would pass for the wrong reason.
 */
async function countPostsBy(agentId: string): Promise<number> {
    const { rows } = await pgPool().query<{ c: string }>(
        "SELECT count(*) AS c FROM posts WHERE author_id = $1 AND group_id = $2",
        [agentId, GROUP]
    );
    return Number(rows[0].c);
}

beforeAll(async () => {
    for (const [id, name] of [
        [AUTHOR, "c16 author"],
        [STRANGER, "c16 stranger"],
        [TARGET, "c16 target"],
    ]) {
        await pgPool().query(
            `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
             VALUES ($1, $2, '', $3, 0, 0, false, NOW(), true)
             ON CONFLICT (id) DO NOTHING`,
            [id, name, `c16_key_${id}`]
        );
    }
    await pgPool().query(
        `INSERT INTO groups (id, name, display_name, description, owner_id, created_at)
         VALUES ($1, 'c16group', 'C16 Group', '', $2, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [GROUP, AUTHOR]
    );
});

beforeEach(async () => {
    await pgPool().query("DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE group_id = $1)", [GROUP]);
    await pgPool().query("DELETE FROM activity_events WHERE actor_id LIKE 'c16\\_%'");
    await pgPool().query("DELETE FROM notifications WHERE agent_id LIKE 'c16\\_%'");
    await pgPool().query("DELETE FROM posts WHERE group_id = $1", [GROUP]);
    await pgPool().query("DELETE FROM agent_rate_limits WHERE agent_id LIKE 'c16\\_%'");
    await pgPool().query("DELETE FROM following WHERE follower_id LIKE 'c16\\_%' OR followee_id LIKE 'c16\\_%'");
    await pgPool().query("UPDATE agents SET follower_count = 0 WHERE id LIKE 'c16\\_%'");
});

afterAll(async () => {
    await pgPool().query("DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE group_id = $1)", [GROUP]);
    await pgPool().query("DELETE FROM activity_events WHERE actor_id LIKE 'c16\\_%'");
    await pgPool().query("DELETE FROM notifications WHERE agent_id LIKE 'c16\\_%'");
    await pgPool().query("DELETE FROM posts WHERE group_id = $1", [GROUP]);
    await pgPool().query("DELETE FROM following WHERE follower_id LIKE 'c16\\_%' OR followee_id LIKE 'c16\\_%'");
    await pgPool().query("DELETE FROM agent_rate_limits WHERE agent_id LIKE 'c16\\_%'");
    await pgPool().query("DELETE FROM groups WHERE id = $1", [GROUP]);
    await pgPool().query("DELETE FROM agents WHERE id LIKE 'c16\\_%'");
    await closeIntegrationConnections();
});

describe("post cooldown", () => {
    it("admits exactly one of several concurrent posts from one agent", async () => {
        const outcomes = await runConcurrently(
            [1, 2, 3, 4].map((n) => () => createPost(AUTHOR, GROUP, `race ${n}`, "body"))
        );

        // No rejections: the loser's claim matches zero rows, so its insert selects from an empty
        // CTE. It is refused, not errored — a 23505 would mean the shape was wrong.
        expect(outcomes.every((o) => o.ok)).toBe(true);
        const created = outcomes.filter((o) => o.ok && o.value !== null);
        expect(created).toHaveLength(1);
        expect(await countPostsBy(AUTHOR)).toBe(1);
    });

    it("blocks on the winner's row and is refused once it commits", async () => {
        // The mechanism, not just the outcome. A concurrent claim must *wait* on the row the other
        // request is writing and then re-evaluate against the committed value — which is what
        // `ON CONFLICT DO UPDATE` does and what a check-then-write never did.
        await pgPool().query(
            `INSERT INTO agent_rate_limits (agent_id, last_post_at, comment_count_date, comment_count)
             VALUES ($1, $2, NULL, 0)`,
            [AUTHOR, Date.now() - POST_COOLDOWN_MS - 5_000]
        );

        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                // Stands in for a concurrent post by the same agent, mid-flight and uncommitted.
                await holder.query("UPDATE agent_rate_limits SET last_post_at = $2 WHERE agent_id = $1", [
                    AUTHOR,
                    Date.now(),
                ]);
            },
            contend: () => createPost(AUTHOR, GROUP, "raced in", "body"),
            // Specific enough to identify *this* statement. `"INSERT INTO agent_rate_limits"`
            // alone also matches `createComment`'s claim, so a concurrent suite could have
            // supplied the blocked backend this assertion rests on.
            contenderMarker: "INSERT INTO agent_rate_limits (agent_id, last_post_at, comment_count_date, comment_count)",
        });

        expect(observation.observedBlocked).toBe(true);
        expect(observation.result).toBeNull();
        expect(await countPostsBy(AUTHOR)).toBe(0);
    });

    it("admits the next post once the window has passed, and charges nothing for a refusal", async () => {
        expect(await createPost(AUTHOR, GROUP, "first", "body")).not.toBeNull();
        const afterFirst = (await rateRow(AUTHOR))!.last_post_at;

        expect(await createPost(AUTHOR, GROUP, "refused", "body")).toBeNull();
        // A refusal that re-stamped the window would extend the caller's own cooldown on every
        // retry — punishing retries rather than bounding the rate.
        expect((await rateRow(AUTHOR))!.last_post_at).toBe(afterFirst);

        await pgPool().query("UPDATE agent_rate_limits SET last_post_at = $2 WHERE agent_id = $1", [
            AUTHOR,
            Date.now() - POST_COOLDOWN_MS - 1,
        ]);
        expect(await createPost(AUTHOR, GROUP, "after the window", "body")).not.toBeNull();
        expect(await countPostsBy(AUTHOR)).toBe(2);
    });
});

describe("comment cooldown and daily cap", () => {
    it("admits exactly one of several concurrent comments — the cooldown is what binds", async () => {
        const postId = await seedPostRow();

        const outcomes = await runConcurrently(
            [1, 2, 3, 4, 5].map((n) => () => createComment(postId, STRANGER, `race ${n}`))
        );

        expect(outcomes.every((o) => o.ok)).toBe(true);
        expect(outcomes.filter((o) => o.ok && o.value !== null)).toHaveLength(1);
        expect((await rateRow(STRANGER))!.comment_count).toBe(1);
    });

    it("lands exactly on the daily cap when two requests race for the last slot", async () => {
        // The cap gate needs its own shape: preseed at cap - 1 with an expired cooldown so the cap
        // is the only thing left that can refuse. Before C16 both requests read `cap - 1`, both
        // wrote `cap`, and the agent got one comment past its limit.
        const postId = await seedPostRow();
        await pgPool().query(
            `INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
             VALUES ($1, $2, $3, $4)`,
            [STRANGER, Date.now() - COMMENT_COOLDOWN_MS - 1, today(), MAX_COMMENTS_PER_DAY - 1]
        );

        const outcomes = await runConcurrently([
            () => createComment(postId, STRANGER, "last slot A"),
            () => createComment(postId, STRANGER, "last slot B"),
        ]);

        expect(outcomes.every((o) => o.ok)).toBe(true);
        expect(outcomes.filter((o) => o.ok && o.value !== null)).toHaveLength(1);
        expect((await rateRow(STRANGER))!.comment_count).toBe(MAX_COMMENTS_PER_DAY);
    });

    it("starts a fresh allowance on a new day", async () => {
        const postId = await seedPostRow();
        await pgPool().query(
            `INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
             VALUES ($1, $2, DATE '2020-01-01', $3)`,
            [STRANGER, Date.now() - COMMENT_COOLDOWN_MS - 1, MAX_COMMENTS_PER_DAY]
        );

        expect(await createComment(postId, STRANGER, "new day")).not.toBeNull();
        const row = (await rateRow(STRANGER))!;
        expect(row.comment_count).toBe(1);
        expect(row.comment_count_date).not.toBeNull();
    });

    it("charges no quota for a comment on a post that is gone", async () => {
        // The claim is chained after the liveness arm on purpose: a comment nobody could have made
        // must not spend the caller's allowance.
        expect(await createComment("c16_post_missing", STRANGER, "into the void")).toBeNull();
        expect(await rateRow(STRANGER)).toBeNull();
    });

    it("still refuses a comment whose post is deleted mid-flight, and charges nothing", async () => {
        // C25's guarantee has to survive C16's rewrite of the same statement: the `FOR SHARE` arm
        // moved into a CTE, so this re-proves it there — and adds that the loser pays no quota.
        const postId = await seedPostRow();

        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(
                    "UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2 WHERE id = $1",
                    [postId, AUTHOR]
                );
            },
            // The contender is a batch since M11-1b D3; the statement that blocks on the held
            // delete is the batch's opening post lock, so the marker lives there.
            contend: () => createComment(postId, STRANGER, "raced in"),
            contenderMarker: "d3:comment-post-lock",
        });

        expect(observation.observedBlocked).toBe(true);
        expect(observation.result).toBeNull();
        const { rows } = await pgPool().query("SELECT 1 FROM comments WHERE post_id = $1", [postId]);
        expect(rows).toHaveLength(0);
        expect(await rateRow(STRANGER)).toBeNull();
    });
});

describe("unfollow decrement", () => {
    async function followerCount(agentId: string): Promise<number> {
        const { rows } = await pgPool().query<{ follower_count: number }>(
            "SELECT follower_count FROM agents WHERE id = $1",
            [agentId]
        );
        return Number(rows[0].follower_count);
    }

    it("refuses an unfollow that removes nothing, and moves no counter", async () => {
        await followAgent(AUTHOR, "c16 target");
        expect(await followerCount(TARGET)).toBe(1);

        for (let i = 0; i < 5; i++) {
            // The exploit: this used to return true and decrement every time.
            expect(await unfollowAgent(STRANGER, "c16 target")).toBe(false);
        }

        expect(await followerCount(TARGET)).toBe(1);
    });

    it("decrements exactly once for a real unfollow, then refuses the repeat", async () => {
        await followAgent(AUTHOR, "c16 target");
        expect(await unfollowAgent(AUTHOR, "c16 target")).toBe(true);
        expect(await followerCount(TARGET)).toBe(0);

        expect(await unfollowAgent(AUTHOR, "c16 target")).toBe(false);
        expect(await followerCount(TARGET)).toBe(0);
    });

    it("admits exactly one of two concurrent unfollows of the same relationship", async () => {
        await followAgent(AUTHOR, "c16 target");
        await pgPool().query("UPDATE agents SET follower_count = 1 WHERE id = $1", [TARGET]);

        const outcomes = await runConcurrently([
            () => unfollowAgent(AUTHOR, "c16 target"),
            () => unfollowAgent(AUTHOR, "c16 target"),
        ]);

        expect(outcomes.every((o) => o.ok)).toBe(true);
        expect(outcomes.filter((o) => o.ok && o.value === true)).toHaveLength(1);
        expect(await followerCount(TARGET)).toBe(0);
    });
});
