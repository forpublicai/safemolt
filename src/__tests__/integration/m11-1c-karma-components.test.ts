/**
 * M11-1C `[integration]` — component karma against a real Postgres.
 *
 * The memory-store half of these guarantees is in
 * `src/__tests__/lib/store/karma-components.test.ts`. This file covers what only a database can
 * show: the migration, the atomic vote statement, the row lock at the floor boundary, and the
 * mixed-version rollout window.
 *
 * Every assertion checks **components AND total after each step**, never only the final state — a
 * final-state assertion lets a later step repair an earlier error and go green.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { neonSql, pgPool, pgClient, closeIntegrationConnections } from "./helpers/db";
import { raceAgainstHeldLock, rejections, runConcurrently } from "./helpers/concurrency";
import { downvotePost, isUniqueViolation, upvotePost, recordVote } from "@/lib/store/posts/db";
import { upvoteComment } from "@/lib/store/comments/db";
import { saveEvaluationResult, updateAgentPointsFromEvaluations } from "@/lib/store/evaluations/db";
import { createAgent } from "@/lib/store/agents/db";
import { asDbComponents, KARMA_PARITY } from "@/__tests__/helpers/karma-parity";

const sql = neonSql();

const SCRIPTS = join(__dirname, "..", "..", "..", "scripts");
const MIGRATION_SQL = readFileSync(join(SCRIPTS, "migrate-agent-karma-components.sql"), "utf8");
const RECONCILE_SQL = readFileSync(join(SCRIPTS, "reconcile-karma-components.sql"), "utf8");

const GROUP = "m11c_group";
const PREFIX = "m11c_";

let seq = 0;
const nextId = (kind: string) => `${PREFIX}${kind}_${(seq += 1)}`;

interface Components {
    points: number;
    vote_points: number;
    evaluation_points: number;
    legacy_unattributed_points: number;
}

async function seedAgent(options: Partial<Components> = {}): Promise<string> {
    const id = nextId("agent");
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                             legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
         VALUES ($1, $2, '', $3, $4, $5, $6, $7, 0, false, NOW(), true)`,
        [
            id,
            `m11c agent ${id}`,
            `m11c_key_${id}`,
            options.points ?? 0,
            options.vote_points ?? 0,
            options.evaluation_points ?? 0,
            options.legacy_unattributed_points ?? 0,
        ]
    );
    return id;
}

async function seedPost(authorId: string): Promise<string> {
    const id = nextId("post");
    await pgPool().query(
        `INSERT INTO posts (id, group_id, author_id, title, content, upvotes, downvotes, comment_count, created_at)
         VALUES ($1, $2, $3, 'karma probe', 'body', 0, 0, 0, NOW())`,
        [id, GROUP, authorId]
    );
    return id;
}

async function seedComment(postId: string, authorId: string): Promise<string> {
    const id = nextId("comment");
    await pgPool().query(
        `INSERT INTO comments (id, post_id, author_id, content, upvotes, created_at)
         VALUES ($1, $2, $3, 'karma probe', 0, NOW())`,
        [id, postId, authorId]
    );
    return id;
}

/** A passed evaluation result. `evaluation_results` is what the recompute reads. */
async function seedPassedResult(agentId: string, evaluationId: string, points: number): Promise<void> {
    const registrationId = nextId("reg");
    const resultId = nextId("res");
    // `evaluation_registrations.evaluation_id` and `evaluation_results.evaluation_id` both
    // reference `evaluation_definitions`, so the definition has to exist first.
    await pgPool().query(
        `INSERT INTO evaluation_definitions
           (id, sip_number, name, module, type, status, file_path, executable_handler,
            executable_script_path, version, created_at, updated_at)
         VALUES ($1, $2, $1, 'core', 'simple_pass_fail', 'active', 'x', 'x', 'x', '1.0.0', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [evaluationId, 9300 + (seq += 1)]
    );
    await pgPool().query(
        `INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status, completed_at)
         VALUES ($1, $2, $3, NOW(), 'completed', NOW())`,
        [registrationId, agentId, evaluationId]
    );
    await pgPool().query(
        `INSERT INTO evaluation_results (id, registration_id, agent_id, evaluation_id, passed, completed_at, points_earned)
         VALUES ($1, $2, $3, $4, true, NOW(), $5)`,
        [resultId, registrationId, agentId, evaluationId, points]
    );
}

/**
 * An ACTIONABLE registration and its definition, so a test can drive the real `saveEvaluationResult`
 * rather than hand-inserting a result row. `seedPassedResult` above writes history; this sets up a
 * completion that has not happened yet.
 */
async function seedRegistration(agentId: string, evaluationId: string): Promise<string> {
    const registrationId = nextId("reg");
    await pgPool().query(
        `INSERT INTO evaluation_definitions
           (id, sip_number, name, module, type, status, file_path, executable_handler,
            executable_script_path, version, created_at, updated_at)
         VALUES ($1, $2, $1, 'core', 'simple_pass_fail', 'active', 'x', 'x', 'x', '1.0.0', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [evaluationId, 9400 + (seq += 1)]
    );
    await pgPool().query(
        `INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status)
         VALUES ($1, $2, $3, NOW(), 'registered')`,
        [registrationId, agentId, evaluationId]
    );
    return registrationId;
}

async function components(agentId: string): Promise<Components> {
    const { rows } = await pgPool().query<Record<keyof Components, string>>(
        `SELECT points, vote_points, evaluation_points, legacy_unattributed_points
         FROM agents WHERE id = $1`,
        [agentId]
    );
    const r = rows[0];
    return {
        points: Number(r.points),
        vote_points: Number(r.vote_points),
        evaluation_points: Number(r.evaluation_points),
        legacy_unattributed_points: Number(r.legacy_unattributed_points),
    };
}

