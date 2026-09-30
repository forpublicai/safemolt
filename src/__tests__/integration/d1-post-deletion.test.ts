/**
 * M11-1b D1 `[integration]` — post deletion against the real database.
 *
 * What only a database can show, and what this file is for:
 *  - the delete is ONE transaction, so a projection that cannot be cleaned takes the tombstone
 *    with it rather than leaving a half-cleaned post;
 *  - the post is LOCKED before anything is cleaned, so a vote landing mid-flight cannot slip in
 *    after its own cleanup statement ran;
 *  - the karma reversal reads `points_delta`, and the NULL rows really are excluded.
 *
 * Memory-mode semantics are in `src/__tests__/lib/d1-post-deletion.test.ts`.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";
import { pidOf, raceAgainstHeldLock, waitForWaiter } from "./helpers/concurrency";
import { deletePost, downvotePost, upvotePost } from "@/lib/store/posts/db";
import { deleteAgent } from "@/lib/store/agents/db";
import { claimActivityContextEnrichment, upsertActivityContext } from "@/lib/store/activity/db";
import { recordPostActivityEvent } from "@/lib/store/activity/events";

/** The runbook sweep, read from disk so the test cannot drift from the script that ships. */
const SWEEP_SQL = readFileSync(
    join(__dirname, "..", "..", "..", "scripts", "reconcile-post-deletion-projections.sql"),
    "utf8"
);

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `d1_${kind}_${RUN}_${(seq += 1)}`;

const GROUP = `d1_group_${RUN}`;

async function seedGroup(ownerId: string): Promise<void> {
    await pgPool().query(
        `INSERT INTO groups (id, name, display_name, description, owner_id, member_ids, moderator_ids,
                             pinned_post_ids, created_at)
         VALUES ($1, $1, $1, '', $2, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [GROUP, ownerId]
    );
}

async function seedAgent(points = 0): Promise<string> {
    const id = nextId("agent");
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                             legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
         VALUES ($1, $1, '', $2, $3, $3, 0, 0, 0, false, NOW(), true)`,
        [id, `d1_key_${id}`, points]
    );
    return id;
}

async function seedPost(authorId: string): Promise<string> {
    const id = nextId("post");
    await pgPool().query(
        `INSERT INTO posts (id, group_id, author_id, title, content, upvotes, downvotes, comment_count, created_at)
         VALUES ($1, $2, $3, 'd1 probe', 'body', 0, 0, 0, NOW())`,
        [id, GROUP, authorId]
    );
    return id;
}

/** A comment with a caller-chosen id, so a test can make physical order and id order disagree. */
async function seedCommentWithSuffix(postId: string, authorId: string, suffix: string): Promise<string> {
    const id = `d1_comment_${RUN}_${suffix}`;
    await pgPool().query(
        `INSERT INTO comments (id, post_id, author_id, content, upvotes, created_at)
         VALUES ($1, $2, $3, 'd1 probe', 0, NOW())`,
        [id, postId, authorId]
    );
    return id;
}

async function seedComment(postId: string, authorId: string): Promise<string> {
    const id = nextId("comment");
    await pgPool().query(
        `INSERT INTO comments (id, post_id, author_id, content, upvotes, created_at)
         VALUES ($1, $2, $3, 'd1 probe', 0, NOW())`,
        [id, postId, authorId]
    );
    return id;
}

/** A vote row carrying the award it made — or NULL, for a pre-M11-1C row. */
async function seedPostVote(postId: string, voterId: string, delta: number | null): Promise<void> {
    await pgPool().query(
        `INSERT INTO post_votes (agent_id, post_id, vote_type, voted_at, points_delta)
         VALUES ($1, $2, $3, NOW(), $4)`,
        [voterId, postId, delta != null && delta < 0 ? -1 : 1, delta]
    );
}

async function seedCommentVote(commentId: string, voterId: string, delta: number | null): Promise<void> {
    await pgPool().query(
        `INSERT INTO comment_votes (agent_id, comment_id, vote_type, voted_at, points_delta)
         VALUES ($1, $2, 1, NOW(), $3)`,
        [voterId, commentId, delta]
    );
}

async function seedActivity(kind: string, entityId: string): Promise<void> {
    await pgPool().query(
        `INSERT INTO activity_events (kind, occurred_at, actor_id, actor_name, actor_canonical_name,
                                      entity_id, title, href, summary, context_hint, search_text, metadata)
         VALUES ($1, NOW(), NULL, '', '', $2, 't', '/x', 's', 'c', 'st', '{}'::jsonb)
         ON CONFLICT DO NOTHING`,
        [kind, entityId]
    );
    await pgPool().query(
        `INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
         VALUES ($1, $2, 'v1', 'ctx') ON CONFLICT DO NOTHING`,
        [kind, entityId]
    );
}

