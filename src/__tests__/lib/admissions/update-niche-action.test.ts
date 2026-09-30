/**
 * @jest-environment node
 *
 * M11-2 u3f-core (admissions) R2-3 — `updateNiche` classifies a RACED close from the store's result,
 * not only from its pre-read.
 *
 * The action reads the application (fast/normal path), then calls the store's conditional UPDATE. A
 * staff admit/reject that lands between the pre-read and the write closes the application: the store
 * matches zero rows and returns null. The action must map that null to `application_closed` (the
 * same refusal the fast-path closed check answers), NEVER to `no_application` — the pre-read already
 * proved the application exists and was open.
 *
 * The facade is mocked so the two reads can be driven independently — the real store gates are proven
 * against a database in `admissions-expiry.test.ts` and against the memory store in
 * `events-coupling.test.ts`.
 */
jest.mock("@/lib/admissions", () => ({
  getDefaultOpenCycleId: jest.fn(),
  getApplicationByAgentCycle: jest.fn(),
  updateApplicationNiche: jest.fn(),
  ensureApplicationInPool: jest.fn(),
  acceptOfferAsAgent: jest.fn(),
  declineOfferAsAgent: jest.fn(),
  getOfferById: jest.fn(),
}));
jest.mock("@/lib/admissions/pool-policy", () => ({
  getAdmissionsPoolEligibility: jest.fn(),
}));

import { updateNiche } from "@/lib/actions/admissions";
import { getAdmissionsPoolEligibility } from "@/lib/admissions/pool-policy";
import { getDefaultOpenCycleId, getApplicationByAgentCycle, updateApplicationNiche } from "@/lib/admissions";
import type { StoredAgent } from "@/lib/store-types";
import type { StoredAdmissionsApplication } from "@/lib/admissions/types";

const eligibilityMock = getAdmissionsPoolEligibility as jest.Mock;
const cycleMock = getDefaultOpenCycleId as jest.Mock;
const preReadMock = getApplicationByAgentCycle as jest.Mock;
const storeMock = updateApplicationNiche as jest.Mock;

const AGENT = { id: "agent-1" } as StoredAgent;

function app(overrides: Partial<StoredAdmissionsApplication> = {}): StoredAdmissionsApplication {
  return {
    id: "app-1",
    agentId: AGENT.id,
    cycleId: "cycle-1",
    state: "in_pool",
    primaryDomain: null,
    nonGoals: null,
    evaluationPlan: null,
    dedupeSimilarityScore: null,
    dedupeFlagged: false,
    autoShortlistOk: false,
    rejectReasonCategory: null,
    reviewerNotesInternal: null,
    decidedAt: null,
    poolEnteredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  eligibilityMock.mockResolvedValue({ eligible: true });
  cycleMock.mockResolvedValue("cycle-1");
});

describe("updateNiche — the store is the authoritative editability gate", () => {
  it("maps a store null after an OPEN pre-read to application_closed, having reached the store", async () => {
    // Pre-read sees the application open; the conditional UPDATE then matches zero rows because a
    // staff decision closed it in the race window.
    preReadMock.mockResolvedValue(app({ state: "in_pool" }));
    storeMock.mockResolvedValue(null);

    const result = await updateNiche({ agent: AGENT, fields: { primaryDomain: "robotics" } });

    expect(storeMock).toHaveBeenCalledWith("app-1", { primaryDomain: "robotics" });
    expect(result).toEqual({
      ok: false,
      code: "bad_request",
      reason: "application_closed",
      message: "This application is no longer editable.",
    });
  });

  it("refuses a CLOSED application on the fast path without reaching the store", async () => {
    preReadMock.mockResolvedValue(app({ state: "rejected" }));

    const result = await updateNiche({ agent: AGENT, fields: { primaryDomain: "robotics" } });

    expect(storeMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      code: "bad_request",
      reason: "application_closed",
      message: "This application is no longer editable.",
    });
  });

  it("returns no_application only when the pre-read finds nothing", async () => {
    preReadMock.mockResolvedValue(null);

    const result = await updateNiche({ agent: AGENT, fields: { primaryDomain: "robotics" } });

    expect(storeMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "not_found", reason: "no_application" });
  });

  it("passes the edit through and returns the updated application on success", async () => {
    preReadMock.mockResolvedValue(app({ state: "in_pool" }));
    const updated = app({ primaryDomain: "robotics" });
    storeMock.mockResolvedValue(updated);

    const result = await updateNiche({ agent: AGENT, fields: { primaryDomain: "robotics" } });

    expect(result).toEqual({ ok: true, data: { application: updated } });
  });
});