/**
 * How many of THIS suite's agents break the invariant. Must always be 0.
 *
 * Scoped to the prefix on purpose. The harness database is shared across suites in one `runInBand`
 * pass and rows survive between runs, and some suites write `points` directly as a fixture —
 * `c21-result-uniqueness.test.ts` does `UPDATE agents SET points = 7` to set up a scenario whose
 * subject is C21, not this invariant. A table-wide count would fail here for their reasons.
 */
async function driftedRowCount(): Promise<number> {
    const { rows } = await pgPool().query<{ n: string }>(
        `SELECT count(*) AS n FROM agents
         WHERE id LIKE $1
           AND points <> legacy_unattributed_points + vote_points + evaluation_points`,
        [`${PREFIX}%`]
    );
    return Number(rows[0].n);
}

async function postVoteRow(agentId: string, postId: string) {
    const { rows } = await pgPool().query<{ vote_type: number; points_delta: string | null }>(
        `SELECT vote_type, points_delta FROM post_votes WHERE agent_id = $1 AND post_id = $2`,
        [agentId, postId]
    );
    return rows[0] ?? null;
}

async function postCounters(postId: string) {
    const { rows } = await pgPool().query<{ upvotes: number; downvotes: number }>(
        `SELECT upvotes, downvotes FROM posts WHERE id = $1`,
        [postId]
    );
    return rows[0];
}

/**
 * Remove everything this suite has ever written, in dependency order.
 *
 * Runs before the fixtures rather than only after them: the harness database persists between
 * runs, ids here are deterministic (`m11c_agent_1`, …), and a suite that only cleaned up at the end
 * would collide with its own previous run's rows the moment one run was interrupted.
 */
async function purgeSuiteRows(): Promise<void> {
    const like = `${PREFIX}%`;
    const statements: Array<[string, unknown[]]> = [
        [`DELETE FROM comment_votes WHERE agent_id LIKE $1 OR comment_id LIKE $1`, [like]],
        [`DELETE FROM post_votes WHERE agent_id LIKE $1 OR post_id LIKE $1`, [like]],
        [`DELETE FROM comments WHERE id LIKE $1 OR author_id LIKE $1`, [like]],
        [`DELETE FROM posts WHERE id LIKE $1 OR author_id LIKE $1`, [like]],
        [`DELETE FROM activity_events WHERE actor_id LIKE $1 OR entity_id LIKE $1`, [like]],
        [`DELETE FROM notifications WHERE agent_id LIKE $1`, [like]],
        [`DELETE FROM evaluation_results WHERE id LIKE $1 OR agent_id LIKE $1`, [like]],
        [`DELETE FROM evaluation_registrations WHERE id LIKE $1 OR agent_id LIKE $1`, [like]],
        [`DELETE FROM evaluation_definitions WHERE id LIKE 'm11c-eval-%'`, []],
        [`DELETE FROM vetting_challenges WHERE id LIKE $1 OR agent_id LIKE $1`, [like]],
        [`DELETE FROM agent_rate_limits WHERE agent_id LIKE $1`, [like]],
        [`DELETE FROM group_members WHERE agent_id LIKE $1 OR group_id LIKE $1`, [like]],
        [`DELETE FROM groups WHERE id LIKE $1 OR owner_id LIKE $1`, [like]],
        // By NAME as well as id: `createAgent` mints its own `agent_…` id, so the id filter alone
        // leaves its row behind and the next run collides on the unique name.
        [`DELETE FROM agents WHERE id LIKE $1 OR name LIKE $1`, [like]],
    ];
    for (const [text, values] of statements) {
        await pgPool().query(text, values);
    }
}

beforeAll(async () => {
    await purgeSuiteRows();
    const owner = await seedAgent();
    await pgPool().query(
        `INSERT INTO groups (id, name, display_name, description, owner_id, created_at)
         VALUES ($1, 'm11cgroup', 'M11C Group', '', $2, NOW())`,
        [GROUP, owner]
    );
});

afterAll(async () => {
    await purgeSuiteRows();
    await closeIntegrationConnections();
});

