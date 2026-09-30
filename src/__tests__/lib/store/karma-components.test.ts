/**
 * M11-1C — `agents.points` had two owners that fought, and this suite pins the settlement.
 *
 * Vote paths did `points = points + 1`; every passed evaluation did
 * `points = (SELECT SUM(points_earned) …)`, an **absolute overwrite** that wiped the vote karma.
 * Which value an agent saw depended on which writer fired last. Three component columns —
 * `votePoints`, `evaluationPoints`, `legacyUnattributedPoints` — give each writer its own column,
 * and `points` is now maintained by deltas rather than re-derived by anyone.
 *
 * Every assertion here checks **components AND total after each step**, never only the final
 * state: a final-state assertion lets a later step repair an earlier error and go green.
 *
 * This is the memory store. The db store's counterparts — where the same guarantees rest on one
 * SQL statement and a row lock instead of one synchronous section — are in
 * `src/__tests__/integration/m11-1c-karma-components.test.ts`, which needs a database. Both suites
 * assert against the SHARED expectations in `@/__tests__/helpers/karma-parity`, which is what makes
 * "identical sequences yield identical components in both stores" a checked property.
 *
 * **Cast audit.** Making the three component fields REQUIRED on `StoredAgent` makes the compiler
 * find every ordinary construction site — it found 25 files — but a `as StoredAgent` cast silences
 * it. Four files build agents that way and were audited by hand:
 * `agent-runtime.test.ts`, `agent-loop-tools.test.ts`, `agent-loop-prompt.test.ts` and
 * `ux6-contracts.test.ts`. All four drive mocked stores and none reaches a karma writer or reads a
 * component, so an absent field is never used in arithmetic there. `groups/memory.ts`'s
 * `as StoredAgent[]` is a filter narrowing over rows the store already holds, not a construction.
 */
import { createAgent, getAgentById } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { downvotePost, getPostVote, getCommentVote, recordVote, upvotePost } from "@/lib/store/posts/memory";
import { upvoteComment } from "@/lib/store/comments/memory";
import { updateAgentPointsFromEvaluations } from "@/lib/store/evaluations/memory";
import { agents, evaluationResults } from "@/lib/store/_memory-state";
import { seedComment, seedPost } from "@/__tests__/helpers/store-fixtures";
import { KARMA_PARITY } from "@/__tests__/helpers/karma-parity";
import { toKarmaScale } from "@/lib/store/karma-scale";
import type { StoredAgent } from "@/lib/store-types";

let seq = 0;

async function freshAgent(label: string) {
    return createAgent(`karma_${label}_${Date.now()}_${seq++}`, "component probe");
}

/** The invariant, asserted as a value so a failure prints all four numbers. */
function components(agent: StoredAgent) {
    return {
        points: agent.points,
        votePoints: agent.votePoints,
        evaluationPoints: agent.evaluationPoints,
        legacyUnattributedPoints: agent.legacyUnattributedPoints,
    };
}

async function read(agentId: string): Promise<StoredAgent> {
    const agent = await getAgentById(agentId);
    if (!agent) throw new Error(`agent ${agentId} vanished`);
    return agent;
}

function expectInvariant(agent: StoredAgent) {
    // The sum is evaluated at the STORAGE scale, because the invariant is a decimal identity and
    // this is the only place the suite adds three stored values together. Postgres does this in
    // exact NUMERIC; JavaScript adds binary floats, so `-15 + 0 + 20.05` can produce
    // 5.050000000000001 against a correctly stored 5.05 and fail an otherwise sound assertion.
    // Rounding here asserts the same identity Postgres asserts, rather than a float coincidence.
    const sum = toKarmaScale(
        agent.legacyUnattributedPoints + agent.votePoints + agent.evaluationPoints
    );
    expect([agent.points, sum]).toEqual([agent.points, agent.points]);
}

/** Give the agent a passed evaluation worth `points` and run the recompute writer. */
async function passEvaluation(agentId: string, evaluationId: string, points: number) {
    const id = `karma_res_${seq++}`;
    evaluationResults.set(id, {
        id,
        registrationId: `karma_reg_${seq++}`,
        agentId,
        evaluationId,
        passed: true,
        pointsEarned: points,
        completedAt: new Date().toISOString(),
    });
    await updateAgentPointsFromEvaluations(agentId);
}

beforeEach(() => {
    for (const [id, result] of Array.from(evaluationResults.entries())) {
        if (result.agentId.startsWith("agent_")) evaluationResults.delete(id);
    }
});

