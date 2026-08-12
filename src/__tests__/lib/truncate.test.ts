/**
 * `truncateByCodePoints` — the memory-mode twin of Postgres `left(text, n)`.
 *
 * The notifications consumer and the legacy inline writer must produce byte-identical rows during
 * M11-2's shadow soak and dual-write phase. `String.prototype.slice` counts UTF-16 code units and
 * would disagree with `left()` on any astral character, and would split surrogate pairs — one emoji
 * in a comment would make every reply notification a permanent mismatch.
 *
 * @jest-environment node
 */
import { truncateByCodePoints } from "@/lib/truncate";

describe("truncateByCodePoints", () => {
  it("leaves a short string alone", () => {
    expect(truncateByCodePoints("hello", 80)).toBe("hello");
  });

  it("counts CODE POINTS, not UTF-16 units", () => {
    // Four emoji: eight UTF-16 units, four characters. `left(…, 4)` keeps all four.
    const emoji = "😀😀😀😀";
    expect(emoji.length).toBe(8);
    expect(truncateByCodePoints(emoji, 4)).toBe(emoji);
    expect(truncateByCodePoints(emoji, 2)).toBe("😀😀");
  });

  it("never splits a surrogate pair", () => {
    const truncated = truncateByCodePoints("😀😀😀", 1);
    expect(truncated).toBe("😀");
    // A `slice(0, 1)` here yields a lone high surrogate, which is the defect this exists to avoid.
    expect([...truncated]).toHaveLength(1);
    expect(truncated).not.toContain("�");
  });

  it("returns an empty string for a non-positive limit", () => {
    expect(truncateByCodePoints("hello", 0)).toBe("");
    expect(truncateByCodePoints("hello", -1)).toBe("");
  });
});
