/**
 * M11-1b D2 `[integration]` — the locked single-statement pin/unpin, against the real database.
 * Memory-mode authorization and cap semantics are in
 * `src/__tests__/lib/store/posts/d2-pin-locking.test.ts`.
 */
import { closeIntegrationConnections, neonSql, pgPool } from "./helpers/db";
import { raceAgainstHeldLock, runConcurrently } from "./helpers/concurrency";
import { pinPost, unpinPost, deletePost } from "@/lib/store/posts/db";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

const OWNER = `d2_owner_${RUN}`;
const MOD = `d2_mod_${RUN}`;
const STRANGER = `d2_stranger_${RUN}`;

async function seedAgent(id: string): Promise<void> {
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
         VALUES ($1, $1, '', $2, 0, 0, false, NOW(), true) ON CONFLICT (id) DO NOTHING`,
        [id, `d2_key_${id}`]
    );
}

async function seedGroup(): Promise<string> {
    const id = `d2_group_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO groups (id, name, display_name, description, owner_id, moderator_ids, pinned_post_ids, created_at)
         VALUES ($1, $1, 'D2', '', $2, $3::jsonb, '[]'::jsonb, NOW())`,
        [id, OWNER, JSON.stringify([MOD])]
    );
    return id;
}

async function seedPostRow(groupId: string): Promise<string> {
    const id = `d2_post_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO posts (id, group_id, author_id, title, content, upvotes, downvotes, comment_count, created_at)
         VALUES ($1, $2, $3, 'pin me', 'body', 0, 0, 0, NOW())`,
        [id, groupId, OWNER]
    );
    return id;
}

async function pinnedIds(groupId: string): Promise<string[]> {
    const { rows } = await pgPool().query<{ pinned_post_ids: string[] }>(
        "SELECT pinned_post_ids FROM groups WHERE id = $1",
        [groupId]
    );
    return rows[0]?.pinned_post_ids ?? [];
}

beforeAll(async () => {
    for (const id of [OWNER, MOD, STRANGER]) await seedAgent(id);
});

afterAll(async () => {
    await pgPool().query("DELETE FROM posts WHERE group_id LIKE $1", [`d2_group_${RUN}%`]);
    await pgPool().query("DELETE FROM groups WHERE id LIKE $1", [`d2_group_${RUN}%`]);
    await pgPool().query("DELETE FROM agents WHERE id IN ($1, $2, $3)", [OWNER, MOD, STRANGER]);
    await closeIntegrationConnections();
});

describe("authorization is in the decisive statement", () => {
    it("owner and moderator can pin; a stranger cannot", async () => {
        const groupId = await seedGroup();
        const post = await seedPostRow(groupId);
        expect(await pinPost(groupId, post, STRANGER)).toBe(false);
        expect(await pinPost(groupId, post, MOD)).toBe(true);
        expect(await pinnedIds(groupId)).toEqual([post]);
    });

    it("a moderator revoked mid-flight cannot pin (authorization is not a stale pre-check)", async () => {
        const groupId = await seedGroup();
        const post = await seedPostRow(groupId);
        // Revoke the moderator, then attempt: the UPDATE's own predicate refuses.
        await pgPool().query("UPDATE groups SET moderator_ids = '[]'::jsonb WHERE id = $1", [groupId]);
        expect(await pinPost(groupId, post, MOD)).toBe(false);
        expect(await pinnedIds(groupId)).toEqual([]);
    });
});

describe("cap and idempotence", () => {
    it("pins are capped at three and idempotent", async () => {
        const groupId = await seedGroup();
        const posts = await Promise.all([seedPostRow(groupId), seedPostRow(groupId), seedPostRow(groupId), seedPostRow(groupId)]);
        for (const p of posts.slice(0, 3)) expect(await pinPost(groupId, p, OWNER)).toBe(true);
        expect(await pinPost(groupId, posts[0], OWNER)).toBe(true); // idempotent
        expect(await pinPost(groupId, posts[3], OWNER)).toBe(false); // cap
        expect(await pinnedIds(groupId)).toEqual(posts.slice(0, 3));
    });

    it("two concurrent distinct pins both persist (no lost update)", async () => {
        const groupId = await seedGroup();
        const a = await seedPostRow(groupId);
        const b = await seedPostRow(groupId);
        const outcomes = await runConcurrently([
            () => pinPost(groupId, a, OWNER),
            () => pinPost(groupId, b, OWNER),
        ]);
        expect(outcomes.every((o) => o.ok && o.value)).toBe(true);
        expect((await pinnedIds(groupId)).sort()).toEqual([a, b].sort());
    });
});

describe("pin-vs-delete race (the D2 headline)", () => {
    it("a pin racing an in-flight soft-delete blocks and resolves not_found — no deleted id survives", async () => {
        const groupId = await seedGroup();
        const post = await seedPostRow(groupId);

        const observation = await raceAgainstHeldLock<boolean>({
            hold: async (holder) => {
                // The soft-delete holds FOR NO KEY UPDATE on the row, uncommitted.
                await holder.query(
                    "UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2 WHERE id = $1",
                    [post, OWNER]
                );
            },
            contend: async () => await pinPost(groupId, post, OWNER),
            contenderMarker: "d2:pin-post-lock",
        });

        expect(observation.observedBlocked).toBe(true);
        // The pin blocked, the delete committed, and the pin then saw the tombstone: not pinned.
        expect(observation.result).toBe(false);
        expect(await pinnedIds(groupId)).toEqual([]);
    });
});

describe("unpin does not require a live post (the D2 asymmetry)", () => {
    it("a stale pinned id whose post is gone is still removable by a moderator", async () => {
        const groupId = await seedGroup();
        const post = await seedPostRow(groupId);
        expect(await pinPost(groupId, post, OWNER)).toBe(true);

        // The stale pin is produced by a PRE-D1 delete — the bare tombstone, with no cleanup.
        // Calling `deletePost` no longer leaves one: since M11-1b D1 the delete strips its own pin
        // (this test asserted the opposite until D1 landed). The state still exists in two ways
        // that matter, which is why unpin must keep working without a live post: rows deleted
        // before D1 shipped, and rows tombstoned by an old instance during the rollout. D1's sweep
        // clears them in bulk; a moderator must be able to clear one by hand.
        await pgPool().query("UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2 WHERE id = $1", [post, OWNER]);
        expect(await pinnedIds(groupId)).toEqual([post]);

        expect(await unpinPost(groupId, post, OWNER)).toBe(true);
        expect(await pinnedIds(groupId)).toEqual([]);
    });

    it("D1's delete now strips its own pin, so no fresh orphan is created", async () => {
        // The behaviour change the test above had to be rewritten around, pinned in its own right.
        const groupId = await seedGroup();
        const post = await seedPostRow(groupId);
        expect(await pinPost(groupId, post, OWNER)).toBe(true);

        expect(await deletePost(post, OWNER)).toMatchObject({ deleted: true });
        expect(await pinnedIds(groupId)).toEqual([]);
    });

    it("a revoked moderator cannot unpin", async () => {
        const groupId = await seedGroup();
        const post = await seedPostRow(groupId);
        await pinPost(groupId, post, OWNER);
        await pgPool().query("UPDATE groups SET moderator_ids = '[]'::jsonb WHERE id = $1", [groupId]);
        expect(await unpinPost(groupId, post, MOD)).toBe(false);
        expect(await pinnedIds(groupId)).toEqual([post]);
    });

    it("concurrent pin-of-a-deleted-id cannot beat the delete: no ghost pin persists via the neon path", async () => {
        const groupId = await seedGroup();
        const post = await seedPostRow(groupId);
        // Soft-delete first (committed), then attempt to pin through the Neon driver: the CTE sees
        // the tombstone and writes nothing.
        await deletePost(post, OWNER);
        const rows = await neonSql()`
            WITH locked_post AS (
              SELECT id FROM posts WHERE id = ${post} AND group_id = ${groupId} AND deleted_at IS NULL FOR SHARE
            )
            UPDATE groups SET pinned_post_ids = pinned_post_ids || to_jsonb(${post}::text)
            WHERE id = ${groupId} AND EXISTS (SELECT 1 FROM locked_post)
            RETURNING id
        `;
        expect(rows.length).toBe(0);
        expect(await pinnedIds(groupId)).toEqual([]);
    });
});
