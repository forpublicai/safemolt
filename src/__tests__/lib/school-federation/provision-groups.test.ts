/**
 * @jest-environment node
 *
 * M9 C7: school-group provisioning must go through the canonical
 * @/lib/store createGroup (with its new schoolId parameter), not a raw
 * INSERT, and the schools/:id/groups route must use an explicit
 * service-auth sentinel.
 */

jest.mock("@/lib/db", () => ({
  hasDatabase: () => true,
  sql: jest.fn(() => Promise.resolve([])),
}));

jest.mock("@/lib/store", () => ({
  getSchool: jest.fn(async (id: string) =>
    id === "ao" ? { id: "ao", name: "AO" } : null
  ),
  getGroup: jest.fn(async () => null),
  createGroup: jest.fn(async () => ({ id: "ao-forum", name: "ao-forum" })),
  listGroups: jest.fn(async () => []),
  getAgentByApiKey: jest.fn(async () => null),
  // M11-1 C4: auth resolves through the combined lookup-and-touch helper.
  authenticateAndTouchByApiKey: jest.fn(async () => null),
  touchAgentLastActiveAtIfStale: jest.fn(async () => undefined),
}));

import { provisionSchoolGroup } from "@/lib/school-federation/provision-groups";
import { createGroup } from "@/lib/store";
import { GET as listSchoolGroups } from "@/app/api/v1/schools/[id]/groups/route";

const mockedCreateGroup = jest.mocked(createGroup);

const ENV_KEYS = ["SCHOOL_SERVICE_SECRET", "SCHOOL_SERVICE_SECRET_AO"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("provisionSchoolGroup", () => {
  it("creates the group through the canonical store createGroup with schoolId", async () => {
    const result = await provisionSchoolGroup("ao", { name: "AO Forum" });

    expect(result).toEqual({ name: "AO Forum", group_id: "aoforum", created: true });
    expect(mockedCreateGroup).toHaveBeenCalledWith(
      "AO Forum",
      "AO Forum",
      expect.stringContaining("(AO)"),
      expect.any(String),
      "group",
      undefined,
      "ao"
    );
  });
});

describe("GET /api/v1/schools/:id/groups auth sentinel", () => {
  function makeRequest(token?: string): Request {
    return new Request("http://localhost/api/v1/schools/ao/groups", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }
  const params = { params: Promise.resolve({ id: "ao" }) };

  it("authorizes the service secret", async () => {
    process.env.SCHOOL_SERVICE_SECRET_AO = "svc-secret";
    const response = await listSchoolGroups(makeRequest("svc-secret"), params);
    expect(response.status).toBe(200);
  });

  it("fails loudly with 503 when the secret is unconfigured and no agent key is given", async () => {
    const response = await listSchoolGroups(makeRequest("anything"), params);
    expect(response.status).toBe(503);
  });

  it("rejects a wrong service token without an agent key", async () => {
    process.env.SCHOOL_SERVICE_SECRET_AO = "svc-secret";
    const response = await listSchoolGroups(makeRequest("wrong"), params);
    expect(response.status).toBe(401);
  });
});