async function karmaOf(agentId: string) {
    const { rows } = await pgPool().query(
        `SELECT points, vote_points, evaluation_points, legacy_unattributed_points FROM agents WHERE id = $1`,
        [agentId]
    );
    const r = rows[0];
    // Checked on every read, so no reversal case can pass while quietly breaking the M11-1C
    // invariant `points = legacy + vote + evaluation`.
    expect(Number(r.points)).toBe(
        Number(r.legacy_unattributed_points) + Number(r.vote_points) + Number(r.evaluation_points)
    );
    return { points: Number(r.points), votePoints: Number(r.vote_points) };
}

async function counts(postId: string, commentIds: string[]) {
    const { rows: events } = await pgPool().query(
        `SELECT count(*)::int AS c FROM activity_events
         WHERE (kind = 'post' AND entity_id = $1) OR (kind = 'comment' AND entity_id = ANY($2))`,
        [postId, commentIds]
    );
    const { rows: contexts } = await pgPool().query(
        `SELECT count(*)::int AS c FROM activity_contexts
         WHERE (activity_kind = 'post' AND activity_id = $1) OR (activity_kind = 'comment' AND activity_id = ANY($2))`,
        [postId, commentIds]
    );
    const { rows: notifs } = await pgPool().query(
        `SELECT count(*)::int AS c FROM notifications WHERE metadata->>'post_id' = $1`,
        [postId]
    );
    return { events: events[0].c, contexts: contexts[0].c, notifications: notifs[0].c };
}

async function isDeleted(postId: string): Promise<boolean> {
    const { rows } = await pgPool().query(`SELECT deleted_at FROM posts WHERE id = $1`, [postId]);
    return rows[0]?.deleted_at != null;
}

beforeAll(async () => {
    await seedGroup(await seedAgent());
});

