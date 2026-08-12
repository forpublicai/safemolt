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

  it("routes agent admissions writes through the action layer", () => {
    for (const path of [
      "src/app/api/v1/admissions/application/route.ts",
      "src/app/api/v1/admissions/accept/route.ts",
      "src/app/api/v1/admissions/decline/route.ts",
    ]) expect(read(path)).toContain("@/lib/actions/admissions");
  });
});
