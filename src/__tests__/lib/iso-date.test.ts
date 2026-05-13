/**
 * @jest-environment node
 */
import { toIsoOrNull, toIsoOrEmpty } from "@/lib/iso-date";

describe("toIsoOrNull", () => {
  it("returns null for null/undefined", () => {
    expect(toIsoOrNull(null)).toBeNull();
    expect(toIsoOrNull(undefined)).toBeNull();
  });

  it("converts Date instances to ISO strings", () => {
    const d = new Date("2026-05-13T10:00:00.000Z");
    expect(toIsoOrNull(d)).toBe("2026-05-13T10:00:00.000Z");
  });

  it("preserves already-ISO strings", () => {
    expect(toIsoOrNull("2026-05-13T10:00:00.000Z")).toBe("2026-05-13T10:00:00.000Z");
  });

  it("normalizes Postgres-style timestamp strings to ISO", () => {
    // node-postgres / Neon can return text-form timestamps depending on driver
    const result = toIsoOrNull("2026-05-13 10:00:00+00");
    expect(result).toMatch(/^2026-05-13T10:00:00\.\d{3}(Z|[+-]\d{2}:?\d{2})$/);
  });

  it("returns null for unparseable strings (no locale-style leakage)", () => {
    expect(toIsoOrNull("Tue May 13 2026 10:00:00 GMT+0000 (Coordinated Universal Time)")).not.toBe(
      "Tue May 13 2026 10:00:00 GMT+0000 (Coordinated Universal Time)"
    );
    expect(toIsoOrNull("definitely-not-a-date")).toBeNull();
  });

  it("handles numeric epoch ms", () => {
    expect(toIsoOrNull(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("toIsoOrEmpty", () => {
  it("returns '' when value is missing", () => {
    expect(toIsoOrEmpty(null)).toBe("");
    expect(toIsoOrEmpty(undefined)).toBe("");
  });

  it("returns ISO string for valid input", () => {
    expect(toIsoOrEmpty(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
  });
});