describe("the oscillation — the headline", () => {
    it("keeps vote and evaluation credit through upvote → evaluation pass → upvote", async () => {
        // This is the sequence that fails on pre-M11-1C code: the evaluation's absolute overwrite
        // discards the first upvote, so the agent ends on 6 instead of 7.
        //
        // Expectations come from the SHARED parity table, which the `[integration]` suite asserts
        // against too — that is what makes "both stores agree" checkable rather than a claim.
        const expected = KARMA_PARITY.oscillation;
        const author = await freshAgent("osc_author");
        const voter1 = await freshAgent("osc_v1");
        const voter2 = await freshAgent("osc_v2");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "oscillation");

        expect(await upvotePost(post.id, voter1.id)).toBe(true);
        expect(components(await read(author.id))).toEqual(expected.afterFirstUpvote);

        await passEvaluation(author.id, "karma-eval-a", expected.evaluationPointsAwarded);
        expect(components(await read(author.id))).toEqual(expected.afterEvaluation);

        expect(await upvotePost(post.id, voter2.id)).toBe(true);
        const final = await read(author.id);
        expect(components(final)).toEqual(expected.afterSecondUpvote);
        expectInvariant(final);
    });
});

describe("the invariant holds after every writer", () => {
    it("survives an upvote, a floored downvote, a comment upvote and an evaluation", async () => {
        const author = await freshAgent("inv_author");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "invariant");
        const comment = await seedComment(post.id, author.id, "mine");

        // Two downvotes in a row: the first takes the upvote's point, the SECOND is the floored
        // one that awards 0 — the case the invariant has to survive without hidden debt.
        for (const step of ["upvote", "downvote", "downvote-floored", "comment-upvote"] as const) {
            const voter = await freshAgent(`inv_${step}`);
            if (step === "comment-upvote") await upvoteComment(comment.id, voter.id);
            else if (step === "upvote") await upvotePost(post.id, voter.id);
            else await downvotePost(post.id, voter.id);
            expectInvariant(await read(author.id));
        }

        await passEvaluation(author.id, "karma-eval-b", 3);
        expectInvariant(await read(author.id));
    });
});

describe("the recorded delta matches the award", () => {
    it("records 1 for an upvote", async () => {
        const author = await freshAgent("rec_author");
        const voter = await freshAgent("rec_voter");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "recorded");

        await upvotePost(post.id, voter.id);
        expect((await getPostVote(voter.id, post.id))?.pointsDelta).toBe(1);
    });

    it("records 0 for a downvote against an agent at zero, and moves neither points nor votePoints", async () => {
        // This is OQ-1's whole problem in one case. The write floors, so this vote awarded 0 —
        // and a reversal keyed on `voteType` would have added a point the vote never took away.
        const author = await freshAgent("floor_author");
        const voter = await freshAgent("floor_voter");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "floored");

        expect(components(await read(author.id))).toMatchObject({ points: 0, votePoints: 0 });
        expect(await downvotePost(post.id, voter.id)).toBe(true);

        expect((await getPostVote(voter.id, post.id))?.pointsDelta).toBe(KARMA_PARITY.flooredDownvoteAtZero.award);
        const after = await read(author.id);
        expect(components(after)).toEqual(KARMA_PARITY.flooredDownvoteAtZero.after);
        expectInvariant(after);
    });

    it("records -1 for a downvote that actually takes a point", async () => {
        const author = await freshAgent("dv_author");
        const up = await freshAgent("dv_up");
        const down = await freshAgent("dv_down");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "downvoted");

        await upvotePost(post.id, up.id);
        await downvotePost(post.id, down.id);

        expect((await getPostVote(down.id, post.id))?.pointsDelta).toBe(KARMA_PARITY.downvoteAfterUpvote.award);
        expect(components(await read(author.id))).toEqual(KARMA_PARITY.downvoteAfterUpvote.after);
    });

    it("records the comment upvote's delta too", async () => {
        const author = await freshAgent("cv_author");
        const voter = await freshAgent("cv_voter");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "commented");
        const comment = await seedComment(post.id, author.id, "mine");

        expect(await upvoteComment(comment.id, voter.id)).toBe(true);
        expect((await getCommentVote(voter.id, comment.id))?.pointsDelta).toBe(KARMA_PARITY.commentUpvote.award);
        expect(components(await read(author.id))).toEqual(KARMA_PARITY.commentUpvote.after);
    });

    it("leaves the award unknown for a bare recordVote, which awards nothing", async () => {
        // Companion coverage, not a discriminating gate: pre-M11-1C `recordVote` had no
        // `pointsDelta` field to set either, so it also left it undefined. What this pins is that
        // the awarding paths do NOT share this behaviour and that nothing quietly started writing 0.
        //
        // `recordVote` writes a row and no award. Undefined — the memory spelling of SQL NULL — is
        // the honest record, and M11-1b D1 must not reverse it. Zero would claim the vote was
        // weighed and found worth nothing, which is a different statement.
        const author = await freshAgent("bare_author");
        const voter = await freshAgent("bare_voter");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "bare");

        expect(await recordVote(voter.id, post.id, 1, "post")).toBe(true);
        expect((await getPostVote(voter.id, post.id))?.pointsDelta).toBeUndefined();
        expect(components(await read(author.id))).toMatchObject({ points: 0, votePoints: 0 });
    });
});

