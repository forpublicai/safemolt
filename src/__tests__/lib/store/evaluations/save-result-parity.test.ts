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

  it("scales the award to the storage scale, so both stores persist the same number (M11-1C)", () => {
    // `evaluation_results.points_earned` is `DECIMAL(5,2)`: Postgres rounds every result row to two
    // places as it writes it, while the memory store persists whatever number it was handed. Two
    // awards of 0.004 would then sum to 0.00 in Postgres and 0.01 in memory — a silent store-parity
    // break, and the karma components inherit it. Scaling here, in the one helper both writers
    // share, is what keeps them identical.
    expect(
      computeEvaluationResultFields({ evaluationId: "sip-known", passed: true, score: 0.004 })
        .pointsEarned
    ).toBe(0);
    expect(
      computeEvaluationResultFields({ evaluationId: "sip-known", passed: true, score: 2.345 })
        .pointsEarned
    ).toBe(2.35);
  });

  it("floors a negative award at zero, because the invariant cannot survive one (M11-1C)", () => {
    // NOT a hypothetical. `parseJudgeResponse` builds `totalScore` with a bare
    // `Number(parsed.totalScore)` over an LLM's JSON and checks neither the sign nor whether it
    // agrees with `passed`, so a malformed verdict reaches `saveEvaluationResult` intact.
    //
    // Unfloored, the recompute writes `evaluation_points` as the raw aggregate but moves `points`
    // by `GREATEST(0, points + delta)`. For an agent at zero receiving −5 that is
    // `points = 0, evaluation_points = -5`, and `points = legacy + vote + evaluation` is false.
    // There is deliberately no `CHECK` constraint, so nothing raises — the published karma
    // breakdown simply stops summing to `total`.
    expect(
      computeEvaluationResultFields({ evaluationId: "sip-known", passed: true, score: -5 })
        .pointsEarned
    ).toBe(0);
    // Half away from zero is a `toKarmaScale` property and is gated directly in
    // `karma-scale.test.ts`; here the floor is what wins, so a sub-cent negative is 0 rather
    // than -0.13.
    expect(
      computeEvaluationResultFields({ evaluationId: "sip-known", passed: true, score: -0.125 })
        .pointsEarned
    ).toBe(0);
  });

  it("refuses NaN, which one bad verdict would otherwise make permanent", () => {
    // `Number(undefined)` is `NaN`, Postgres `NUMERIC` accepts `'NaN'`, and a single `NaN` row
    // poisons `SUM(points_earned)` for that agent forever — every later recompute yields `NaN`.
    expect(
      computeEvaluationResultFields({ evaluationId: "sip-known", passed: true, score: Number.NaN })
        .pointsEarned
    ).toBe(0);
    expect(
      computeEvaluationResultFields({ evaluationId: "sip-known", passed: true, score: Infinity })
        .pointsEarned
    ).toBe(0);
  });
});

describe("memory saveEvaluationResult (unified behavior)", () => {
  it("is score-aware and school-scoped", async () => {
    const mem = await import("@/lib/store/evaluations/memory");

    // C21: the save is gated on an actionable registration, so one must exist first.
    const reg = await mem.registerForEvaluation("agent-1", "sip-known");
    if (!reg) throw new Error("registration refused — no prior pass exists, so this cannot happen here");
    const before = await mem.getEvaluationResultCount("school-x");
    const saved = await mem.saveEvaluationResult(
      reg.id,
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

    if (saved.outcome !== "created") throw new Error(`expected created, got ${saved.outcome}`);
    expect(await mem.getEvaluationResultCount("school-x")).toBe(before + 1);
    const row = await mem.getEvaluationResultById(saved.resultId);
    expect(row?.pointsEarned).toBe(42);
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