describe("the migration", () => {
    it("is idempotent against the database, not merely skipped by the runner", async () => {
        // The C1 lesson, already in `agents.md`: re-running `migrate.js` only skips a recorded
        // filename and proves nothing about the SQL. This executes the file itself, twice, and
        // asserts the second run changes no displayed total.
        const voteOnly = await seedAgent({ points: 4, vote_points: 4 });
        const evalOnly = await seedAgent({ points: 6, evaluation_points: 6 });
        await seedPassedResult(evalOnly, "m11c-eval-idem", 6);

        const client = await pgClient();
        try {
            await client.query(MIGRATION_SQL);
            const afterFirst = {
                voteOnly: await components(voteOnly),
                evalOnly: await components(evalOnly),
            };

            await client.query(MIGRATION_SQL);
            expect({
                voteOnly: await components(voteOnly),
                evalOnly: await components(evalOnly),
            }).toEqual(afterFirst);
        } finally {
            await client.end();
        }

        expect(await driftedRowCount()).toBe(0);
    });

    it("postcondition REJECTS a component column of the wrong precision", async () => {
        // A guard that has never been seen to fire is not evidence of anything. `ADD COLUMN IF NOT
        // EXISTS` is a no-op against a column that already exists in the wrong shape, so the
        // postcondition is the only thing standing between a hand-created
        // `evaluation_points NUMERIC(5,0)` and an invariant that breaks on the first fractional
        // evaluation — 0.5 points would store as 1 in the component and 0.5 in `points`.
        //
        // Done inside a transaction that always rolls back, so the harness schema is unchanged.
        const client = await pgClient();
        try {
            await client.query("BEGIN");
            await client.query("ALTER TABLE agents ALTER COLUMN evaluation_points TYPE NUMERIC(5,0)");
            await expect(client.query(MIGRATION_SQL)).rejects.toThrow(
                /M11-1C postcondition failed: missing agents\.evaluation_points/
            );
        } finally {
            await client.query("ROLLBACK").catch(() => undefined);
            await client.end();
        }

        // And the real schema is untouched: the migration still passes against it.
        const verify = await pgClient();
        try {
            await verify.query(MIGRATION_SQL);
        } finally {
            await verify.end();
        }
    });

    it("postcondition REJECTS a points_delta column that was given a default", async () => {
        // NULL is the record for a pre-M11-1C vote whose award is unknowable. A default of 0 would
        // claim every such vote awarded nothing, and M11-1b D1 would reverse on that claim.
        const client = await pgClient();
        try {
            await client.query("BEGIN");
            await client.query("ALTER TABLE post_votes ALTER COLUMN points_delta SET DEFAULT 0");
            await expect(client.query(MIGRATION_SQL)).rejects.toThrow(
                /M11-1C postcondition failed: missing post_votes\.points_delta/
            );
        } finally {
            await client.query("ROLLBACK").catch(() => undefined);
            await client.end();
        }
    });

    it("preserves every displayed total across vote-only, evaluation-only, mixed, floored and empty agents", async () => {
        // The backfill's whole promise. Each case is seeded as PRE-migration state — `points`
        // carrying the total with the components still at zero — and the assertion is that no
        // agent's displayed karma moved while the credit got attributed.
        const cases = {
            voteOnly: { seed: { points: 5 }, evaluations: [] as number[], expect: { points: 5, vote_points: 0, evaluation_points: 0, legacy_unattributed_points: 5 } },
            evaluationOnly: { seed: { points: 10 }, evaluations: [10], expect: { points: 10, vote_points: 0, evaluation_points: 10, legacy_unattributed_points: 0 } },
            mixed: { seed: { points: 12 }, evaluations: [7], expect: { points: 12, vote_points: 0, evaluation_points: 7, legacy_unattributed_points: 5 } },
            // Floored to zero: the honest record is a NEGATIVE legacy — credit earned and then
            // lost to downvotes that floored. Any formula that clamped it here would have to
            // invent karma to make the total add up.
            flooredToZero: { seed: { points: 0 }, evaluations: [15], expect: { points: 0, vote_points: 0, evaluation_points: 15, legacy_unattributed_points: -15 } },
            empty: { seed: { points: 0 }, evaluations: [], expect: { points: 0, vote_points: 0, evaluation_points: 0, legacy_unattributed_points: 0 } },
        };

        const ids: Record<string, string> = {};
        for (const [label, spec] of Object.entries(cases)) {
            const id = await seedAgent(spec.seed);
            ids[label] = id;
            for (const points of spec.evaluations) {
                await seedPassedResult(id, `m11c-eval-${label}`, points);
            }
        }

        const client = await pgClient();
        try {
            await client.query(MIGRATION_SQL);
        } finally {
            await client.end();
        }

        for (const [label, spec] of Object.entries(cases)) {
            expect([label, await components(ids[label])]).toEqual([label, spec.expect]);
        }
        expect(await driftedRowCount()).toBe(0);
    });
});

describe("the oscillation — the headline", () => {
    it("keeps vote and evaluation credit through upvote → evaluation pass → upvote", async () => {
        // Fails on pre-M11-1C code: the evaluation's absolute overwrite discards the first upvote.
        //
        // Expectations come from the SHARED parity table that the memory-store suite asserts
        // against too, so "both stores agree" is enforced by construction rather than by eye.
        const expected = KARMA_PARITY.oscillation;
        const author = await seedAgent();
        const post = await seedPost(author);
        const v1 = await seedAgent();
        const v2 = await seedAgent();

        expect(await upvotePost(post, v1)).toBe(true);
        expect(await components(author)).toEqual(asDbComponents(expected.afterFirstUpvote));

        await seedPassedResult(author, "m11c-eval-osc", expected.evaluationPointsAwarded);
        await updateAgentPointsFromEvaluations(author);
        expect(await components(author)).toEqual(asDbComponents(expected.afterEvaluation));

        expect(await upvotePost(post, v2)).toBe(true);
        expect(await components(author)).toEqual(asDbComponents(expected.afterSecondUpvote));
        expect(await driftedRowCount()).toBe(0);
    });
});

describe("createAgent initialises all three", () => {
    it("starts a brand-new agent at zero on every component, and the first upvote yields 1", async () => {
        // The db store has column defaults, but `createAgent` names the components explicitly so
        // this site stays inside the writer inventory and stays literally parallel with the memory
        // store — which has no defaults to fall back on.
        const created = await createAgent(`${PREFIX}created_${(seq += 1)}`, "component probe");
        expect({
            points: created.points,
            vote_points: created.votePoints,
            evaluation_points: created.evaluationPoints,
            legacy_unattributed_points: created.legacyUnattributedPoints,
        }).toEqual(asDbComponents(KARMA_PARITY.freshAgent));
        expect(await components(created.id)).toEqual(asDbComponents(KARMA_PARITY.freshAgent));

        const post = await seedPost(created.id);
        const voter = await seedAgent();
        expect(await upvotePost(post, voter)).toBe(true);
        expect(await components(created.id)).toEqual(asDbComponents(KARMA_PARITY.oscillation.afterFirstUpvote));
    });
});

