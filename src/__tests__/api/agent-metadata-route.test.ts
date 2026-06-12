/**
 * @jest-environment node
 *
 * M9 C2: /api/v1/internal/agent-metadata must require its own dedicated
 * secret (the shared event-ingest token must be rejected) and only merge
 * ao_*-prefixed metadata keys.
 */

jest.mock("@/lib/store", () => ({
  getAgentById: jest.fn(),
  updateAgent: jest.fn(),
}));

import { POST } from "@/app/api/v1/internal/agent-metadata/route";
import { getAgentById, updateAgent } from "@/lib/store";

const mockedGetAgentById = jest.mocked(getAgentById);
const mockedUpdateAgent = jest.mocked(updateAgent);

const ENV_KEYS = [
  "SCHOOL_METADATA_SECRET",
  "SCHOOL_METADATA_SECRET_AO",
  "SCHOOL_EVENT_SECRET",
  "SCHOOL_EVENT_SECRET_AO",
] as const;
const originalEnv: Record<string, string | undefined> = {};

function makeRequest(token: string, body: unknown): Request {
  return new Request("http://localhost/api/v1/internal/agent-metadata", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

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
  process.env.SCHOOL_METADATA_SECRET_AO = "metadata-secret";
  process.env.SCHOOL_EVENT_SECRET = "ingest-secret";
  process.env.SCHOOL_EVENT_SECRET_AO = "ingest-secret-ao";
  mockedGetAgentById.mockResolvedValue({
    id: "agent-1",
    name: "agent-1",
    description: "",
    apiKey: "k",
    points: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: { ao_existing: "keep", other: "untouched" },
  } as Awaited<ReturnType<typeof getAgentById>>);
});

describe("POST /api/v1/internal/agent-metadata", () => {
  it("rejects the shared event-ingest tokens", async () => {
    for (const leaked of ["ingest-secret", "ingest-secret-ao"]) {
      const response = await POST(
        makeRequest(leaked, { agent_id: "agent-1", metadata: { ao_status: "active" } })
      );
      expect(response.status).toBe(401);
    }
    expect(mockedUpdateAgent).not.toHaveBeenCalled();
  });

  it("returns 503 when no metadata secret is configured", async () => {
    delete process.env.SCHOOL_METADATA_SECRET_AO;

    const response = await POST(
      makeRequest("anything", { agent_id: "agent-1", metadata: { ao_status: "active" } })
    );

    expect(response.status).toBe(503);
  });

  it("rejects non-ao_* metadata keys without writing", async () => {
    const response = await POST(
      makeRequest("metadata-secret", {
        agent_id: "agent-1",
        metadata: { ao_status: "active", is_vetted: true },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.hint).toContain("is_vetted");
    expect(mockedUpdateAgent).not.toHaveBeenCalled();
  });

  it("merges ao_* keys over existing metadata with the dedicated secret", async () => {
    const response = await POST(
      makeRequest("metadata-secret", {
        agent_id: "agent-1",
        metadata: { ao_status: "active" },
      })
    );

    expect(response.status).toBe(200);
    expect(mockedUpdateAgent).toHaveBeenCalledWith("agent-1", {
      metadata: { ao_existing: "keep", other: "untouched", ao_status: "active" },
    });
  });
});
