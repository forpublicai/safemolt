/**
 * M11-1C — `toKarmaScale` must round the way Postgres `NUMERIC` rounds, not the way JavaScript
 * happens to.
 *
 * Every karma column is `DECIMAL(14,2)` and `evaluation_results.points_earned` is `DECIMAL(5,2)`.
 * The db store gets that scale for free; the memory store has to reproduce it, and any divergence
 * is a silent store-parity break — the same input producing different karma depending on whether a
 * database is configured.
 *
 * Two ways the obvious implementation gets it wrong, both pinned below:
 *
 * - `Math.round` is half-UP, Postgres is half-AWAY-FROM-ZERO. They differ on negatives, and karma
 *   components genuinely go negative.
 * - `value * 100` is a binary multiply: `1.005 * 100` is `100.49999999999999`, so it rounds 1.005
 *   down to 1.00 while `1.005::DECIMAL(5,2)` is 1.01.
 *
 * The expected values here are what Postgres produces for `<value>::DECIMAL(14,2)`.
 */
import { toKarmaScale } from "@/lib/store/karma-scale";

describe("toKarmaScale matches Postgres NUMERIC(_, 2)", () => {
    it("leaves values already at the storage scale alone", () => {
        for (const value of [0, 1, -1, -15, 2.36, 3.36, 999999999999.99]) {
            expect([value, toKarmaScale(value)]).toEqual([value, value]);
        }
    });

    it("rounds half AWAY FROM ZERO, not half up", () => {
        // The negatives are the discriminating half: `Math.round(-0.5)` is -0, not -1.
        expect(toKarmaScale(0.125)).toBe(0.13);
        expect(toKarmaScale(-0.125)).toBe(-0.13);
        expect(toKarmaScale(0.005)).toBe(0.01);
        expect(toKarmaScale(-0.005)).toBe(-0.01);
    });

    it("shifts by decimal text, not by a binary multiply", () => {
        // `1.005 * 100` is 100.49999999999999 in binary and would round DOWN to 1.00.
        expect(toKarmaScale(1.005)).toBe(1.01);
        expect(toKarmaScale(-1.005)).toBe(-1.01);
        // Reachable: `computeEvaluationResultFields` scales an evaluation definition's own points,
        // and a definition may be written with three decimals.
        expect(toKarmaScale(2.345)).toBe(2.35);
        expect(toKarmaScale(0.004)).toBe(0);
    });

    it("cleans up float cancellation noise, including the exponential-notation range", () => {
        expect(toKarmaScale(0.1 + 0.2)).toBe(0.3);
        expect(toKarmaScale(5.551115123125783e-17)).toBe(0);
    });

    it("never produces negative zero", () => {
        // `-0` compares equal to `0` with `==` but not with `Object.is`, which is what Jest's
        // matchers use — so a stored `-0` fails assertions that are otherwise correct.
        for (const value of [-0.001, -0, -0.0001]) {
            expect(Object.is(toKarmaScale(value), 0)).toBe(true);
        }
    });

    it("keeps sums of scaled values exact, which is what the invariant needs", () => {
        // `points = legacy + vote + evaluation` has to hold as a decimal identity in the memory
        // store, where all three are ordinary JavaScript numbers.
        const legacy = toKarmaScale(-15);
        const vote = toKarmaScale(1);
        const evaluation = toKarmaScale(20.05);
        expect(toKarmaScale(legacy + vote + evaluation)).toBe(6.05);
    });
});