describe("the recorded delta matches the award", () => {
    it("records 1 for an upvote and moves both points and vote_points", async () => {
        const author = await seedAgent();
        const post = await seedPost(author);
        const voter = await seedAgent();

        expect(await upvotePost(post, voter)).toBe(true);
        expect(await postVoteRow(voter, post)).toEqual({ vote_type: 1, points_delta: "1.00" });
        expect(await components(author)).toEqual(asDbComponents(KARMA_PARITY.oscillation.afterFirstUpvote));
    });

    it("records 0 for a downvote against an agent at zero, and moves neither", async () => {
        // OQ-1's exact case. The write floors, so this vote awarded 0 — reversing it by adding 1
        // back would MINT a point.
        const author = await seedAgent();
        const post = await seedPost(author);
        const voter = await seedAgent();

        expect(await downvotePost(post, voter)).toBe(true);
        expect(await postVoteRow(voter, post)).toEqual({
            vote_type: -1,
            points_delta: KARMA_PARITY.flooredDownvoteAtZero.award.toFixed(2),
        });
        expect(await components(author)).toEqual(asDbComponents(KARMA_PARITY.flooredDownvoteAtZero.after));
        // The counter still moved: the vote happened, it just awarded nothing.
        expect((await postCounters(post)).downvotes).toBe(1);
    });

    it("records -1 for a downvote that actually takes a point", async () => {
        const author = await seedAgent();
        const post = await seedPost(author);
        const up = await seedAgent();
        const down = await seedAgent();

        await upvotePost(post, up);
        await downvotePost(post, down);

        expect((await postVoteRow(down, post))?.points_delta).toBe(
            KARMA_PARITY.downvoteAfterUpvote.award.toFixed(2)
        );
        expect(await components(author)).toEqual(asDbComponents(KARMA_PARITY.downvoteAfterUpvote.after));
    });

    it("records the comment upvote's delta against comment_votes", async () => {
        const author = await seedAgent();
        const post = await seedPost(author);
        const comment = await seedComment(post, author);
        const voter = await seedAgent();

        expect(await upvoteComment(comment, voter)).toBe(true);
        const { rows } = await pgPool().query<{ points_delta: string | null }>(
            `SELECT points_delta FROM comment_votes WHERE agent_id = $1 AND comment_id = $2`,
            [voter, comment]
        );
        expect(rows[0].points_delta).toBe(KARMA_PARITY.commentUpvote.award.toFixed(2));
        expect(await components(author)).toEqual(asDbComponents(KARMA_PARITY.commentUpvote.after));
    });

    it("leaves points_delta NULL on a bare recordVote, and on rows written before this chunk", async () => {
        // Companion coverage, not a discriminating gate: pre-M11-1C `recordVote` had no
        // `points_delta` column to write, so it also produced NULL. What this pins is that the
        // column was NOT given a default and that M11-1b D1 has an unambiguous "not reversible"
        // marker — the migration postcondition above is what would fail if a default appeared.
        //
        // NULL is the honest record for a vote whose award is unknowable. `recordVote` awards
        // nothing, so it writes NULL too rather than claiming the vote was weighed and worth 0.
        const author = await seedAgent();
        const post = await seedPost(author);
        const bare = await seedAgent();
        const legacy = await seedAgent();

        expect(await recordVote(bare, post, 1, "post")).toBe(true);
        expect((await postVoteRow(bare, post))?.points_delta).toBeNull();

        // A pre-M11-1C row, written the way the old code did — without the column.
        await pgPool().query(
            `INSERT INTO post_votes (agent_id, post_id, vote_type, voted_at) VALUES ($1, $2, 1, NOW())`,
            [legacy, post]
        );
        expect((await postVoteRow(legacy, post))?.points_delta).toBeNull();
    });
});

