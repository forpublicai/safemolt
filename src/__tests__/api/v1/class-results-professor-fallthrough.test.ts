/**
 * A valid professor key must never be worse than no key at all.
 *
 * M11-1 C20 gated the student branch of this route behind `requireAgent`, keyed on the presence of
 * a `Bearer` header. A professor key is not an agent key, so a professor who is NOT the class owner
 * resolved past the professor branch, entered the agent gate, and was answered 401 — while the very
 * same request with no Authorization header at all was served the public results. C20 exists to stop
 * a bearer from BUYING a capability, not to punish one for being presented, so a recognised
 * professor falls through to the public branch instead.
 *
 * `classes` is Postgres-only (CLAUDE.md), so the store and the professor reader are mocked; the
 * handler itself is the real one.
 *
 * @jest-environment node
 */

jest.mock("@/lib/auth-professor", () => ({
  getProfessorFromRequest: jest.fn(),
}));

jest.mock("@/lib/store", () => ({
  getClassById: jest.fn(),
  listClassEvaluations: jest.fn(),
  getClassEvaluationResults: jest.fn(),
  getStudentClassResults: jest.fn(),
}));

import { GET } from "@/app/api/v1/classes/[id]/results/route";

const { getProfessorFromRequest } = require("@/lib/auth-professor");
const {
  getClassById,
  listClassEvaluations,
  getClassEvaluationResults,
  getStudentClassResults,
} = require("@/lib/store");

const CLASS_ID = "class_pub";

function request(bearer?: string): Request {
  return new Request(`https://safemolt.com/api/v1/classes/${CLASS_ID}/results`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

function invoke(bearer?: string) {
  return GET(request(bearer) as never, { params: Promise.resolve({ id: CLASS_ID }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  getClassById.mockResolvedValue({ id: CLASS_ID, professorId: "prof_owner", status: "active" });
  listClassEvaluations.mockResolvedValue([
    { id: "eval_1", title: "Ethics", description: "d", taughtTopic: "t", status: "open", maxScore: 10, createdAt: "2026-01-01T00:00:00.000Z" },
  ]);
  getClassEvaluationResults.mockResolvedValue([{ agentId: "a1", score: 9 }]);
  getStudentClassResults.mockResolvedValue([]);
});

describe("GET /api/v1/classes/{id}/results", () => {
  it("serves the public view to an anonymous caller on an active class", async () => {
    getProfessorFromRequest.mockResolvedValue(null);

    const response = await invoke();

    expect(response.status).toBe(200);
    expect(getStudentClassResults).not.toHaveBeenCalled();
  });

  it("serves the public view to a NON-OWNING professor — a valid key is not worse than none", async () => {
    getProfessorFromRequest.mockResolvedValue({ id: "prof_other" });

    const response = await invoke("prof_other_key");

    expect(response.status).toBe(200);
    // Fell through to public, not into the agent gate and not into the student branch.
    expect(getStudentClassResults).not.toHaveBeenCalled();
  });

  it("still gives the owning professor the full view", async () => {
    getProfessorFromRequest.mockResolvedValue({ id: "prof_owner" });

    const response = await invoke("prof_owner_key");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].evaluation.id).toBe("eval_1");
    expect(getStudentClassResults).not.toHaveBeenCalled();
  });

  it("still refuses everyone on a draft class, professor key or not", async () => {
    getClassById.mockResolvedValue({ id: CLASS_ID, professorId: "prof_owner", status: "draft" });
    getProfessorFromRequest.mockResolvedValue({ id: "prof_other" });

    const response = await invoke("prof_other_key");

    expect(response.status).toBe(401);
  });
});
