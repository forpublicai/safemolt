/**
 * M11-1C — the karma component tuples BOTH stores must produce, written down once.
 *
 * "Store parity" is easy to claim and easy to fake: two suites can assert the same numbers, drift
 * apart in one edit, and both stay green because nothing connects them. These constants are the
 * connection. `src/__tests__/lib/store/karma-components.test.ts` drives the sequences through the
 * memory store and `src/__tests__/integration/m11-1c-karma-components.test.ts` drives the identical
 * sequences through Postgres, and both assert against **these** values — so a divergence in either
 * implementation fails one suite while the other pins what the answer was supposed to be.
 *
 * The db store spells the components in snake_case; `asDbComponents` converts, so the expectation
 * itself is stated only once.
 */

export interface KarmaComponents {
    points: number;
    votePoints: number;
    evaluationPoints: number;
    legacyUnattributedPoints: number;
}

export function asDbComponents(c: KarmaComponents): {
    points: number;
    vote_points: number;
    evaluation_points: number;
    legacy_unattributed_points: number;
} {
    return {
        points: c.points,
        vote_points: c.votePoints,
        evaluation_points: c.evaluationPoints,
        legacy_unattributed_points: c.legacyUnattributedPoints,
    };
}

const ZERO: KarmaComponents = {
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
};

export const KARMA_PARITY = {
    /** A brand-new agent. Every component initialised, not left undefined (`undefined + 1` is NaN). */
    freshAgent: ZERO,

    /**
     * The headline: upvote → a passed evaluation worth 5 → upvote. All three contributions survive.
     * Pre-M11-1C, the evaluation's absolute overwrite discarded the first upvote and the agent
     * ended on 6.
     */
    oscillation: {
        evaluationPointsAwarded: 5,
        afterFirstUpvote: { points: 1, votePoints: 1, evaluationPoints: 0, legacyUnattributedPoints: 0 },
        afterEvaluation: { points: 6, votePoints: 1, evaluationPoints: 5, legacyUnattributedPoints: 0 },
        afterSecondUpvote: { points: 7, votePoints: 2, evaluationPoints: 5, legacyUnattributedPoints: 0 },
    },

    /** A downvote against an agent already at zero awards 0 — the floor, and OQ-1's whole problem. */
    flooredDownvoteAtZero: { award: 0, after: ZERO },

    /** A downvote that actually takes the point an upvote gave. */
    downvoteAfterUpvote: { award: -1, after: ZERO },

    /** A comment upvote awards its comment's author. */
    commentUpvote: {
        award: 1,
        after: { points: 1, votePoints: 1, evaluationPoints: 0, legacyUnattributedPoints: 0 },
    },

    /**
     * An agent whose `points` already contains evaluation credit, with the remainder recorded as
     * legacy. A further evaluation raises the total by exactly the new evaluation's points —
     * re-deriving from the aggregate would count the history a second time.
     */
    historicalDoubleCount: {
        seeded: { points: 10, votePoints: 0, evaluationPoints: 6, legacyUnattributedPoints: 4 },
        priorEvaluationPoints: 6,
        furtherEvaluationPoints: 5,
        after: { points: 15, votePoints: 0, evaluationPoints: 11, legacyUnattributedPoints: 4 },
    },
} as const satisfies Record<string, unknown>;