describe("atomicity", () => {
    it("leaves no counter change, no vote row and no award when the post is already a tombstone", async () => {
        // Companion coverage, not a discriminating gate. The post is dead before the call, so the
        // pre-M11-1C code also passed this — its own liveness read returned nothing. It also cannot
        // see the difference the single statement makes: restoring the old
        // record-vote / count / compensate-on-failure sequence would reach the same final state.
        // The interleaving case is the test below, and the crash window between the vote row and
        // the award is what only the single statement closes.
        const author = await seedAgent();
        const post = await seedPost(author);
        const voter = await seedAgent();
        await pgPool().query(`UPDATE posts SET deleted_at = NOW() WHERE id = $1`, [post]);

        expect(await upvotePost(post, voter)).toBe(false);
        expect(await postVoteRow(voter, post)).toBeNull();
        expect(await postCounters(post)).toEqual({ upvotes: 0, downvotes: 0 });
        expect(await components(author)).toEqual({ points: 0, vote_points: 0, evaluation_points: 0, legacy_unattributed_points: 0 });
    });

    it("leaves nothing behind when the post is deleted DURING the vote — the real C25 race", async () => {
        // The interleaving the plan actually asks for, constructed rather than hoped for. The
        // holder opens a transaction, soft-deletes the post and keeps the row lock. The vote
        // statement's FIRST arm — `UPDATE posts … WHERE deleted_at IS NULL` — blocks on that lock.
        // When the holder commits, Read Committed makes the blocked update re-evaluate its
        // qualification against the NEWER row version, which now has `deleted_at` set, so it
        // matches zero rows and every other arm hangs off it: no counter, no vote row, no award.
        //
        // **What this does and does not prove, stated precisely.** The pre-M11-1C code reached the
        // same FINAL database state here: C25 had already made the counter decisive, so the blocked
        // increment matched zero rows, `removeVote` deleted the vote row it had already committed,
        // and the function returned before awarding. What changed is that no vote row is ever
        // written at all — there is nothing to compensate for, and therefore no window between the
        // write and the undo.
        //
        // So this is a REGRESSION gate for the new shape, not a discriminator against the old one:
        // it fails the moment someone moves the award or the vote insert ahead of `counted`, which
        // is the natural way to write this statement and the one the plan spends a paragraph
        // warning against.
        const author = await seedAgent();
        const post = await seedPost(author);
        const voter = await seedAgent();

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(`UPDATE posts SET deleted_at = NOW() WHERE id = $1`, [post]);
            },
            contend: () => upvotePost(post, voter),
            contenderMarker: "race:m11-1c-post-vote",
        });

        // It really did wait on the delete, from the catalog rather than from wall clock.
        expect(race.observedBlocked).toBe(true);
        expect(race.result).toBe(false);
        expect(await postVoteRow(voter, post)).toBeNull();
        expect(await postCounters(post)).toEqual({ upvotes: 0, downvotes: 0 });
        expect(await components(author)).toEqual({ points: 0, vote_points: 0, evaluation_points: 0, legacy_unattributed_points: 0 });
        expect(await driftedRowCount()).toBe(0);
    });

    it("blocks on an in-flight delete of the parent POST and then refuses — the comment vote", async () => {
        // The comment vote's parent check is a `FOR SHARE` lock, not a bare `EXISTS`. This is the
        // gate that tells them apart: an `EXISTS` subquery is evaluated against the statement
        // snapshot and is never re-checked, so with `EXISTS` this vote does NOT block — it commits
        // an upvote, a vote row and a karma award on a comment whose post is about to be a
        // tombstone, and `observedBlocked` would be false with `result` true.
        //
        // `createComment` in the same file already states the rule ("FOR SHARE, not EXISTS, because
        // an EXISTS guard reads the pre-delete snapshot"); this brings the vote path in line.
        const author = await seedAgent();
        const post = await seedPost(author);
        const comment = await seedComment(post, author);
        const voter = await seedAgent();

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(`UPDATE posts SET deleted_at = NOW() WHERE id = $1`, [post]);
            },
            contend: () => upvoteComment(comment, voter),
            contenderMarker: "race:m11-1c-comment-vote",
        });

        expect(race.observedBlocked).toBe(true);
        expect(race.result).toBe(false);

        const { rows: counter } = await pgPool().query<{ upvotes: number }>(
            `SELECT upvotes FROM comments WHERE id = $1`,
            [comment]
        );
        expect(counter[0].upvotes).toBe(0);
        const { rows: voteRows } = await pgPool().query(
            `SELECT 1 FROM comment_votes WHERE agent_id = $1 AND comment_id = $2`,
            [voter, comment]
        );
        expect(voteRows).toHaveLength(0);
        expect(await components(author)).toEqual({ points: 0, vote_points: 0, evaluation_points: 0, legacy_unattributed_points: 0 });
        expect(await driftedRowCount()).toBe(0);
    });

    it("refuses a sequential repeat at the pre-check, moving nothing", async () => {
        // Companion coverage: the `hasVoted` pre-check is unchanged by this chunk, so pre-M11-1C
        // code passes this too. The lost-race path that IS new — 23505 inside the statement rolling
        // the counter back with it — is the concurrent test below.
        const author = await seedAgent();
        const post = await seedPost(author);
        const voter = await seedAgent();

        expect(await upvotePost(post, voter)).toBe(true);
        const afterFirst = { counters: await postCounters(post), components: await components(author) };

        expect(await upvotePost(post, voter)).toBe(false);
        expect({ counters: await postCounters(post), components: await components(author) }).toEqual(afterFirst);
    });

    it("exposes 23505 in the shape isUniqueViolation matches", async () => {
        // The duplicate branch inside `castPostVote` reads `error.code`. Every ordinary path hides
        // it behind the `hasVoted` pre-check, so if the driver ever stopped exposing `code` the
        // lost-race branch would silently become a 500 instead of the "already voted" refusal, and
        // no green test would notice. This asserts the assumption directly, against the same
        // driver and the same index the statement collides on.
        const author = await seedAgent();
        const post = await seedPost(author);
        const voter = await seedAgent();
        await upvotePost(post, voter);

        let raised: unknown = null;
        try {
            await sql`
        INSERT INTO post_votes (agent_id, post_id, vote_type, voted_at, points_delta)
        VALUES (${voter}, ${post}, 1, NOW(), 1)
      `;
        } catch (error) {
            raised = error;
        }
        expect(raised).not.toBeNull();
        expect(isUniqueViolation(raised)).toBe(true);
    });

    it("admits exactly one of two concurrent votes by the same agent, and awards exactly once", async () => {
        // The real lost race: both calls clear the `hasVoted` pre-check before either INSERT
        // commits, so one of them reaches the primary key. The whole statement aborts with it —
        // counter included — so a rejected duplicate cannot leave a counter increment behind.
        // Neither call may THROW: a lost race is a refusal, not a 500.
        const author = await seedAgent();
        const post = await seedPost(author);
        const voter = await seedAgent();

        const outcomes = await runConcurrently([
            () => upvotePost(post, voter),
            () => upvotePost(post, voter),
        ]);

        expect(rejections(outcomes)).toEqual([]);
        expect(outcomes.filter((o) => o.ok && o.value === true)).toHaveLength(1);

        const { rows } = await pgPool().query<{ n: string }>(
            `SELECT count(*) AS n FROM post_votes WHERE agent_id = $1 AND post_id = $2`,
            [voter, post]
        );
        expect(Number(rows[0].n)).toBe(1);
        expect(await postCounters(post)).toEqual({ upvotes: 1, downvotes: 0 });
        expect(await components(author)).toEqual({ points: 1, vote_points: 1, evaluation_points: 0, legacy_unattributed_points: 0 });
    });
});

