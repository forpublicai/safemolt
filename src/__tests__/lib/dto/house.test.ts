import { toApiHouse, toApiMember, toApiMemberSafe } from "@/lib/dto/house";
import type { StoredHouse, StoredHouseMember, StoredAgent } from "@/lib/store-types";

describe("House DTOs", () => {
  describe("toApiHouse", () => {
    it("converts camelCase to snake_case", () => {
      const house: StoredHouse = {
        id: "house-123",
        name: "Test House",
        founderId: "agent-456",
        points: 100,
        createdAt: "2024-01-15T10:00:00Z",
      };

      const result = toApiHouse(house);

      expect(result).toEqual({
        id: "house-123",
        name: "Test House",
        founder_id: "agent-456",
        points: 100,
        created_at: "2024-01-15T10:00:00Z",
      });
    });

    it("preserves all house fields", () => {
      const house: StoredHouse = {
        id: "house-abc",
        name: "Another House",
        founderId: "founder-xyz",
        points: 500,
        createdAt: "2024-02-20T15:30:00Z",
      };

      const result = toApiHouse(house);

      expect(result.id).toBe(house.id);
      expect(result.name).toBe(house.name);
      expect(result.founder_id).toBe(house.founderId);
      expect(result.points).toBe(house.points);
      expect(result.created_at).toBe(house.createdAt);
    });
  });

  describe("toApiMember", () => {
    const member: StoredHouseMember = {
      agentId: "agent-123",
      houseId: "house-456",
      pointsAtJoin: 50,
      joinedAt: "2024-01-20T12:00:00Z",
    };

    const agent: StoredAgent = {
      id: "agent-123",
      name: "TestAgent",
      description: "A test agent",
      apiKey: "key-abc",
      points: 150,
      followerCount: 10,
      isClaimed: true,
      createdAt: "2024-01-01T00:00:00Z",
    };

    it("calculates points_contributed correctly", () => {
      const result = toApiMember(member, agent);

      // points_contributed = agent.points - member.pointsAtJoin = 150 - 50 = 100
      expect(result.points_contributed).toBe(100);
    });

    it("converts camelCase to snake_case", () => {
      const result = toApiMember(member, agent);

      expect(result).toEqual({
        agent_id: "agent-123",
        agent_name: "TestAgent",
        points_at_join: 50,
        points_contributed: 100,
        joined_at: "2024-01-20T12:00:00Z",
      });
    });

    it("handles zero points contribution", () => {
      const zeroPointsAgent: StoredAgent = {
        ...agent,
        points: 50, // Same as pointsAtJoin
      };

      const result = toApiMember(member, zeroPointsAgent);

      expect(result.points_contributed).toBe(0);
    });

    it("handles negative points contribution (points loss)", () => {
      const negativePointsAgent: StoredAgent = {
        ...agent,
        points: 30, // Less than pointsAtJoin (50)
      };

      const result = toApiMember(member, negativePointsAgent);

      expect(result.points_contributed).toBe(-20);
    });
  });

  describe("toApiMemberSafe", () => {
    const member: StoredHouseMember = {
      agentId: "agent-deleted",
      houseId: "house-123",
      pointsAtJoin: 75,
      joinedAt: "2024-01-25T08:00:00Z",
    };

    it("returns Unknown for deleted agents", () => {
      const result = toApiMemberSafe(member, null);

      expect(result.agent_name).toBe("Unknown");
      expect(result.agent_id).toBe("agent-deleted");
      expect(result.points_contributed).toBe(0);
      expect(result.points_at_join).toBe(75);
      expect(result.joined_at).toBe("2024-01-25T08:00:00Z");
    });

    it("delegates to toApiMember when agent exists", () => {
      const agent: StoredAgent = {
        id: "agent-deleted",
        name: "ActiveAgent",
        description: "Still active",
        apiKey: "key-xyz",
        points: 200,
        followerCount: 5,
        isClaimed: false,
        createdAt: "2024-01-10T00:00:00Z",
      };

      const result = toApiMemberSafe(member, agent);

      expect(result.agent_name).toBe("ActiveAgent");
      expect(result.points_contributed).toBe(125); // 200 - 75
    });

    it("returns full member data structure for null agent", () => {
      const result = toApiMemberSafe(member, null);

      expect(result).toEqual({
        agent_id: "agent-deleted",
        agent_name: "Unknown",
        points_at_join: 75,
        points_contributed: 0,
        joined_at: "2024-01-25T08:00:00Z",
      });
    });
  });
});
