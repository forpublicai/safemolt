/**
 * M9 C4/B1: saveEvaluationResult is unified across db and memory — both sides
 * compute score-aware points (passed ? score ?? definition points ?? 0 : null)
 * and both persist school_id.
 */

jest.mock("@/lib/evaluations/loader", () => ({
  getEvaluation: jest.fn((id: string) =>
    id === "sip-known" ? { points: 7, version: "2.0.0" } : null
  ),
}));

jest.mock("@/lib/store/activity/events", () => ({
  recordEvaluationResultActivityEvent: jest.fn(() => Promise.resolve()),
}));

import { computeEvaluationResultFields } from "@/lib/store/evaluations/result-fields";

describe("computeEvaluationResultFields", () => {
  it("prefers the score over definition points when passed", () => {
    expect(
      computeEvaluationResultFields({ evaluationId: "sip-known", passed: true, score: 42 })
    ).toEqual({ pointsEarned: 42, evaluationVersion: "2.0.0" });
  });

  it("falls back to definition points for unscored passes", () => {
    expect(
      computeEvaluationResultFields({ evaluationId: "sip-known", passed: true })
    ).toEqual({ pointsEarned: 7, evaluationVersion: "2.0.0" });
  });

  it("awards null points on fail and defaults the version", () => {
    expect(
      computeEvaluationResultFields({ evaluationId: "unknown", passed: false, score: 10 })
    ).toEqual({ pointsEarned: null, evaluationVersion: "1.0.0" });
  });
});

describe("memory saveEvaluationResult (unified behavior)", () => {
  it("is score-aware and school-scoped", async () => {
    const mem = await import("@/lib/store/evaluations/memory");

    const before = await mem.getEvaluationResultCount("school-x");
    const resultId = await mem.saveEvaluationResult(
      "reg-1",
      "agent-1",
      "sip-known",
      true,
      42,
      100,
      undefined,
      undefined,
      undefined,
      undefined,
      "school-x"
    );

    expect(await mem.getEvaluationResultCount("school-x")).toBe(before + 1);
    const saved = await mem.getEvaluationResultById(resultId);
    expect(saved?.pointsEarned).toBe(42);
  });
});

describe("db saveEvaluationResult (unified behavior)", () => {
  it("persists school_id and score-aware points", async () => {
    jest.resetModules();
    const inserts: { text: string; params: unknown[] }[] = [];
    jest.doMock("@/lib/db", () => ({
      hasDatabase: () => true,
      sql: (strings: TemplateStringsArray, ...params: unknown[]) => {
        inserts.push({ text: strings.join("$"), params });
        return Promise.resolve([]);
      },
    }));
    jest.doMock("@/lib/store/activity/events", () => ({
      recordEvaluationResultActivityEvent: jest.fn(() => Promise.resolve()),
    }));
    jest.doMock("@/lib/evaluations/loader", () => ({
      getEvaluation: jest.fn(() => ({ points: 7, version: "2.0.0" })),
    }));

    const db = await import("@/lib/store/evaluations/db");
    await db.saveEvaluationResult(
      "reg-1",
      "agent-1",
      "sip-known",
      true,
      42,
      100,
      undefined,
      undefined,
      undefined,
      undefined,
      "school-x"
    );

    const insert = inserts.find((q) => q.text.includes("INSERT INTO evaluation_results"));
    expect(insert).toBeDefined();
    expect(insert!.text).toContain("school_id");
    expect(insert!.params).toContain("school-x");
    expect(insert!.params).toContain(42); // points_earned = score, not flat points
  });

  it("defaults school_id to foundation to match the column default", async () => {
    jest.resetModules();
    const inserts: { text: string; params: unknown[] }[] = [];
    jest.doMock("@/lib/db", () => ({
      hasDatabase: () => true,
      sql: (strings: TemplateStringsArray, ...params: unknown[]) => {
        inserts.push({ text: strings.join("$"), params });
        return Promise.resolve([]);
      },
    }));
    jest.doMock("@/lib/store/activity/events", () => ({
      recordEvaluationResultActivityEvent: jest.fn(() => Promise.resolve()),
    }));
    jest.doMock("@/lib/evaluations/loader", () => ({
      getEvaluation: jest.fn(() => ({ points: 7, version: "2.0.0" })),
    }));

    const db = await import("@/lib/store/evaluations/db");
    await db.saveEvaluationResult("reg-2", "agent-1", "sip-known", true);

    const insert = inserts.find((q) => q.text.includes("INSERT INTO evaluation_results"));
    expect(insert!.params).toContain("foundation");
    expect(insert!.params).toContain(7); // unscored pass falls back to definition points
  });
});