describe("concurrent votes at the floor boundary", () => {
    it("records -1 and 0 for two concurrent downvotes against an agent at 1, moving vote_points by exactly -1", async () => {
        // The case a snapshot-based delta silently double-charges: both statements would read
        // `points = 1`, both would record `points_delta = -1`, and the second would actually award
        // 0 at the floor. Reversing that vote later mints a point — OQ-1's failure reappearing
        // inside its own fix. The `FOR NO KEY UPDATE` in `locked` is what serialises them — it
        // conflicts with itself, so two votes against the SAME author still queue.
        const author = await seedAgent();
        const post = await seedPost(author);
        const up = await seedAgent();
        await upvotePost(post, up);
        expect(await components(author)).toEqual({ points: 1, vote_points: 1, evaluation_points: 0, legacy_unattributed_points: 0 });

        const d1 = await seedAgent();
        const d2 = await seedAgent();
        const outcomes = await runConcurrently([
            () => downvotePost(post, d1),
            () => downvotePost(post, d2),
        ]);
        expect(outcomes.every((o) => o.ok && o.value === true)).toBe(true);

        const deltas = [
            (await postVoteRow(d1, post))?.points_delta,
            (await postVoteRow(d2, post))?.points_delta,
        ].sort();
        // One took the point, the other hit the floor. Which one is not asserted — that would be
        // asserting a scheduling order.
        expect(deltas).toEqual(["-1.00", "0.00"]);

        // vote_points moved by exactly -1 in total: 1 (the upvote) - 1 + 0.
        expect(await components(author)).toEqual({ points: 0, vote_points: 0, evaluation_points: 0, legacy_unattributed_points: 0 });
        expect(await driftedRowCount()).toBe(0);
    });

    // The outcome assertion above is necessary but not sufficient: two HTTP calls that happen to
    // serialise produce the same numbers whether or not the lock exists. These prove the vote
    // statements really do wait on the author's row, from the catalog rather than from wall clock.
    //
    // The holder takes `FOR NO KEY UPDATE` because that is exactly what a concurrent vote takes —
    // holding the stronger `FOR UPDATE` would prove the statement waits for *something*, not that
    // two votes wait for each other.
    it("blocks on the author's row while another writer holds it — the post statement", async () => {
        const author = await seedAgent({ points: 1, vote_points: 1 });
        const post = await seedPost(author);
        const voter = await seedAgent();

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("SELECT id FROM agents WHERE id = $1 FOR NO KEY UPDATE", [author]);
            },
            contend: () => downvotePost(post, voter),
            contenderMarker: "race:m11-1c-post-vote",
        });

        expect(race.observedBlocked).toBe(true);
        expect(race.result).toBe(true);
        // And once it proceeds, it awards against the version it waited for.
        expect(await postVoteRow(voter, post)).toEqual({ vote_type: -1, points_delta: "-1.00" });
        expect(await components(author)).toEqual({ points: 0, vote_points: 0, evaluation_points: 0, legacy_unattributed_points: 0 });
    });

    it("records the delta from the version it WAITED FOR, not from its own snapshot", async () => {
        // The gate for the plan's central claim, and the one the two tests above cannot make.
        //
        // Blocking alone proves nothing about WHICH row version the delta came from: the final
        // `UPDATE agents` needs the row lock regardless, so a snapshot-based `locked` would wait
        // here too. And a holder that only locks, without changing anything, leaves the snapshot
        // value and the post-wait value IDENTICAL — so the assertion passes either way.
        //
        // This holder MUTATES `points` from 1 to 0 and commits, which makes the two readings
        // disagree, and the recorded delta is where they disagree visibly:
        //
        //   locked re-read (correct) → sees points = 0 → GREATEST(0, 0-1) - 0 =  0.00
        //   statement snapshot (wrong) → sees points = 1 → GREATEST(0, 1-1) - 1 = -1.00
        //
        // Both leave `points` at 0, because the outer UPDATE writes the absolute `l.points +
        // l.delta` — which is exactly why the stored total cannot discriminate and `points_delta`
        // must. That column is what M11-1b D1 reverses: recording -1.00 for a vote that awarded
        // nothing is OQ-1's point-minting bug reappearing inside its own fix.
        const author = await seedAgent({ points: 1, vote_points: 1 });
        const post = await seedPost(author);
        const voter = await seedAgent();

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(
                    "UPDATE agents SET points = 0, vote_points = 0 WHERE id = $1",
                    [author]
                );
            },
            contend: () => downvotePost(post, voter),
            contenderMarker: "race:m11-1c-post-vote",
        });

        expect(race.observedBlocked).toBe(true);
        expect(race.result).toBe(true);
        expect(await postVoteRow(voter, post)).toEqual({ vote_type: -1, points_delta: "0.00" });
        expect(await components(author)).toEqual({ points: 0, vote_points: 0, evaluation_points: 0, legacy_unattributed_points: 0 });
        expect(await driftedRowCount()).toBe(0);
    });

    it("does NOT block a vote whose author row is held FOR KEY SHARE — the reciprocal-vote deadlock", async () => {
        // The lock mode is load-bearing and this is the gate that discriminates it. Inserting the
        // vote row makes Postgres check `post_votes.agent_id REFERENCES agents(id)`, which takes an
        // implicit `FOR KEY SHARE` on the VOTER's agents row — modelled here by the holder.
        //
        // `FOR UPDATE` conflicts with `FOR KEY SHARE`; `FOR NO KEY UPDATE` does not. So with
        // `FOR UPDATE`, two agents upvoting each other's posts at the same moment each hold the
        // other's row and each wait for their own: 40P01, and one upvote becomes a 500. Revert the
        // statement to `FOR UPDATE` and this test fails — `observedBlocked` becomes true.
        const author = await seedAgent();
        const post = await seedPost(author);
        const voter = await seedAgent();

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("SELECT id FROM agents WHERE id = $1 FOR KEY SHARE", [author]);
            },
            contend: () => upvotePost(post, voter),
            contenderMarker: "race:m11-1c-post-vote",
        });

        expect(race.observedBlocked).toBe(false);
        expect(race.result).toBe(true);
        expect(await components(author)).toEqual(asDbComponents(KARMA_PARITY.oscillation.afterFirstUpvote));
    });

    it("blocks on the author's row while another writer holds it — the comment statement", async () => {
        const author = await seedAgent();
        const post = await seedPost(author);
        const comment = await seedComment(post, author);
        const voter = await seedAgent();

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("SELECT id FROM agents WHERE id = $1 FOR NO KEY UPDATE", [author]);
            },
            contend: () => upvoteComment(comment, voter),
            contenderMarker: "race:m11-1c-comment-vote",
        });

        expect(race.observedBlocked).toBe(true);
        expect(race.result).toBe(true);
        expect(await components(author)).toEqual({ points: 1, vote_points: 1, evaluation_points: 0, legacy_unattributed_points: 0 });
    });
});

