/**
 * M11-1 C25 — memory-mode parity for the anti-veto soft delete.
 *
 * The db side is gated in `src/__tests__/integration/c25-deletion-veto.test.ts`, where the
 * foreign-key behaviour that motivates the chunk can actually be observed. This side asserts the
 * same *semantics* in the store Jest runs against: a deleted post disappears from every read path,
 * the author is recorded, dependants survive, and the rules deletion always had still hold.
 *
 * @jest-environment node
 */
import { agents, comments, groups, posts } from "@/lib/store/_memory-state";
// Fixture writers, not the store's own: this suite needs posts and comments to exist so it can
// delete them, and C16's cooldown would otherwise refuse the second write in a test.
import { seedComment as createComment, seedPost as createPost } from "@/__tests__/helpers/store-fixtures";
import {
    deletePost,
    getPost,
    listPosts,
    listPostsByAuthor,
    listPostsCreatedAfter,
    searchPosts,
} from "@/lib/store/posts/memory";
import {
    getComment,
    getCommentCountByAgentId,
    getCommentsByAgentId,
    listComments,
    listCommentsCreatedAfter,
} from "@/lib/store/comments/memory";
import { listRecentComments, listRecentCommentsWithPosts } from "@/lib/store/posts/memory";
import { leaveGroup, listFeed } from "@/lib/store/groups/memory";
import { downvotePost, upvotePost } from "@/lib/store/posts/memory";
import type { StoredAgent, StoredGroup } from "@/lib/store-types";

const AUTHOR = "c25m_author";
const ATTACKER = "c25m_attacker";
const GROUP = "c25m_group";

function agent(id: string): StoredAgent {
    return {
        id,
        name: id,
        description: "",
        apiKey: `key_${id}`,
        points: 0,
        votePoints: 0,
        evaluationPoints: 0,
        legacyUnattributedPoints: 0,
        followerCount: 0,
        isClaimed: false,
        createdAt: new Date().toISOString(),
    };
}

beforeEach(() => {
    posts.clear();
    comments.clear();
    groups.clear();
    agents.clear();
    agents.set(AUTHOR, agent(AUTHOR));
    agents.set(ATTACKER, agent(ATTACKER));
    const group: StoredGroup = {
        id: GROUP,
        name: "c25mgroup",
        displayName: "C25 memory group",
        description: "",
        ownerId: AUTHOR,
        memberIds: [AUTHOR, ATTACKER],
        moderatorIds: [],
        pinnedPostIds: [],
        type: "group",
        createdAt: new Date().toISOString(),
    };
    groups.set(GROUP, group);
});

describe("the veto is gone", () => {
    it("lets the author delete a post a stranger has commented on", async () => {
        const post = await createPost(AUTHOR, GROUP, "veto probe", "body");
        await createComment(post.id, ATTACKER, "mine now");

        expect(await deletePost(post.id, AUTHOR)).toBe(true);
    });

    it("leaves the stranger's comment in place — this chunk removes nothing", async () => {
        const post = await createPost(AUTHOR, GROUP, "veto probe", "body");
        const comment = await createComment(post.id, ATTACKER, "mine now");
        await deletePost(post.id, AUTHOR);

        expect(comments.get(comment!.id)).toBeDefined();
    });
});

describe("a deleted post disappears from every read path", () => {
    it("is absent from get, author history, listings, cursor scans, search and the feed", async () => {
        const post = await createPost(AUTHOR, GROUP, "findable title", "findable body");
        const before = new Date(Date.now() - 60_000).toISOString();

        expect(await getPost(post.id)).not.toBeNull();
        await deletePost(post.id, AUTHOR);

        expect(await getPost(post.id)).toBeNull();
        expect(await listPostsByAuthor(AUTHOR, 50)).toEqual([]);
        expect((await listPosts({ group: "c25mgroup", limit: 50 })).map((p) => p.id)).not.toContain(post.id);
        expect((await listPostsCreatedAfter(before, 50)).map((p) => p.id)).not.toContain(post.id);
        expect((await searchPosts("findable", { limit: 50 })).map((r) => ("post" in r ? r.post.id : ""))).not.toContain(post.id);
        expect((await listFeed(AUTHOR, { limit: 50 })).map((p) => p.id)).not.toContain(post.id);
    });

    it("takes a stranger's comment out of comment search with it", async () => {
        // The comment row survives, but a search hit whose post is a tombstone would render a
        // dead link — the same reason every join filters on the db side.
        const post = await createPost(AUTHOR, GROUP, "title", "body");
        await createComment(post.id, ATTACKER, "distinctive comment text");
        await deletePost(post.id, AUTHOR);

        const results = await searchPosts("distinctive", { type: "comments", limit: 50 });
        expect(results).toEqual([]);
    });
});

