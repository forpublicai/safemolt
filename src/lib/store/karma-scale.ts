/**
 * M11-1C — the memory store's karma arithmetic, at the same scale Postgres uses.
 *
 * Every karma column is `DECIMAL(14,2)`, and Postgres `NUMERIC` is exact: adding 0.01 and 2.35 to a
 * running total gives 2.36, always. JavaScript numbers are binary floats and do not, so the memory
 * store can land on `3.3600000000000003` for `points` while the three components sum to `3.36` —
 * breaking the invariant by an epsilon and diverging from the db store on the same input.
 *
 * This is not hypothetical: evaluation definitions carry `points DECIMAL(5,2)` and the seeded ones
 * include fractional values, so a fractional evaluation credit is an ordinary case, not an exotic
 * one. Rounding every karma value to the storage scale as it is written keeps the two stores
 * bit-identical and keeps `points = legacy + vote + evaluation` exact in both.
 *
 * It reproduces Postgres's rule on both counts that differ from the naive version:
 *
 * - **Half away from zero**, not `Math.round`'s half-up. They differ only on negatives —
 *   `Math.round(-100.5)` is -100 while Postgres gives -101 — and karma components genuinely go
 *   negative (`legacy_unattributed_points` is negative for any agent whose downvotes floored earned
 *   credit away).
 * - **The shift is decimal, not a float multiply.** `1.005 * 100` is `100.49999999999999` in binary,
 *   so multiplying rounds 1.005 DOWN to 1.00 while `1.005::DECIMAL(5,2)` is 1.01. That case is
 *   reachable — `computeEvaluationResultFields` calls this on an evaluation definition's own
 *   `points`, and a definition may be written with three decimals. Re-parsing the number's decimal
 *   text with an exponent (`Number("1.005e2")` → exactly 100.5) shifts without introducing the
 *   error the multiply creates.
 *
 * Scaling by 100 is safe across the whole column range: the largest `DECIMAL(14,2)` value is
 * 10^12 - 0.01, so the shifted value stays well inside `Number.MAX_SAFE_INTEGER` (~9.007e15).
 */
function shiftDecimal(value: number, exponent: number): number {
  const text = String(value);
  // Already in exponential form — only |value| < 1e-6 or >= 1e21 stringifies that way. Nothing in
  // the karma range does; what can is float cancellation noise (~1e-17) that is about to round to
  // zero either way, and for that a plain multiply is exact enough.
  if (text.includes("e") || text.includes("E")) return value * 10 ** exponent;
  return Number(`${text}e${exponent}`);
}

export function toKarmaScale(value: number): number {
  const scaled = shiftDecimal(value, 2);
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  // `+ 0` normalises negative zero. A value just below zero rounds to `-0`, which compares equal to
  // `0` with `==` but NOT with `Object.is` — the comparison Jest's matchers use — so a stored `-0`
  // would fail an assertion that is otherwise correct. Postgres has no signed zero to mirror here.
  return shiftDecimal(rounded, -2) + 0;
}