describe("no display change", () => {
    it("gives points = 1 after a downvote at zero followed by an upvote, exactly as before this chunk", async () => {
        // The regression gate for draft 3's debt semantics, which this model deliberately does not
        // have: `vote_points` carries the same FLOORED delta `points` does, so a 0-award downvote
        // leaves no hidden debt for the next upvote to pay off.
        const author = await seedAgent();
        const post = await seedPost(author);
        const down = await seedAgent();
        const up = await seedAgent();

        await downvotePost(post, down);
        expect(await components(author)).toEqual(asDbComponents(KARMA_PARITY.flooredDownvoteAtZero.after));

        await upvotePost(post, up);
        expect(await components(author)).toEqual(asDbComponents(KARMA_PARITY.oscillation.afterFirstUpvote));
        expect(await driftedRowCount()).toBe(0);
    });
});

describe("the historical double-count", () => {
    it("raises the total by exactly the new evaluation's points", async () => {
        // Seed an agent whose `points` already contains evaluation credit, migrate, then pass a
        // FURTHER evaluation. Re-deriving from the aggregate would count the history twice. The
        // memory suite runs the same case against the same shared expectations, starting from the
        // post-migration state this test reaches by actually running the backfill.
        const expected = KARMA_PARITY.historicalDoubleCount;
        const agent = await seedAgent({ points: expected.seeded.points });
        await seedPassedResult(agent, "m11c-eval-hist-a", expected.priorEvaluationPoints);

        const client = await pgClient();
        try {
            await client.query(MIGRATION_SQL);
        } finally {
            await client.end();
        }
        expect(await components(agent)).toEqual(asDbComponents(expected.seeded));

        await seedPassedResult(agent, "m11c-eval-hist-b", expected.furtherEvaluationPoints);
        await updateAgentPointsFromEvaluations(agent);
        expect(await components(agent)).toEqual(asDbComponents(expected.after));
    });
});

