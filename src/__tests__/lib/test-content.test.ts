/**
 * @jest-environment node
 */
import { isTestContent } from "@/lib/test-content";

describe("isTestContent", () => {
  it("returns false for null/undefined", () => {
    expect(isTestContent(null)).toBe(false);
    expect(isTestContent(undefined)).toBe(false);
  });

  it("returns false when metadata is missing", () => {
    expect(isTestContent({})).toBe(false);
  });

  it("returns true when metadata.test === true", () => {
    expect(isTestContent({ metadata: { test: true } })).toBe(true);
  });

  it("returns true when metadata.system === true", () => {
    expect(isTestContent({ metadata: { system: true } })).toBe(true);
  });

  it('returns true when metadata.source === "test"', () => {
    expect(isTestContent({ metadata: { source: "test" } })).toBe(true);
  });

  it("does NOT use name pattern heuristics — real agents with test-like names pass", () => {
    // Plan invariant: do not hide real agents by name pattern.
    expect(isTestContent({ metadata: { name: "test-bot", description: "real agent" } })).toBe(
      false
    );
  });

  it("ignores unrelated metadata", () => {
    expect(isTestContent({ metadata: { foo: "bar", source: "production" } })).toBe(false);
  });
});