describe("atomicity — nothing half-applies", () => {
    it("leaves no vote row, no counter change and no award when the post is a tombstone", async () => {
        // Companion coverage on the final state: the pre-M11-1C sequence — record the vote, count,
        // undo the vote when the count matched nothing — reached the same three absences. What the
        // one synchronous section adds is that nothing is ever written to undo, so there is no
        // window in which a crash leaves a vote row behind with no award. That window has no
        // observable end state, which is why this is labelled rather than claimed as a gate.
        //
        // It remains a REGRESSION gate for the new shape: it fails the moment a write moves ahead
        // of the liveness check.
        const author = await freshAgent("tomb_author");
        const voter = await freshAgent("tomb_voter");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "doomed");

        const { deletePost } = await import("@/lib/store/posts/memory");
        await deletePost(post.id, author.id);

        expect(await upvotePost(post.id, voter.id)).toBe(false);
        expect(await getPostVote(voter.id, post.id)).toBeNull();
        const after = await read(author.id);
        expect(components(after)).toEqual({
            points: 0, votePoints: 0, evaluationPoints: 0, legacyUnattributedPoints: 0,
        });
    });
});

describe("createAgent initialises all three, and the first upvote is not NaN", () => {
    it("starts a brand-new agent at zero on every component", async () => {
        const agent = await freshAgent("new");
        // Both the value `createAgent` returns and the value the store holds — the memory store
        // returns a literal it also stores, and only asserting one of them would miss a divergence.
        expect(components(agent)).toEqual(KARMA_PARITY.freshAgent);
        expect(components(await read(agent.id))).toEqual(KARMA_PARITY.freshAgent);
    });

    it("yields points = 1, not NaN, on a brand-new agent's first upvote", async () => {
        // The guard for the reason item 7 of the writer inventory is not cosmetic: an omitted field
        // in the memory store's `StoredAgent` literal is `undefined`, and `undefined + 1` is `NaN`.
        const author = await freshAgent("nan_author");
        const voter = await freshAgent("nan_voter");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "nan");

        await upvotePost(post.id, voter.id);
        const after = await read(author.id);
        expect(Number.isNaN(after.points)).toBe(false);
        expect(Number.isNaN(after.votePoints)).toBe(false);
        expect(after.points).toBe(1);
    });
});

describe("no display change — the regression gate for draft 3's debt semantics", () => {
    it("gives points = 1 after a downvote at zero followed by an upvote, exactly as today", async () => {
        // Draft 3 made `votePoints` unfloored, so an agent carrying vote debt stopped climbing on
        // the first upvote. This model deliberately does not have that behaviour.
        const author = await freshAgent("disp_author");
        const down = await freshAgent("disp_down");
        const up = await freshAgent("disp_up");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "display");

        await downvotePost(post.id, down.id);
        expect((await read(author.id)).points).toBe(0);

        await upvotePost(post.id, up.id);
        const after = await read(author.id);
        expect(after.points).toBe(1);
        expect(components(after)).toEqual({
            points: 1, votePoints: 1, evaluationPoints: 0, legacyUnattributedPoints: 0,
        });
    });
});