describe("the mixed-version rollout window", () => {
    /** What an old instance did: an ABSOLUTE overwrite of `points`, knowing nothing about components. */
    async function oldEvaluationWriter(agentId: string): Promise<void> {
        await sql`
      UPDATE agents
      SET points = (SELECT COALESCE(SUM(points_earned), 0) FROM evaluation_results WHERE agent_id = ${agentId} AND passed = true)
      WHERE id = ${agentId}
    `;
    }

    async function reconcile(): Promise<void> {
        const client = await pgClient();
        try {
            await client.query(RECONCILE_SQL);
        } finally {
            await client.end();
        }
    }

    it("old evaluation → reconcile → new recompute gives the true sum, not double", async () => {
        const agent = await seedAgent({ points: 0 });
        await seedPassedResult(agent, "m11c-eval-mixed-a", 8);
        await oldEvaluationWriter(agent);
        expect(await components(agent)).toEqual({ points: 8, vote_points: 0, evaluation_points: 0, legacy_unattributed_points: 0 });

        await reconcile();
        expect(await components(agent)).toEqual({ points: 8, vote_points: 0, evaluation_points: 8, legacy_unattributed_points: 0 });

        await seedPassedResult(agent, "m11c-eval-mixed-b", 3);
        await updateAgentPointsFromEvaluations(agent);
        expect(await components(agent)).toEqual({ points: 11, vote_points: 0, evaluation_points: 11, legacy_unattributed_points: 0 });
    });

    it("CLOSED BY D4: a reconciliation cannot land between a result and its award", async () => {
        // This was `KNOWN EXPOSURE`, and it is kept rather than deleted because it is the record of
        // what M11-1b D4 bought.
        //
        // Before D4, `saveEvaluationResult` inserted the result and then moved `points` in a SECOND
        // auto-committed statement. A reconciliation landing in that gap attributed the new credit
        // to `evaluation_points` before `points` had received it, so the recompute's delta was zero
        // and the agent silently never got the points — the invariant still held, legacy absorbed
        // the difference, and nothing caught it. The recorded expectation was `points 4`.
        //
        // D4 folded the insert and the award into one transaction, so the gap does not exist: a
        // reconciliation is either entirely before it or entirely after it. Both orders are asserted
        // below, and both give the true total — `points 7`.
        const agent = await seedAgent();
        await seedPassedResult(agent, "m11c-eval-exposure-a", 4);
        await updateAgentPointsFromEvaluations(agent);
        expect(await components(agent)).toEqual({ points: 4, vote_points: 0, evaluation_points: 4, legacy_unattributed_points: 0 });

        // A real completion through the production writer, worth 3.
        const registration = await seedRegistration(agent, "m11c-eval-exposure-b");
        const saved = await saveEvaluationResult({
            registrationId: registration,
            agentId: agent,
            evaluationId: "m11c-eval-exposure-b",
            passed: true,
            score: 3,
            maxScore: 10,
        });
        expect(saved.outcome).toBe("created");
        expect(await components(agent)).toEqual({ points: 7, vote_points: 0, evaluation_points: 7, legacy_unattributed_points: 0 });

        // Reconciling after it changes nothing, and re-running changes nothing again.
        await reconcile();
        expect(await components(agent)).toEqual({ points: 7, vote_points: 0, evaluation_points: 7, legacy_unattributed_points: 0 });
        await reconcile();
        expect(await components(agent)).toEqual({ points: 7, vote_points: 0, evaluation_points: 7, legacy_unattributed_points: 0 });
        expect(await driftedRowCount()).toBe(0);
    });

    it("CLOSED BY D4: a reconciliation racing a completion still leaves the true total", async () => {
        // The other order, made deterministic. The completion's FIRST statement takes the agent row
        // `FOR UPDATE`, so holding that row from a second connection wedges the whole completion
        // transaction before it writes anything. The reconciliation then runs to completion in what
        // used to be "the gap" — and finds nothing half-written, because there is no half.
        const agent = await seedAgent();
        await seedPassedResult(agent, "m11c-eval-race-a", 5);
        await updateAgentPointsFromEvaluations(agent);
        const registration = await seedRegistration(agent, "m11c-eval-race-b");

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [agent]);
                // The reconciliation runs while the completion is blocked on that lock.
                await holder.query(RECONCILE_SQL);
            },
            contend: () =>
                saveEvaluationResult({
                    registrationId: registration,
                    agentId: agent,
                    evaluationId: "m11c-eval-race-b",
                    passed: true,
                    score: 2,
                    maxScore: 10,
                }),
            contenderMarker: "d4:completion-agent-lock",
        });

        expect(race.observedBlocked).toBe(true);
        expect(race.result.outcome).toBe("created");
        expect(await components(agent)).toEqual({ points: 7, vote_points: 0, evaluation_points: 7, legacy_unattributed_points: 0 });
        expect(await driftedRowCount()).toBe(0);
    });

    it("absorbs an old instance's direct points write into legacy, and reconciling again changes nothing", async () => {
        // This is why `points` is delta-maintained rather than re-derived: a stray write from an
        // old instance survives the rollout instead of being clobbered.
        const agent = await seedAgent({ points: 3, vote_points: 3 });
        await sql`UPDATE agents SET points = points + 1 WHERE id = ${agent}`;

        await reconcile();
        const absorbed = await components(agent);
        expect(absorbed).toEqual({ points: 4, vote_points: 3, evaluation_points: 0, legacy_unattributed_points: 1 });

        await reconcile();
        expect(await components(agent)).toEqual(absorbed);
        expect(await driftedRowCount()).toBe(0);
    });
});

describe("C14 parity", () => {
    it("consumes the vetting challenge exactly once and writes evaluation_points with it", async () => {
        const { completeVetting } = await import("@/lib/store/agents/db");
        const agent = await seedAgent();
        const challengeId = nextId("challenge");
        await pgPool().query(
            `INSERT INTO vetting_challenges (id, agent_id, "values", nonce, expected_hash, created_at, expires_at, fetched_at, consumed_at)
             VALUES ($1, $2, '[1,2,3]'::jsonb, 'nonce', 'hash', NOW(), NOW() + INTERVAL '5 minutes', NOW(), NULL)`,
            [challengeId, agent]
        );

        const first = await completeVetting(agent, challengeId, "# identity");
        expect(first.outcome).toBe("completed");

        const afterFirst = await components(agent);
        // The bootstrap evaluations the batch inserts are worth whatever the definitions say; the
        // assertion is that `evaluation_points` carries them and the invariant holds, not a
        // hardcoded number that a definition edit would break.
        expect(afterFirst.evaluation_points).toBe(afterFirst.points);
        expect(afterFirst.points).toBe(
            afterFirst.legacy_unattributed_points + afterFirst.vote_points + afterFirst.evaluation_points
        );

        // Consumed: a second attempt on the same challenge is refused and changes nothing.
        const second = await completeVetting(agent, challengeId, "# identity");
        expect(second.outcome).toBe("unavailable");
        expect(await components(agent)).toEqual(afterFirst);
    });
});
