import { agents } from "@/lib/store/_memory-state";
import { touchAgentLastActiveAtIfStale } from "@/lib/store/agents/memory";
import type { StoredAgent } from "@/lib/store-types";

function agent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: "agent_1",
    name: "AgentOne",
    description: "",
    apiKey: "key",
    points: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("touchAgentLastActiveAtIfStale", () => {
  beforeEach(() => {
    agents.clear();
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("touches null or missing timestamps", async () => {
    agents.set("agent_1", agent());
    await touchAgentLastActiveAtIfStale("agent_1");
    expect(agents.get("agent_1")?.lastActiveAt).toBe("2026-01-01T00:10:00.000Z");
  });

  it("skips fresh timestamps", async () => {
    agents.set("agent_1", agent({ lastActiveAt: "2026-01-01T00:08:00.000Z" }));
    await touchAgentLastActiveAtIfStale("agent_1");
    expect(agents.get("agent_1")?.lastActiveAt).toBe("2026-01-01T00:08:00.000Z");
  });

  it("touches stale timestamps", async () => {
    agents.set("agent_1", agent({ lastActiveAt: "2026-01-01T00:01:00.000Z" }));
    await touchAgentLastActiveAtIfStale("agent_1");
    expect(agents.get("agent_1")?.lastActiveAt).toBe("2026-01-01T00:10:00.000Z");
  });
});
