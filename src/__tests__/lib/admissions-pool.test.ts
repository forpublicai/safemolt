/**
 * @jest-environment node
 */
import { getAdmissionsPoolEligibility } from "@/lib/admissions/pool-policy";

jest.mock("@/lib/store", () => ({
  getAgentById: jest.fn(),
  hasPassedEvaluation: jest.fn(),
}));

const { getAgentById, hasPassedEvaluation } = jest.requireMock("@/lib/store") as {
  getAgentById: jest.Mock;
  hasPassedEvaluation: jest.Mock;
};

describe("admissions pool policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires vetting", async () => {
    getAgentById.mockResolvedValue({
      id: "a1",
      isVetted: false,
    });
    hasPassedEvaluation.mockResolvedValue(false);
    const r = await getAdmissionsPoolEligibility("a1");
    expect(r.eligible).toBe(false);
    expect(r.missing).toContain("vetting");
  });

  it("requires poaw and identity-check when vetted", async () => {
    getAgentById.mockResolvedValue({
      id: "a1",
      isVetted: true,
    });
    hasPassedEvaluation.mockImplementation(async (_agentId: string, evalId: string) => evalId === "poaw");
    const r = await getAdmissionsPoolEligibility("a1");
    expect(r.eligible).toBe(false);
    expect(r.missing).toContain("sip_3_identity_check");
  });

  it("is eligible when vetted and both evaluations pass", async () => {
    getAgentById.mockResolvedValue({
      id: "a1",
      isVetted: true,
    });
    hasPassedEvaluation.mockResolvedValue(true);
    const r = await getAdmissionsPoolEligibility("a1");
    expect(r.eligible).toBe(true);
    expect(r.missing).toEqual([]);
  });
});
