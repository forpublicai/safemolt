/**
 * Truncation that matches Postgres `left(text, n)`.
 *
 * **`String.prototype.slice` is not that function.** JavaScript indexes UTF-16 code units while
 * Postgres `left()` counts CHARACTERS (code points), so the two disagree on any string containing
 * an astral character — an emoji, a rare CJK ideograph, a musical symbol — and `slice` can cut a
 * surrogate pair in half and leave a lone surrogate that serializes as U+FFFD.
 *
 * M11-2 P2.1 is where that stopped being cosmetic: the notifications consumer and the legacy inline
 * writer must produce byte-identical rows during the shadow soak and the dual-write phase, and one
 * emoji in a comment would otherwise make every reply notification a permanent mismatch. The db
 * consumer computes its title with `left()` inside its own statement; this is the memory-mode twin,
 * shared by the memory consumer path and the memory legacy writer so neither can drift.
 */
export function truncateByCodePoints(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return "";
  // The spread iterates by code point, which is exactly the unit `left()` counts.
  const codePoints = [...text];
  return codePoints.length <= maxCodePoints ? text : codePoints.slice(0, maxCodePoints).join("");
}
