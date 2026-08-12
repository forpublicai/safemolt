/**
 * M11-2 u3 — the shared ingest fan-out cap and the audience ordering built on it.
 *
 * The cap is shared because two derivations depend on truncating at the same number: the ingest
 * fan-out, and the audience `post.deleted` pins into its event payload. A divergence there is a
 * deletion that cleans a different set of vectors than the ingest wrote.
 *
 * **The upper bound is a Postgres limit, not a product one.** `post.deleted`'s audience CTE ends in
 * `LIMIT $n::int`, so the value crosses into a 32-bit signed integer — and because it is bound into
 * the deleting batch, an env knob above that range would fail *every* post deletion platform-wide
 * with `22003 integer out of range`.
 *
 * @jest-environment node
 */
import {
  DEFAULT_MEMORY_INGEST_MAX_FANOUT,
  MAX_MEMORY_INGEST_FANOUT,
  memoryIngestFanoutCap,
  orderAndCapPostAudience,
} from "@/lib/memory/fanout-cap";

const ORIGINAL = process.env.MEMORY_INGEST_MAX_FANOUT;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MEMORY_INGEST_MAX_FANOUT;
  else process.env.MEMORY_INGEST_MAX_FANOUT = ORIGINAL;
});

function withCap(value: string | undefined): number {
  if (value === undefined) delete process.env.MEMORY_INGEST_MAX_FANOUT;
  else process.env.MEMORY_INGEST_MAX_FANOUT = value;
  return memoryIngestFanoutCap();
}

describe("memoryIngestFanoutCap", () => {
  it("defaults when the knob is unset, empty or unusable", () => {
    for (const value of [undefined, "", "nonsense", "0", "-5"]) {
      expect(withCap(value)).toBe(DEFAULT_MEMORY_INGEST_MAX_FANOUT);
    }
  });

  it("honours a usable value", () => {
    expect(withCap("7")).toBe(7);
  });

  /** The boundary itself: the largest value Postgres can take, and the first one it cannot. */
  it("clamps to the Postgres integer range", () => {
    expect(MAX_MEMORY_INGEST_FANOUT).toBe(2_147_483_647);
    expect(withCap(String(MAX_MEMORY_INGEST_FANOUT))).toBe(MAX_MEMORY_INGEST_FANOUT);
    expect(withCap(String(MAX_MEMORY_INGEST_FANOUT + 1))).toBe(MAX_MEMORY_INGEST_FANOUT);
    expect(withCap("99999999999")).toBe(MAX_MEMORY_INGEST_FANOUT);
  });

  it("never hands out a value the deletion statement's ::int cast would reject", () => {
    for (const value of ["99999999999", String(Number.MAX_SAFE_INTEGER), "2147483648"]) {
      const cap = withCap(value);
      expect(Number.isSafeInteger(cap)).toBe(true);
      expect(cap).toBeGreaterThan(0);
      expect(cap).toBeLessThanOrEqual(2_147_483_647);
    }
  });
});

describe("orderAndCapPostAudience", () => {
  it("puts the author first, then members by id, then followers by id", () => {
    expect(orderAndCapPostAudience("author", ["m_b", "m_a"], ["f_b", "f_a"])).toEqual([
      "author",
      "m_a",
      "m_b",
      "f_a",
      "f_b",
    ]);
  });

  it("keeps the first occurrence of a duplicate, so a member who follows appears once", () => {
    expect(orderAndCapPostAudience("author", ["dual"], ["dual", "f_a"])).toEqual([
      "author",
      "dual",
      "f_a",
    ]);
    expect(orderAndCapPostAudience("author", ["author"], [])).toEqual(["author"]);
  });

  it("truncates at the cap, keeping the author", () => {
    withCap("2");
    expect(orderAndCapPostAudience("author", ["m_a", "m_b"], ["f_a"])).toEqual(["author", "m_a"]);
  });
});