afterAll(async () => {
    await pgPool().query("DELETE FROM activity_contexts WHERE activity_id LIKE $1", [`d1_%${RUN}%`]);
    await pgPool().query("DELETE FROM activity_events WHERE entity_id LIKE $1", [`d1_%${RUN}%`]);
    await pgPool().query("DELETE FROM notifications WHERE agent_id LIKE $1", [`d1_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM comment_votes WHERE agent_id LIKE $1", [`d1_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM post_votes WHERE agent_id LIKE $1", [`d1_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM comments WHERE id LIKE $1", [`d1_comment_${RUN}%`]);
    await pgPool().query("DELETE FROM posts WHERE id LIKE $1", [`d1_post_${RUN}%`]);
    await pgPool().query("DELETE FROM groups WHERE id = $1", [GROUP]);
    await pgPool().query("DELETE FROM agents WHERE id LIKE $1", [`d1_agent_${RUN}%`]);
    await closeIntegrationConnections();
});

describe("projection cleanup", () => {
    it("removes the post's and its comments' activity, contexts, notifications and pin — in one go", async () => {
        const author = await seedAgent();
        const post = await seedPost(author);
        const comment = await seedComment(post, await seedAgent());
        await seedActivity("post", post);
        await seedActivity("comment", comment);
        await pgPool().query(
            `INSERT INTO notifications (id, agent_id, type, metadata) VALUES ($1, $2, 'reply', $3::jsonb)`,
            [nextId("notif"), author, JSON.stringify({ post_id: post })]
        );
        await pgPool().query(
            `UPDATE groups SET pinned_post_ids = $2::jsonb WHERE id = $1`,
            [GROUP, JSON.stringify([post, "d1_other_post"])]
        );

        expect(await deletePost(post, author)).toMatchObject({ deleted: true });

        expect(await counts(post, [comment])).toEqual({ events: 0, contexts: 0, notifications: 0 });
        const { rows } = await pgPool().query(`SELECT pinned_post_ids FROM groups WHERE id = $1`, [GROUP]);
        expect(rows[0].pinned_post_ids).toEqual(["d1_other_post"]);
        expect(await isDeleted(post)).toBe(true);
    });

    it("changes NOTHING when the caller is not the author", async () => {
        const author = await seedAgent();
        const stranger = await seedAgent();
        const post = await seedPost(author);
        await seedActivity("post", post);
        await seedPostVote(post, await seedAgent(), 1);
        await pgPool().query(`UPDATE agents SET points = 1, vote_points = 1 WHERE id = $1`, [author]);

        expect(await deletePost(post, stranger)).toMatchObject({ deleted: false });

        expect(await isDeleted(post)).toBe(false);
        expect((await counts(post, [])).events).toBe(1);
        expect(await karmaOf(author)).toEqual({ points: 1, votePoints: 1 });
    });

    it("leaves another post's projections alone", async () => {
        const author = await seedAgent();
        const doomed = await seedPost(author);
        const survivor = await seedPost(author);
        await seedActivity("post", survivor);

        expect(await deletePost(doomed, author)).toMatchObject({ deleted: true });
        expect((await counts(survivor, [])).events).toBe(1);
    });
});

describe("karma reversal", () => {
    it("reverses exactly what the post's and its comments' votes awarded", async () => {
        const author = await seedAgent();
        const commenter = await seedAgent();
        const post = await seedPost(author);
        const comment = await seedComment(post, commenter);
        await seedPostVote(post, await seedAgent(), 1);
        await seedPostVote(post, await seedAgent(), 1);
        await seedCommentVote(comment, await seedAgent(), 1);
        await pgPool().query(`UPDATE agents SET points = 5, vote_points = 5 WHERE id = $1`, [author]);
        await pgPool().query(`UPDATE agents SET points = 4, vote_points = 4 WHERE id = $1`, [commenter]);

        expect(await deletePost(post, author)).toMatchObject({ deleted: true });

        expect(await karmaOf(author)).toEqual({ points: 3, votePoints: 3 });
        expect(await karmaOf(commenter)).toEqual({ points: 3, votePoints: 3 });
    });

    it("EXCLUDES a vote whose award is unknowable, rather than guessing at it", async () => {
        // `points_delta IS NULL` marks a pre-M11-1C vote. A downvote cast against an author at zero
        // awarded 0, not -1 — reversing a guessed -1 would ADD a point, which is a worse defect
        // than the one D1 closes.
        const author = await seedAgent();
        const post = await seedPost(author);
        await seedPostVote(post, await seedAgent(), null);
        await seedPostVote(post, await seedAgent(), 1);
        await pgPool().query(`UPDATE agents SET points = 6, vote_points = 6 WHERE id = $1`, [author]);

        expect(await deletePost(post, author)).toMatchObject({ deleted: true });
        expect(await karmaOf(author)).toEqual({ points: 5, votePoints: 5 });
    });

    it("leaves the author's points UNCHANGED across repeated vote → delete cycles", async () => {
        // The farming primitive. `post_votes` is keyed per (agent, post), so a NEW post lets the
        // same collaborator vote again — and the real vote path is used here, not a seeded row, so
        // the award and the reversal are produced by the two statements that must agree.
        const author = await seedAgent();
        const collaborator = await seedAgent();

        for (let cycle = 0; cycle < 3; cycle += 1) {
            const post = await seedPost(author);
            expect(await upvotePost(post, collaborator)).toBe(true);
            expect(await deletePost(post, author)).toMatchObject({ deleted: true });
        }

        expect(await karmaOf(author)).toEqual({ points: 0, votePoints: 0 });
    });

    it("CANNOT MINT: upvote A, downvote B, delete both — the author does not gain a point", async () => {
        // The award floor is not invertible, so reversing in the wrong order used to manufacture
        // karma: deleting A floors and gives back nothing, then deleting B reverses a -1 and ADDS
        // one. Driven through the REAL vote paths, so the recorded deltas are the ones production
        // writes.
        const author = await seedAgent(0);
        const postA = await seedPost(author);
        const postB = await seedPost(author);

        expect(await upvotePost(postA, await seedAgent())).toBe(true);
        expect(await downvotePost(postB, await seedAgent())).toBe(true);
        expect(await karmaOf(author)).toEqual({ points: 0, votePoints: 0 });

        expect(await deletePost(postA, author)).toMatchObject({ deleted: true });
        expect(await deletePost(postB, author)).toMatchObject({ deleted: true });
        expect(await karmaOf(author)).toEqual({ points: 0, votePoints: 0 });
    });

    it("never drives points below zero, and keeps the components summing to the total", async () => {
        const author = await seedAgent(0);
        const post = await seedPost(author);
        await seedPostVote(post, await seedAgent(), 1); // an award the author no longer holds

        expect(await deletePost(post, author)).toMatchObject({ deleted: true });

        const { rows } = await pgPool().query(
            `SELECT points, vote_points, evaluation_points, legacy_unattributed_points FROM agents WHERE id = $1`,
            [author]
        );
        const r = rows[0];
        expect(Number(r.points)).toBe(0);
        expect(Number(r.points)).toBe(
            Number(r.legacy_unattributed_points) + Number(r.vote_points) + Number(r.evaluation_points)
        );
    });
});

describe("the cleanup cannot be written back", () => {
    it("refuses to cache a context for an activity the delete removed", async () => {
        // Context enrichment is read-then-write with a slow LLM call in between and holds no post
        // lock, so without a liveness gate the sequence "read the activity, delete the post, finish
        // enriching" wrote the cached context straight back — a dead context for a deleted post,
        // served forever by id, because the cache is read before anything checks liveness. It also
        // broke the sweep's "a second pass reports zero" property.
        //
        // The delete is already committed here, so this needs no race: the writers must simply
        // refuse. Against the ungated writers both calls below succeed and leave rows behind.
        const author = await seedAgent();
        const post = await seedPost(author);
        await seedActivity("post", post);

        expect(await deletePost(post, author)).toMatchObject({ deleted: true });
        expect((await counts(post, [])).contexts).toBe(0);

        expect(await upsertActivityContext("post", post, "v-resurrect", "written after the delete")).toBeNull();
        expect(await claimActivityContextEnrichment("post", post, "v-resurrect-pending")).toBe(false);
        expect((await counts(post, [])).contexts).toBe(0);

        // A LIVE activity still caches, so the gate is not simply refusing everything.
        const liveAuthor = await seedAgent();
        const live = await seedPost(liveAuthor);
        await seedActivity("post", live);
        expect(await upsertActivityContext("post", live, "v-resurrect", "written for a live post")).not.toBeNull();
    });

    it("caches for a live post that has NO activity row, because the POST is the subject", async () => {
        // The gate reads `posts.deleted_at`, not the projection. `activity_events` was never
        // backfilled for older content and its writes are best-effort, so treating a missing event
        // row as "deleted" would silently deny context to any post whose projection is absent —
        // a live post answering "no context available" forever.
        const author = await seedAgent();
        const post = await seedPost(author);
        // Deliberately no seedActivity(...) here.

        expect(await upsertActivityContext("post", post, "v-no-event", "live post, no projection")).not.toBeNull();
        expect(await claimActivityContextEnrichment("post", post, "v-no-event-pending")).toBe(true);
    });

    it("refuses to write the ACTIVITY EVENT for a post the delete already removed", async () => {
        // The other half of the same class, and the one that reaches the public trail directly:
        // `createPost` commits the row and writes its activity projection in a SECOND statement, so
        // an author who deletes in that window leaves the delete with no event to clean — and the
        // late upsert would publish the deleted post's title and a dead /post/ link, permanently.
        // The sweep would repair it only until the next such race.
        const author = await seedAgent();
        const post = await seedPost(author);
        expect(await deletePost(post, author)).toMatchObject({ deleted: true });

        await recordPostActivityEvent({
            id: post,
            authorId: author,
            groupId: GROUP,
            title: "written after the delete",
            content: "body",
            createdAt: new Date().toISOString(),
        });

        expect((await counts(post, [])).events).toBe(0);

        // A live post still gets its projection, so the gate is not simply refusing everything.
        const live = await seedPost(author);
        await recordPostActivityEvent({
            id: live,
            authorId: author,
            groupId: GROUP,
            title: "written for a live post",
            content: "body",
            createdAt: new Date().toISOString(),
        });
        expect((await counts(live, [])).events).toBe(1);
    });

    it("still caches a SYNTHESIZED activity, which has no event row to check", async () => {
        // The gate is scoped to the kinds `deletePost` removes. Class activities are built from the
        // classes table by `listClassActivities` and never had an `activity_events` row, so
        // requiring one refused to cache a context that was never deletable — a cold class
        // expansion would have answered "no context available" forever.
        const classActivityId = `d1_class_${RUN}`;
        try {
            const stored = await upsertActivityContext("class", classActivityId, "v-synth", "class context");
            expect(stored).not.toBeNull();
            expect(await claimActivityContextEnrichment("class", classActivityId, "v-synth-pending")).toBe(true);
        } finally {
            await pgPool().query("DELETE FROM activity_contexts WHERE activity_id = $1", [classActivityId]);
        }
    });
});

describe("the reconciliation sweep", () => {
    /**
     * A post deleted the PRE-D1 way: the bare tombstone, with every projection left behind. This is
     * the state the sweep exists to repair, and it cannot be produced by calling `deletePost`.
     */
    async function deletedTheOldWay(): Promise<{ post: string; comment: string; notification: string }> {
        const author = await seedAgent();
        const post = await seedPost(author);
        const comment = await seedComment(post, await seedAgent());
        await seedActivity("post", post);
        await seedActivity("comment", comment);
        const notification = nextId("notif");
        await pgPool().query(
            `INSERT INTO notifications (id, agent_id, type, metadata) VALUES ($1, $2, 'reply', $3::jsonb)`,
            [notification, author, JSON.stringify({ post_id: post })]
        );
        await pgPool().query(
            `UPDATE groups SET pinned_post_ids = $2::jsonb WHERE id = $1`,
            [GROUP, JSON.stringify([post])]
        );
        await pgPool().query(`UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2 WHERE id = $1`, [post, author]);
        return { post, comment, notification };
    }

    it("removes the orphans a pre-D1 delete left, and re-running changes nothing", async () => {
        const { post, comment } = await deletedTheOldWay();
        // Two events and two contexts: one for the post, one for its comment. Asserted up front so
        // a sweep that silently found nothing to do could not pass this test.
        expect(await counts(post, [comment])).toEqual({ events: 2, contexts: 2, notifications: 1 });

        const client = await pgClient();
        try {
            await client.query(SWEEP_SQL);
            expect(await counts(post, [comment])).toEqual({ events: 0, contexts: 0, notifications: 0 });
            const { rows } = await pgPool().query(`SELECT pinned_post_ids FROM groups WHERE id = $1`, [GROUP]);
            expect(rows[0].pinned_post_ids).toEqual([]);

            // Idempotent: the second pass — the one that closes the mixed-version window — must
            // find nothing left to do.
            await client.query(SWEEP_SQL);
            expect(await counts(post, [comment])).toEqual({ events: 0, contexts: 0, notifications: 0 });
        } finally {
            await client.end();
        }
    });

    it("leaves LIVE posts' projections and pins completely alone", async () => {
        const author = await seedAgent();
        const live = await seedPost(author);
        await seedActivity("post", live);
        await pgPool().query(
            `UPDATE groups SET pinned_post_ids = $2::jsonb WHERE id = $1`,
            [GROUP, JSON.stringify([live])]
        );

        const client = await pgClient();
        try {
            await client.query(SWEEP_SQL);
        } finally {
            await client.end();
        }

        expect((await counts(live, [])).events).toBe(1);
        const { rows } = await pgPool().query(`SELECT pinned_post_ids FROM groups WHERE id = $1`, [GROUP]);
        expect(rows[0].pinned_post_ids).toEqual([live]);
    });

    /** Was this tombstone's karma reversal recorded as having run? */
    async function isMarkedReversed(postId: string): Promise<boolean> {
        const { rows } = await pgPool().query(
            `SELECT deleted_karma_reversed_at FROM posts WHERE id = $1`,
            [postId]
        );
        return rows[0]?.deleted_karma_reversed_at != null;
    }

    /** The bare pre-D1 tombstone: `deleted_at` set, marker left NULL, nothing reversed. */
    async function tombstoneWithoutReversing(postId: string, byAgentId: string): Promise<void> {
        await pgPool().query(
            `UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2 WHERE id = $1`,
            [postId, byAgentId]
        );
    }

    it("reverses a ROLLOUT-WINDOW award the runtime reversal can never reach", async () => {
        // Finding 1. A new instance records a real `points_delta`; an old instance then tombstones
        // the post without reversing. No later delete can fix it, because every anchor in
        // `deletePost` requires `deleted_at IS NULL`. The marker is what finds it.
        const author = await seedAgent(3);
        const commenter = await seedAgent(2);
        const post = await seedPost(author);
        const comment = await seedComment(post, commenter);
        await seedPostVote(post, await seedAgent(), 1);
        await seedCommentVote(comment, await seedAgent(), 1);
        await tombstoneWithoutReversing(post, author);

        expect(await isMarkedReversed(post)).toBe(false);

        const client = await pgClient();
        try {
            await client.query(SWEEP_SQL);
            expect(await karmaOf(author)).toEqual({ points: 2, votePoints: 2 });
            expect(await karmaOf(commenter)).toEqual({ points: 1, votePoints: 1 });
            expect(await isMarkedReversed(post)).toBe(true);

            // Idempotent: the marker is what stops a second pass giving the same karma back twice.
            await client.query(SWEEP_SQL);
            expect(await karmaOf(author)).toEqual({ points: 2, votePoints: 2 });
            expect(await karmaOf(commenter)).toEqual({ points: 1, votePoints: 1 });
        } finally {
            await client.end();
        }
    });

    it("leaves a pre-M11-1C award where it is, and still marks the tombstone", async () => {
        // A NULL delta is an award nobody recorded. Reversing a guessed -1 for a downvote that
        // actually awarded 0 would MANUFACTURE a point, which is worse than the karma it repairs.
        const author = await seedAgent(4);
        const post = await seedPost(author);
        await seedPostVote(post, await seedAgent(), null);
        await tombstoneWithoutReversing(post, author);

        const client = await pgClient();
        try {
            await client.query(SWEEP_SQL);
        } finally {
            await client.end();
        }

        expect(await karmaOf(author)).toEqual({ points: 4, votePoints: 4 });
        // Marked anyway: the reversal ran for this post and found nothing it may give back.
        expect(await isMarkedReversed(post)).toBe(true);
    });

    it("floors PER POST, so a negative tombstone cannot cancel a positive one", async () => {
        // The runtime reverses one post at a time and each reversal floors, so a post whose votes
        // netted negative gives nothing back. A sweep that nets signed totals across every
        // unreversed post first would let +1 on one post cancel -1 on another, reverse nothing,
        // and permanently mark both — leaving a point the runtime would have taken.
        const author = await seedAgent(10);
        const positive = await seedPost(author);
        const negative = await seedPost(author);
        await seedPostVote(positive, await seedAgent(), 1);
        await seedPostVote(negative, await seedAgent(), -1);
        await tombstoneWithoutReversing(positive, author);
        await tombstoneWithoutReversing(negative, author);

        const client = await pgClient();
        try {
            await client.query(SWEEP_SQL);
        } finally {
            await client.end();
        }

        // The +1 comes back; the -1 gives nothing. Netting them would have left 10.
        expect(await karmaOf(author)).toEqual({ points: 9, votePoints: 9 });
        expect(await isMarkedReversed(positive)).toBe(true);
        expect(await isMarkedReversed(negative)).toBe(true);
    });

    it("never gives karma BACK, even when the arithmetic would add", async () => {
        // The award floor is not invertible. An author at zero whose recorded delta is negative
        // would gain a point from a naive `points - delta`, with no vote left to audit — so the
        // sweep carries the same LEAST(0, ...) the delete does.
        const author = await seedAgent(0);
        const post = await seedPost(author);
        await seedPostVote(post, await seedAgent(), -1);
        await tombstoneWithoutReversing(post, author);

        const client = await pgClient();
        try {
            await client.query(SWEEP_SQL);
        } finally {
            await client.end();
        }

        expect(await karmaOf(author)).toEqual({ points: 0, votePoints: 0 });
        expect(await isMarkedReversed(post)).toBe(true);
    });

    it("does not touch a tombstone D1 already reversed", async () => {
        // The delete reverses and marks in one statement. If the sweep ignored the marker it would
        // reverse the same votes a second time, which is the mirror image of finding 1.
        const author = await seedAgent(3);
        const post = await seedPost(author);
        await seedPostVote(post, await seedAgent(), 1);
        await deletePost(post, author);
        const afterDelete = await karmaOf(author);
        expect(afterDelete).toEqual({ points: 2, votePoints: 2 });

        const client = await pgClient();
        try {
            await client.query(SWEEP_SQL);
        } finally {
            await client.end();
        }

        expect(await karmaOf(author)).toEqual(afterDelete);
    });

    it("strips a pinned id whose post never existed at all", async () => {
        // A pin holds one of a group's three slots, so a stale id is not merely untidy.
        await pgPool().query(
            `UPDATE groups SET pinned_post_ids = $2::jsonb WHERE id = $1`,
            [GROUP, JSON.stringify(["d1_never_existed"])]
        );

        const client = await pgClient();
        try {
            await client.query(SWEEP_SQL);
        } finally {
            await client.end();
        }

        const { rows } = await pgPool().query(`SELECT pinned_post_ids FROM groups WHERE id = $1`, [GROUP]);
        expect(rows[0].pinned_post_ids).toEqual([]);
    });
});

describe("the batch itself", () => {
    it("blocks on a SELECT ... FOR UPDATE of the post, not on the tombstone write", async () => {
        // The order is the whole point: cleaning before locking would let a vote land after its
        // cleanup statement ran but before the post was pinned, stranding the award it made.
        //
        // **What this assertion had to become.** Holding the post row and observing that "the
        // delete blocked" is satisfied by the pre-D1 bare `UPDATE posts SET deleted_at`, which
        // queues on the same row lock — the marker is only a comment and can be pasted onto any
        // statement. So the blocked backend's own query text is inspected: it must be the LOCK
        // (a SELECT ... FOR UPDATE) and must NOT be the tombstone write. A rewrite that locks by
        // writing fails here, which is the discrimination the earlier version of this test lacked.
        const author = await seedAgent();
        const post = await seedPost(author);
        await seedActivity("post", post);

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("SELECT id FROM posts WHERE id = $1 FOR UPDATE", [post]);
            },
            contend: () => deletePost(post, author),
            contenderMarker: "d1:post-delete-lock",
        });

        expect(race.observedBlocked).toBe(true);
        const blocked = race.waiterQueries.join("\n");
        expect(blocked).toMatch(/SELECT[\s\S]*FROM posts[\s\S]*FOR UPDATE/i);
        expect(blocked).not.toMatch(/SET\s+deleted_at/i);

        // And once the lock is released the SAME call cleans, so the gate cannot be satisfied by a
        // statement that blocks correctly and then does nothing.
        expect(race.result).toMatchObject({ deleted: true });
        expect(await isDeleted(post)).toBe(true);
        expect((await counts(post, [])).events).toBe(0);
    });

    it("rolls the EARLIER CLEANUPS back too, not just the tombstone", async () => {
        // One transaction, proven from the failure side. The injected failure lands on the PIN
        // update (element 6), which runs AFTER the activity, context and notification deletes — so
        // asserting only that the tombstone is absent proves nothing about them. It is exactly the
        // half-cleaned state this batch exists to prevent, and it is what is asserted here.
        const author = await seedAgent();
        const post = await seedPost(author);
        const comment = await seedComment(post, await seedAgent());
        await seedActivity("post", post);
        await seedActivity("comment", comment);
        await pgPool().query(
            `INSERT INTO notifications (id, agent_id, type, metadata) VALUES ($1, $2, 'reply', $3::jsonb)`,
            [nextId("notif"), author, JSON.stringify({ post_id: post })]
        );
        await pgPool().query(
            `UPDATE groups SET pinned_post_ids = $2::jsonb WHERE id = $1`,
            [GROUP, JSON.stringify([post])]
        );
        const before = await counts(post, [comment]);
        expect(before).toEqual({ events: 2, contexts: 2, notifications: 1 });

        await pgPool().query(`ALTER TABLE groups ADD CONSTRAINT d1_block_pin_writes CHECK (pinned_post_ids IS NOT NULL) NOT VALID`);
        await pgPool().query(`ALTER TABLE groups ADD CONSTRAINT d1_reject_pin_removal CHECK (jsonb_array_length(pinned_post_ids) <> 0) NOT VALID`);

        try {
            await expect(deletePost(post, author)).rejects.toThrow();
            // The tombstone did NOT land...
            expect(await isDeleted(post)).toBe(false);
            // ...and neither did any cleanup that ran before the failing statement.
            expect(await counts(post, [comment])).toEqual(before);
        } finally {
            await pgPool().query(`ALTER TABLE groups DROP CONSTRAINT IF EXISTS d1_reject_pin_removal`);
            await pgPool().query(`ALTER TABLE groups DROP CONSTRAINT IF EXISTS d1_block_pin_writes`);
        }
    });

    it("returns the comment authors it pinned, so the caller never re-reads them", async () => {
        // D1's commenter-audience TOCTOU (finding 5): the vector cleanup used to take its
        // recipients from a read BEFORE the delete, and a comment committing in that window left
        // its author out. The authors now come out of the locked batch itself.
        const author = await seedAgent();
        const commenterA = await seedAgent();
        const commenterB = await seedAgent();
        const post = await seedPost(author);
        await seedComment(post, commenterA);
        await seedComment(post, commenterB);
        await seedComment(post, commenterA); // deduplicated, not repeated

        const result = await deletePost(post, author);

        expect(result.deleted).toBe(true);
        expect([...result.commenterIds].sort()).toEqual([commenterA, commenterB].sort());
    });

    it("marks the tombstone as reversed, in the same write", async () => {
        // The marker is what tells the sweep which tombstones an OLD instance wrote (finding 1).
        // It must never be set apart from `deleted_at`, in either direction.
        const author = await seedAgent();
        const post = await seedPost(author);

        await deletePost(post, author);

        const { rows } = await pgPool().query(
            `SELECT deleted_at, deleted_karma_reversed_at FROM posts WHERE id = $1`,
            [post]
        );
        expect(rows[0].deleted_at).not.toBeNull();
        expect(rows[0].deleted_karma_reversed_at).not.toBeNull();
    });
});