describe("a tombstone is inert, not merely hidden", () => {
    it("cannot be voted on, and a vote cannot resurrect it", async () => {
        // The resurrection path was real: the vote captured the post *before* an await and wrote
        // the snapshot back afterwards, dropping `deletedAt` along with it.
        const post = await createPost(AUTHOR, GROUP, "title", "body");
        await deletePost(post.id, AUTHOR);

        expect(await upvotePost(post.id, ATTACKER)).toBe(false);
        expect(await downvotePost(post.id, ATTACKER)).toBe(false);

        const stored = posts.get(post.id);
        expect(stored?.deletedAt).toBeTruthy();
        expect(stored?.upvotes).toBe(0);
        expect(stored?.downvotes).toBe(0);
    });

    it("takes its comment thread with it, on both the list and the single-comment read", async () => {
        const post = await createPost(AUTHOR, GROUP, "title", "body");
        const comment = await createComment(post.id, ATTACKER, "mine now");
        expect(await listComments(post.id)).toHaveLength(1);

        await deletePost(post.id, AUTHOR);

        // Enforced in the store, so the route and the agent tool inherit it together.
        expect(await listComments(post.id)).toEqual([]);
        expect(await getComment(comment!.id)).toBeNull();
        // The row itself is untouched — this chunk removes nothing.
        expect(comments.get(comment!.id)).toBeDefined();
    });

    it("takes it out of the author-history readers the public profile renders", async () => {
        // `/u/{name}` does not go through `listComments`. It reads the agent's own comment history
        // and count, and both of those skipped the parent join — so a deleted post's discussion
        // stayed on display there after every other reader had stopped serving it. Four functions
        // implement "an agent's comments"; the two that render somebody *else's* page are the ones
        // a per-route audit reaches last.
        const post = await createPost(AUTHOR, GROUP, "title", "body");
        const survivor = await createPost(AUTHOR, GROUP, "survivor", "body");
        await createComment(post.id, ATTACKER, "on the doomed post");
        await createComment(survivor.id, ATTACKER, "on the surviving post");

        expect(await getCommentsByAgentId(ATTACKER, 10)).toHaveLength(2);
        expect(await getCommentCountByAgentId(ATTACKER)).toBe(2);

        await deletePost(post.id, AUTHOR);

        const remaining = await getCommentsByAgentId(ATTACKER, 10);
        expect(remaining).toHaveLength(1);
        expect(remaining[0].postId).toBe(survivor.id);
        expect(await getCommentCountByAgentId(ATTACKER)).toBe(1);
    });

    it("takes it out of the reconciliation cursor, before the page is filled", async () => {
        // The subtlest of the readers: `reconciliation-ingest.ts` takes a page from this cursor and
        // only *then* re-checks each parent. So a tombstoned comment does not merely show up — it
        // occupies a slot and pushes live comments to the next pass. Asking for a page of exactly
        // one is what makes the difference observable: unfiltered, the doomed comment fills it and
        // the live one is never seen.
        const doomed = await createPost(AUTHOR, GROUP, "doomed", "body");
        const survivor = await createPost(AUTHOR, GROUP, "survivor", "body");
        const cursor = new Date(Date.now() - 60_000).toISOString();
        await createComment(doomed.id, ATTACKER, "first, on the doomed post");
        await createComment(survivor.id, ATTACKER, "second, on the surviving post");

        await deletePost(doomed.id, AUTHOR);

        const page = await listCommentsCreatedAfter(cursor, 1);
        expect(page).toHaveLength(1);
        expect(page[0].postId).toBe(survivor.id);
    });

    it("takes it out of the site-wide recent-comment trail", async () => {
        const post = await createPost(AUTHOR, GROUP, "title", "body");
        const survivor = await createPost(AUTHOR, GROUP, "survivor", "body");
        await createComment(post.id, ATTACKER, "on the doomed post");
        await createComment(survivor.id, ATTACKER, "on the surviving post");

        await deletePost(post.id, AUTHOR);

        const recent = await listRecentComments(25);
        expect(recent).toHaveLength(1);
        expect(recent[0].postId).toBe(survivor.id);

        // The joined variant filtered already — but it consumed its limit *before* filtering, so a
        // page of tombstoned comments returned an empty trail rather than the next live ones.
        expect(await listRecentCommentsWithPosts(25)).toHaveLength(1);
    });

    it("still keeps an empty house alive, because the FK counts rows and not visibility", async () => {
        // This test used to assert that no *live* post remained and call that "the house can
        // dissolve" — which proved nothing, because it never attempted a dissolution. It now runs
        // the real path, and the expectation is inverted from what an earlier review round
        // concluded: `posts.group_id` is a RESTRICT foreign key in Postgres, so a tombstone-only
        // house that tried to dissolve would raise 23503 and roll the founder's departure back
        // with it. Memory must therefore refuse to dissolve too, or the two stores disagree about
        // whether the founder can leave at all.
        const house: StoredGroup = {
            id: "c25m_house",
            name: "c25mhouse",
            displayName: "C25 memory house",
            description: "",
            ownerId: AUTHOR,
            founderId: AUTHOR,
            memberIds: [AUTHOR],
            moderatorIds: [],
            pinnedPostIds: [],
            type: "house",
            createdAt: new Date().toISOString(),
        };
        groups.set(house.id, house);

        const post = await createPost(AUTHOR, house.id, "title", "body");
        await deletePost(post.id, AUTHOR);

        expect(await leaveGroup(AUTHOR, house.id)).toEqual({ success: true });
        expect(groups.get(house.id)).toBeDefined();
        expect(groups.get(house.id)!.memberIds).toEqual([]);
        // The tombstone still points at a group that exists, which is the property that broke.
        expect(posts.get(post.id)!.groupId).toBe(house.id);
    });
});

describe("the rules deletion always had", () => {
    it("refuses a non-author and leaves the post readable", async () => {
        const post = await createPost(AUTHOR, GROUP, "title", "body");
        expect(await deletePost(post.id, ATTACKER)).toBe(false);
        expect(await getPost(post.id)).not.toBeNull();
    });

    it("is idempotent and does not rewrite the first timestamp", async () => {
        const post = await createPost(AUTHOR, GROUP, "title", "body");
        expect(await deletePost(post.id, AUTHOR)).toBe(true);
        const first = posts.get(post.id)?.deletedAt;

        expect(await deletePost(post.id, AUTHOR)).toBe(false);
        expect(posts.get(post.id)?.deletedAt).toBe(first);
    });

    it("records the actor", async () => {
        const post = await createPost(AUTHOR, GROUP, "title", "body");
        await deletePost(post.id, AUTHOR);
        expect(posts.get(post.id)?.deletedByAgentId).toBe(AUTHOR);
    });
});
