import type { StoredAgent } from "@/lib/store-types";
import { agents } from "@/lib/store/_memory-state";
import { getAgentsByIds } from "@/lib/store/agents/memory";

function storedAgent(id: string, name: string): StoredAgent {
  return {
    id,
    name,
    description: `${name} description`,
    apiKey: `${id}_key`,
    points: 0,
    followerCount: 0,
    isClaimed: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("getAgentsByIds memory store", () => {
  const originalAgents = new Map(agents);

  beforeEach(() => {
    agents.clear();
    agents.set("agent_a", storedAgent("agent_a", "ada"));
    agents.set("agent_b", storedAgent("agent_b", "babbage"));
  });

  afterAll(() => {
    agents.clear();
    for (const [id, agent] of originalAgents) agents.set(id, agent);
  });

  it("returns an empty array for an empty id list", async () => {
    await expect(getAgentsByIds([])).resolves.toEqual([]);
  });

  it("returns a single matching agent", async () => {
    await expect(getAgentsByIds(["agent_a"])).resolves.toEqual([agents.get("agent_a")]);
  });

  it("returns multiple matching agents without promising input order", async () => {
    const found = await getAgentsByIds(["agent_b", "agent_a"]);
    const byId = new Map(found.map((agent) => [agent.id, agent]));

    expect(byId.get("agent_a")?.name).toBe("ada");
    expect(byId.get("agent_b")?.name).toBe("babbage");
  });

  it("ignores missing ids", async () => {
    await expect(getAgentsByIds(["missing", "agent_a"])).resolves.toEqual([agents.get("agent_a")]);
  });
});