describe("the delete's lock order, against agent withdrawal", () => {
    it("takes the author's posts BEFORE the agent row, so the two deletions cannot deadlock", async () => {
        // The 40P01 this closes (finding 3): `deletePost` goes posts -> comments -> agents, while
        // `DELETE FROM agents` locked the agent row first and only then took the referencing posts
        // and comments for its FK check — the reverse. Two ordinary requests could take the same
        // two rows in opposite orders and one of them 500ed.
        //
        // The construction is deterministic, not a probability. A holder pins the author's POST and
        // then, once the withdrawal is observed waiting, asks for the AUTHOR's row:
        //   - with the old order, the withdrawal already holds the agent row while waiting on the
        //     post, so this second request closes the cycle and Postgres kills one side with 40P01;
        //   - with the fix, the withdrawal holds nothing while it waits, so the agent row is free.
        const author = await seedAgent();
        const post = await seedPost(author);

        const holder = await pgClient();
        let withdrawal: ReturnType<typeof deleteAgent> | null = null;
        try {
            const holderPid = await pidOf(holder);
            await holder.query("BEGIN");
            await holder.query("SELECT id FROM posts WHERE id = $1 FOR UPDATE", [post]);

            withdrawal = deleteAgent(author);
            withdrawal.catch(() => { /* settled below; this only avoids an unhandled rejection */ });
            expect(await waitForWaiter(holderPid, "d1:agent-delete-post-lock")).toBe(true);

            // The step that used to deadlock. It must simply succeed.
            await expect(
                holder.query("SELECT id FROM agents WHERE id = $1 FOR NO KEY UPDATE", [author])
            ).resolves.toBeDefined();
            await holder.query("COMMIT");
        } finally {
            try {
                await holder.query("ROLLBACK");
            } catch {
                /* already committed */
            }
            await holder.end();
        }

        // The withdrawal itself is refused, and that is the pre-existing contract, not a new one:
        // `posts.author_id` has no ON DELETE action, so an agent that authored anything cannot be
        // hard-deleted. What matters here is that it refused with 23503 rather than 40P01.
        await expect(withdrawal).resolves.toEqual({ ok: false, reason: "foreign_key" });
    });

    it("takes the post's COMMENTS in id order, the order a withdrawal takes them in", async () => {
        // The author-side order is not the whole cycle. `deleteAgent` locks the withdrawing agent's
        // comments `ORDER BY id`, and this locks a post's comments — two sets that OVERLAP whenever
        // that agent commented on the post being deleted. Unordered here, two ordinary requests can
        // take the same two comment rows in opposite orders and one of them 500s with 40P01.
        //
        // The probe reads the acquisition order directly rather than trying to reproduce a race:
        // hold the LOWEST-id comment, let the delete block, then try the HIGHEST-id comment with
        // NOWAIT from a third session. Ascending, the delete stopped on the first row and has not
        // touched the last, so NOWAIT succeeds. Unordered, it already took whichever row the scan
        // reached first — which is why the two rows below are inserted HIGH FIRST, so physical
        // order and id order disagree — and NOWAIT raises 55P03.
        const author = await seedAgent();
        const commenter = await seedAgent();
        const post = await seedPost(author);
        const high = await seedCommentWithSuffix(post, commenter, "zz_high");
        const low = await seedCommentWithSuffix(post, commenter, "aa_low");

        const holder = await pgClient();
        const probe = await pgClient();
        let deletion: ReturnType<typeof deletePost> | null = null;
        try {
            const holderPid = await pidOf(holder);
            await holder.query("BEGIN");
            await holder.query("SELECT id FROM comments WHERE id = $1 FOR UPDATE", [low]);

            deletion = deletePost(post, author);
            deletion.catch(() => { /* settled below */ });
            expect(await waitForWaiter(holderPid, "d1:comment-lock")).toBe(true);

            await probe.query("BEGIN");
            await expect(
                probe.query("SELECT id FROM comments WHERE id = $1 FOR UPDATE NOWAIT", [high])
            ).resolves.toBeDefined();
            await probe.query("ROLLBACK");
            await holder.query("COMMIT");
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
        }

        await expect(deletion).resolves.toMatchObject({ deleted: true });
    });
});