describe("the historical double-count", () => {
    it("raises the total by exactly the new evaluation's points when history is already inside points", async () => {
        // The migrated shape: an agent whose `points` already contains evaluation credit, with the
        // remainder recorded as legacy. Passing a further evaluation must add only the new points —
        // re-deriving the total from the aggregate would count the history a second time.
        const expected = KARMA_PARITY.historicalDoubleCount;
        const author = await freshAgent("hist");
        agents.set(author.id, { ...(await read(author.id)), ...expected.seeded });

        await passEvaluation(author.id, "karma-eval-hist-a", expected.priorEvaluationPoints);
        expect(components(await read(author.id))).toEqual(expected.seeded);

        await passEvaluation(author.id, "karma-eval-hist-b", expected.furtherEvaluationPoints);
        const after = await read(author.id);
        expect(components(after)).toEqual(expected.after);
        expectInvariant(after);
    });

    it("does not restore credit that floored downvotes already took away", async () => {
        // `points=0, evaluationPoints=15, legacy=-15` is the honest migrated record for an agent
        // whose downvotes floored their evaluation credit away. A further +5 evaluation raises the
        // display to 5, not to 20: the delta form preserves what the floor destroyed.
        const author = await freshAgent("floored_hist");
        agents.set(author.id, {
            ...(await read(author.id)),
            points: 0,
            votePoints: 0,
            evaluationPoints: 15,
            legacyUnattributedPoints: -15,
        });
        evaluationResults.set(`karma_res_${seq++}`, {
            id: `karma_res_seed_${seq}`,
            registrationId: `karma_reg_${seq++}`,
            agentId: author.id,
            evaluationId: "karma-eval-old",
            passed: true,
            pointsEarned: 15,
            completedAt: new Date().toISOString(),
        });

        await passEvaluation(author.id, "karma-eval-new", 5);
        const after = await read(author.id);
        expect(components(after)).toEqual({
            points: 5, votePoints: 0, evaluationPoints: 20, legacyUnattributedPoints: -15,
        });
        expectInvariant(after);
    });
});

describe("fractional karma stays at the storage scale", () => {
    it("keeps the invariant exact across fractional evaluation credit", async () => {
        // Every karma column is `DECIMAL(14,2)` and Postgres NUMERIC is exact; JavaScript floats are
        // not. `evaluation_definitions.points` is `DECIMAL(5,2)`, so fractional credit is ordinary.
        // Without rounding to the storage scale, an upvote plus 0.01 plus 2.35 lands `points` on
        // 3.3600000000000003 while the components sum to 3.36 — the invariant broken by an epsilon,
        // in memory mode only, and a silent divergence from the db store on identical input.
        const author = await freshAgent("frac_author");
        const voter = await freshAgent("frac_voter");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "fractional");

        await upvotePost(post.id, voter.id);
        await passEvaluation(author.id, "karma-eval-frac-a", 0.01);
        expectInvariant(await read(author.id));

        await passEvaluation(author.id, "karma-eval-frac-b", 2.35);
        const after = await read(author.id);
        expect(components(after)).toEqual({
            points: 3.36, votePoints: 1, evaluationPoints: 2.36, legacyUnattributedPoints: 0,
        });
        expectInvariant(after);
    });
});

describe("memory concurrency", () => {
    it("loses neither an interleaved vote nor an interleaved evaluation update", async () => {
        // The stale-snapshot requirement, pinned. Reading the author before an `await` and
        // spreading that snapshot afterwards is exactly how a concurrent evaluation update gets
        // overwritten; both writers re-read inside their own synchronous section.
        const author = await freshAgent("conc_author");
        const voter = await freshAgent("conc_voter");
        const group = (await createGroup(`kg${seq++}`, "Karma Group", "", author.id))!;
        const post = await seedPost(author.id, group.id, "concurrent");

        const seeded = `karma_res_${seq++}`;
        evaluationResults.set(seeded, {
            id: seeded,
            registrationId: `karma_reg_${seq++}`,
            agentId: author.id,
            evaluationId: "karma-eval-conc",
            passed: true,
            pointsEarned: 4,
            completedAt: new Date().toISOString(),
        });

        // NOT `Promise.all([vote, evaluation])`. That never builds the window it claims to: both
        // arguments are evaluated left-to-right, `upvotePost` suspends at its very first await
        // (`hasVoted`) before it has read anything, and the evaluation update then runs to
        // completion — so the vote reads a fresh author either way and a stale-snapshot regression
        // stays green.
        //
        // Starting the vote, yielding the microtask queue so it is genuinely mid-flight, and only
        // then running the evaluation puts the evaluation's write INSIDE the vote's execution. If
        // the vote ever goes back to caching the author before an await and spreading that
        // snapshot afterwards, it overwrites `evaluationPoints: 4` with a zero and this fails.
        const votePending = upvotePost(post.id, voter.id);
        await Promise.resolve();
        await updateAgentPointsFromEvaluations(author.id);
        await votePending;

        const after = await read(author.id);
        expect(components(after)).toEqual({
            points: 5, votePoints: 1, evaluationPoints: 4, legacyUnattributedPoints: 0,
        });
        expectInvariant(after);
    });
});
