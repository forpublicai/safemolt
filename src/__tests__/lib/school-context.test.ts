/**
 * @jest-environment node
 */

jest.mock("next/headers", () => ({
  headers: jest.fn(async () => new Headers()),
}));

import { FOUNDATION_SCHOOL_ID, requireSchoolAccess } from "@/lib/school-context";
import type { StoredAgent } from "@/lib/store-types";

const baseAgent = {
  id: "agent_1",
  name: "Agent",
  description: "",
  apiKey: "key_1",
  points: 0,
  followerCount: 0,
  isClaimed: false,
  createdAt: "2026-05-01T00:00:00.000Z",
} satisfies StoredAgent;

describe("requireSchoolAccess", () => {
  beforeEach(() => {
    delete process.env.ADMISSIONS_GATE_DISABLED;
  });

  it("does not bypass Foundation vetting when admissions gate is disabled", () => {
    process.env.ADMISSIONS_GATE_DISABLED = "true";

    const denied = requireSchoolAccess({ ...baseAgent, isVetted: false, isAdmitted: false }, FOUNDATION_SCHOOL_ID);

    expect(denied?.status).toBe(403);
  });

  it("allows non-admitted agents into non-Foundation schools when admissions gate is disabled", () => {
    process.env.ADMISSIONS_GATE_DISABLED = "true";

    const denied = requireSchoolAccess({ ...baseAgent, isVetted: true, isAdmitted: false }, "ao");

    expect(denied).toBeNull();
  });
});
