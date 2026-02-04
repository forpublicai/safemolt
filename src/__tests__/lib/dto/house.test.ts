import { toApiHouse, toApiMember, toApiMemberSafe } from "@/lib/groups/houses/dto";
import type { StoredHouse, StoredHouseMember, StoredAgent } from "@/lib/store-types";
import { GroupType } from "@/lib/groups/types";

describe("House DTOs", () => {
  describe("toApiHouse", () => {
    it("converts camelCase to snake_case and extends ApiGroup", () => {
      const house: StoredHouse = {
        id: "house-123",
        type: GroupType.HOUSES,
        name: "Test House",
        description: null,
        founderId: "agent-456",
        avatarUrl: null,
        settings: {},
        visibility: "public",
        points: 100,
        createdAt: "2024-01-15T10:00:00Z",
      };

      const result = toApiHouse(house);

      // Verify it includes all ApiGroup fields plus points
      expect(result).toEqual({
        id: "house-123",
        type: "houses",
        name: "Test House",
        description: null,
        founder_id: "agent-456",
        avatar_url: null,
        settings: {},
        visibility: "public",
        created_at: "2024-01-15T10:00:00Z",
        points: 100,
      });
    });

    it("preserves all house fields and includes group metadata", () => {
      const house: StoredHouse = {
        id: "house-abc",
        type: GroupType.HOUSES,
        name: "Another House",
        description: null,
        founderId: "founder-xyz",
        avatarUrl: null,
        settings: {},
        visibility: "public",
        points: 500,
        createdAt: "2024-02-20T15:30:00Z",
      };

      const result = toApiHouse(house);

      // Verify house-specific fields
      expect(result.id).toBe(house.id);
      expect(result.name).toBe(house.name);
      expect(result.founder_id).toBe(house.founderId);
      expect(result.points).toBe(house.points);
      expect(result.created_at).toBe(house.createdAt);

      // Verify ApiGroup fields are present
      expect(result.type).toBe("houses");
      expect(result.description).toBe(null);
      expect(result.avatar_url).toBe(null);
      expect(result.settings).toEqual({});
      expect(result.visibility).toBe("public");
    });
  });

  describe("toApiMember", () => {
    const member: StoredHouseMember = {
      agentId: "agent-123",
      houseId: "house-456",
      karmaAtJoin: 50,
      joinedAt: "2024-01-20T12:00:00Z",
    };

    const agent: StoredAgent = {
      id: "agent-123",
      name: "TestAgent",
      description: "A test agent",
      apiKey: "key-abc",
      karma: 150,
      followerCount: 10,
      isClaimed: true,
      createdAt: "2024-01-01T00:00:00Z",
    };

    it("calculates karma_contributed correctly", () => {
      const result = toApiMember(member, agent);

      // karma_contributed = agent.karma - member.karmaAtJoin = 150 - 50 = 100
      expect(result.karma_contributed).toBe(100);
    });

    it("converts camelCase to snake_case", () => {
      const result = toApiMember(member, agent);

      expect(result).toEqual({
        agent_id: "agent-123",
        agent_name: "TestAgent",
        karma_at_join: 50,
        karma_contributed: 100,
        joined_at: "2024-01-20T12:00:00Z",
      });
    });

    it("handles zero karma contribution", () => {
      const zeroKarmaAgent: StoredAgent = {
        ...agent,
        karma: 50, // Same as karmaAtJoin
      };

      const result = toApiMember(member, zeroKarmaAgent);

      expect(result.karma_contributed).toBe(0);
    });

    it("handles negative karma contribution (karma loss)", () => {
      const negativeKarmaAgent: StoredAgent = {
        ...agent,
        karma: 30, // Less than karmaAtJoin (50)
      };

      const result = toApiMember(member, negativeKarmaAgent);

      expect(result.karma_contributed).toBe(-20);
    });
  });

  describe("toApiMemberSafe", () => {
    const member: StoredHouseMember = {
      agentId: "agent-deleted",
      houseId: "house-123",
      karmaAtJoin: 75,
      joinedAt: "2024-01-25T08:00:00Z",
    };

    it("returns Unknown for deleted agents", () => {
      const result = toApiMemberSafe(member, null);

      expect(result.agent_name).toBe("Unknown");
      expect(result.agent_id).toBe("agent-deleted");
      expect(result.karma_contributed).toBe(0);
      expect(result.karma_at_join).toBe(75);
      expect(result.joined_at).toBe("2024-01-25T08:00:00Z");
    });

    it("delegates to toApiMember when agent exists", () => {
      const agent: StoredAgent = {
        id: "agent-deleted",
        name: "ActiveAgent",
        description: "Still active",
        apiKey: "key-xyz",
        karma: 200,
        followerCount: 5,
        isClaimed: false,
        createdAt: "2024-01-10T00:00:00Z",
      };

      const result = toApiMemberSafe(member, agent);

      expect(result.agent_name).toBe("ActiveAgent");
      expect(result.karma_contributed).toBe(125); // 200 - 75
    });

    it("returns full member data structure for null agent", () => {
      const result = toApiMemberSafe(member, null);

      expect(result).toEqual({
        agent_id: "agent-deleted",
        agent_name: "Unknown",
        karma_at_join: 75,
        karma_contributed: 0,
        joined_at: "2024-01-25T08:00:00Z",
      });
    });
  });
});
