import fs from "node:fs";

const read = (path: string) => fs.readFileSync(path, "utf8");

describe("u3f core migration seams", () => {
  it("routes class agent mutations through the action layer", () => {
    expect(read("src/app/api/v1/classes/[id]/enroll/route.ts")).toContain("@/lib/actions/classes");
    expect(read("src/app/api/v1/classes/[id]/drop/route.ts")).toContain("@/lib/actions/classes");
    expect(read("src/app/api/v1/classes/[id]/evaluations/[evalId]/submit/route.ts")).toContain("@/lib/actions/classes");
  });

  it("keeps mixed class messages split and class refresh operator-owned", () => {
    const messages = read("src/app/api/v1/classes/[id]/sessions/[sessionId]/messages/route.ts");
    expect(messages).toContain("@/lib/actions/classes");
    expect(messages).toContain("@/lib/class-ops");
    expect(messages).not.toContain("addClassSessionMessage,");
    expect(read("src/app/api/v1/classes/[id]/route.ts")).toContain("@/lib/class-ops");
  });

  it("detects the agent teaching-assistant in the messages route (B3 split)", () => {
    const messages = read("src/app/api/v1/classes/[id]/sessions/[sessionId]/messages/route.ts");
    // The route routes the professor and the agent-TA to the operator writer, and only the enrolled
    // student to the action — so the assistant is detected HERE, not inside the student action.
    expect(messages).toContain("isClassAssistant");
    expect(messages).toContain("addOperatorClassSessionMessage");
    expect(messages).toContain("sendSessionMessage");
    const action = read("src/lib/actions/classes.ts");
    expect(action).not.toContain("isClassAssistant");
  });

  it("moves the professor PATCH write behind class-ops (M8: no mutating store import)", () => {
    const detail = read("src/app/api/v1/classes/[id]/route.ts");
    expect(detail).toContain("updateClassSettings");
    // The route imports the operator entry point, not the mutating store export.
    expect(detail).not.toMatch(/\bupdateClass\b/);
    expect(read("src/lib/class-ops/index.ts")).toContain("export async function updateClassSettings");
  });

  it("routes class agent mutations behind the school-denial reason codes (M9)", () => {
    for (const path of [
      "src/app/api/v1/classes/[id]/enroll/route.ts",
      "src/app/api/v1/classes/[id]/drop/route.ts",
      "src/app/api/v1/classes/[id]/evaluations/[evalId]/submit/route.ts",
      "src/app/api/v1/classes/[id]/sessions/[sessionId]/messages/route.ts",
    ]) {
      expect(read(path)).toContain("schoolAccessDenialResponse");
    }
    expect(read("src/lib/actions/classes.ts")).toContain("schoolAccessDenialReason");
  });

  it("makes the class message and evaluation tool executors pure adapters (M8)", () => {
    const tools = read("src/lib/agent-tools/definitions/classes.ts");
    // No pre-read of the session or evaluation to synthesize a not_found; the action decides it.
    expect(tools).not.toMatch(/getClassSession\b/);
    expect(tools).not.toMatch(/getClassEvaluation\b/);
  });

  it("keeps the gated student message writer beside the plain operator writer", () => {
    expect(read("src/lib/store/classes/index.ts")).toContain("addSessionMessageAsStudent");
    const db = read("src/lib/store/classes/db.ts");
    expect(db).toContain("export async function addSessionMessageAsStudent");
    expect(db).toContain("export async function addClassSessionMessage");
  });

  it("routes agent admissions writes through the action layer", () => {
    for (const path of [
      "src/app/api/v1/admissions/application/route.ts",
      "src/app/api/v1/admissions/accept/route.ts",
      "src/app/api/v1/admissions/decline/route.ts",
    ]) expect(read(path)).toContain("@/lib/actions/admissions");
  });
});
