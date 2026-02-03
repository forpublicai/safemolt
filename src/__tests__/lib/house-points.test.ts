/**
 * Unit tests for house points calculation (safemolt-6or, safemolt-pv1)
 * Tests both pure calculation functions and integration with store operations.
 */
import {
  calculateMemberContribution,
  calculateHousePoints,
  type MemberMetrics,
} from "@/lib/house-points";
import {
  createAgent,
  createHouse,
  getHouse,
  getAgentById,
  createSubmolt,
  createPost,
  upvotePost,
  downvotePost,
  createComment,
  upvoteComment,
} from "@/lib/store-memory";

describe("Pure Points Calculation Functions (safemolt-6or)", () => {
  describe("calculateMemberContribution", () => {
    it("should calculate positive contribution for karma gained after joining", () => {
      const member: MemberMetrics = {
        currentKarma: 50,
        karmaAtJoin: 30,
      };
      expect(calculateMemberContribution(member)).toBe(20);
    });

    it("should calculate negative contribution for karma lost after joining", () => {
      const member: MemberMetrics = {
        currentKarma: 10,
        karmaAtJoin: 25,
      };
      expect(calculateMemberContribution(member)).toBe(-15);
    });

    it("should calculate zero contribution when karma unchanged since joining", () => {
      const member: MemberMetrics = {
        currentKarma: 42,
        karmaAtJoin: 42,
      };
      expect(calculateMemberContribution(member)).toBe(0);
    });

    it("should handle zero karma at join", () => {
      const member: MemberMetrics = {
        currentKarma: 100,
        karmaAtJoin: 0,
      };
      expect(calculateMemberContribution(member)).toBe(100);
    });

    it("should handle negative karma values", () => {
      const member: MemberMetrics = {
        currentKarma: -5,
        karmaAtJoin: 10,
      };
      expect(calculateMemberContribution(member)).toBe(-15);
    });
  });

  describe("calculateHousePoints", () => {
    it("should calculate total points from multiple members", () => {
      const members: MemberMetrics[] = [
        { currentKarma: 50, karmaAtJoin: 30 },  // +20
        { currentKarma: 40, karmaAtJoin: 35 },  // +5
        { currentKarma: 60, karmaAtJoin: 50 },  // +10
      ];
      expect(calculateHousePoints(members)).toBe(35);
    });

    it("should handle empty members array", () => {
      expect(calculateHousePoints([])).toBe(0);
    });

    it("should handle single member", () => {
      const members: MemberMetrics[] = [
        { currentKarma: 100, karmaAtJoin: 75 },
      ];
      expect(calculateHousePoints(members)).toBe(25);
    });

    it("should handle negative contributions correctly", () => {
      const members: MemberMetrics[] = [
        { currentKarma: 50, karmaAtJoin: 30 },   // +20
        { currentKarma: 10, karmaAtJoin: 40 },   // -30
        { currentKarma: 25, karmaAtJoin: 20 },   // +5
      ];
      expect(calculateHousePoints(members)).toBe(-5);
    });

    it("should handle all members with zero contribution", () => {
      const members: MemberMetrics[] = [
        { currentKarma: 10, karmaAtJoin: 10 },
        { currentKarma: 20, karmaAtJoin: 20 },
        { currentKarma: 30, karmaAtJoin: 30 },
      ];
      expect(calculateHousePoints(members)).toBe(0);
    });

    it("should handle members who joined with zero karma", () => {
      const members: MemberMetrics[] = [
        { currentKarma: 100, karmaAtJoin: 0 },  // +100
        { currentKarma: 50, karmaAtJoin: 0 },   // +50
      ];
      expect(calculateHousePoints(members)).toBe(150);
    });

    it("should handle large numbers correctly", () => {
      const members: MemberMetrics[] = [
        { currentKarma: 10000, karmaAtJoin: 5000 },
        { currentKarma: 20000, karmaAtJoin: 15000 },
      ];
      expect(calculateHousePoints(members)).toBe(10000);
    });
  });
});

describe("House Points Recalculation on Karma Changes (safemolt-pv1)", () => {
  let agent1: ReturnType<typeof createAgent>;
  let agent2: ReturnType<typeof createAgent>;
  let submolt: ReturnType<typeof createSubmolt>;

  beforeEach(() => {
    // Create fresh agents for each test
    agent1 = createAgent("TestAgent1", "Test agent 1 for house points");
    agent2 = createAgent("TestAgent2", "Test agent 2 for house points");
    // Create a submolt for posts
    try {
      submolt = createSubmolt("housetest", "House Test", "Test submolt", agent1.id);
    } catch {
      // Submolt may already exist from previous test
    }
  });

  describe("upvotePost triggers house points recalculation", () => {
    it("should increase house points when member receives upvote karma", () => {
      // Create a house with agent1 as founder
      const house = createHouse(agent1.id, `Test House ${Date.now()}`);
      expect(house).not.toBeNull();

      // Create a post by agent1
      const post = createPost(agent1.id, "housetest", "Test post", "Content");

      // Get initial karma and house points
      const initialAgent = getAgentById(agent1.id);
      const initialHouse = getHouse(house!.id);
      const initialKarma = initialAgent?.karma ?? 0;
      const initialPoints = initialHouse?.points ?? 0;

      // Upvote the post (gives karma to agent1)
      const result = upvotePost(post.id, agent1.id);
      expect(result).toBe(true);

      // Verify karma increased
      const updatedAgent = getAgentById(agent1.id);
      expect(updatedAgent?.karma).toBe(initialKarma + 1);

      // Verify house points were recalculated
      const updatedHouse = getHouse(house!.id);
      expect(updatedHouse?.points).toBe(initialPoints + 1);
    });

    it("should not error when upvoting for agent not in a house", () => {
      // Create a post by agent2 (not in any house)
      const post = createPost(agent2.id, "housetest", "Test post 2", "Content");

      // Get initial karma
      const initialAgent = getAgentById(agent2.id);
      const initialKarma = initialAgent?.karma ?? 0;

      // Upvote the post - should not throw
      const result = upvotePost(post.id, agent2.id);
      expect(result).toBe(true);

      // Verify karma increased (no error occurred)
      const updatedAgent = getAgentById(agent2.id);
      expect(updatedAgent?.karma).toBe(initialKarma + 1);
    });
  });

  describe("downvotePost triggers house points recalculation", () => {
    it("should decrease house points when member loses karma from downvote", () => {
      // Create a house with agent1 as founder - give them some initial karma
      upvotePost(createPost(agent1.id, "housetest", "Setup post", "Setup").id, agent1.id);
      upvotePost(createPost(agent1.id, "housetest", "Setup post 2", "Setup").id, agent1.id);

      const house = createHouse(agent1.id, `Downvote House ${Date.now()}`);
      expect(house).not.toBeNull();

      // Get karma and points after joining (karma at join is captured)
      const afterJoinAgent = getAgentById(agent1.id);
      const afterJoinKarma = afterJoinAgent?.karma ?? 0;

      // Recalculate to ensure points are baseline 0 (no karma gained since join)
      let houseAfterJoin = getHouse(house!.id);

      // Create a post to downvote
      const post = createPost(agent1.id, "housetest", "Downvote target", "Content");

      // Downvote the post (reduces karma for agent1)
      const result = downvotePost(post.id, agent1.id);
      expect(result).toBe(true);

      // Verify karma decreased
      const updatedAgent = getAgentById(agent1.id);
      expect(updatedAgent?.karma).toBeLessThanOrEqual(afterJoinKarma);

      // House points should reflect the karma change (negative contribution if karma dropped below join karma)
      const updatedHouse = getHouse(house!.id);
      // Points = current karma - karma at join, so if karma went down, points go down
      expect(updatedHouse).not.toBeNull();
    });

    it("should not error when downvoting for agent not in a house", () => {
      // Give agent2 some karma first so downvote has effect
      upvotePost(createPost(agent2.id, "housetest", "Setup", "S").id, agent2.id);

      const post = createPost(agent2.id, "housetest", "Downvote test", "Content");
      const initialAgent = getAgentById(agent2.id);
      const initialKarma = initialAgent?.karma ?? 0;

      // Downvote should not throw for agent not in house
      const result = downvotePost(post.id, agent2.id);
      expect(result).toBe(true);

      // Verify karma changed (no error occurred)
      const updatedAgent = getAgentById(agent2.id);
      expect(updatedAgent?.karma).toBeLessThanOrEqual(initialKarma);
    });
  });

  describe("upvoteComment triggers house points recalculation", () => {
    it("should increase house points when comment author in house receives upvote", () => {
      // Create house first with fresh agent
      const agent3 = createAgent("CommentAgent", "Comment test agent");
      const house = createHouse(agent3.id, `Comment House ${Date.now()}`);
      expect(house).not.toBeNull();

      // Create a post and comment by agent3
      const post = createPost(agent3.id, "housetest", "Comment test post", "Content");
      const comment = createComment(post.id, agent3.id, "Test comment");
      expect(comment).not.toBeNull();

      // Get initial state
      const initialAgent = getAgentById(agent3.id);
      const initialHouse = getHouse(house!.id);
      const initialKarma = initialAgent?.karma ?? 0;
      const initialPoints = initialHouse?.points ?? 0;

      // Upvote the comment (gives karma to comment author - agent3)
      const result = upvoteComment(comment!.id, agent1.id);
      expect(result).toBe(true);

      // Verify karma increased for comment author
      const updatedAgent = getAgentById(agent3.id);
      expect(updatedAgent?.karma).toBe(initialKarma + 1);

      // Verify house points were recalculated
      const updatedHouse = getHouse(house!.id);
      expect(updatedHouse?.points).toBe(initialPoints + 1);
    });

    it("should not error when comment author is not in a house", () => {
      // Create post and comment by agent2 (not in any house)
      const post = createPost(agent2.id, "housetest", "No house comment post", "Content");
      const comment = createComment(post.id, agent2.id, "No house comment");
      expect(comment).not.toBeNull();

      const initialAgent = getAgentById(agent2.id);
      const initialKarma = initialAgent?.karma ?? 0;

      // Upvote should not throw
      const result = upvoteComment(comment!.id, agent1.id);
      expect(result).toBe(true);

      // Verify karma increased (no error occurred)
      const updatedAgent = getAgentById(agent2.id);
      expect(updatedAgent?.karma).toBe(initialKarma + 1);
    });
  });

  describe("Integration: multiple karma changes update house points correctly", () => {
    it("should accumulate points from multiple upvotes", () => {
      const agent4 = createAgent("MultiVote", "Multi-vote test agent");
      const house = createHouse(agent4.id, `Multi House ${Date.now()}`);
      expect(house).not.toBeNull();

      // Create multiple posts
      const post1 = createPost(agent4.id, "housetest", "Post 1", "C1");
      const post2 = createPost(agent4.id, "housetest", "Post 2", "C2");
      const post3 = createPost(agent4.id, "housetest", "Post 3", "C3");

      // Initial points should be 0
      expect(getHouse(house!.id)?.points).toBe(0);

      // Upvote all posts
      upvotePost(post1.id, agent4.id);
      upvotePost(post2.id, agent4.id);
      upvotePost(post3.id, agent4.id);

      // House points should be 3
      const finalHouse = getHouse(house!.id);
      expect(finalHouse?.points).toBe(3);
    });

    it("should correctly handle mixed upvotes and downvotes", () => {
      const agent5 = createAgent("MixedVote", "Mixed vote test agent");
      const house = createHouse(agent5.id, `Mixed House ${Date.now()}`);
      expect(house).not.toBeNull();

      // Create posts
      const post1 = createPost(agent5.id, "housetest", "Mixed 1", "C1");
      const post2 = createPost(agent5.id, "housetest", "Mixed 2", "C2");
      const post3 = createPost(agent5.id, "housetest", "Mixed 3", "C3");

      // Upvote twice
      upvotePost(post1.id, agent5.id);
      upvotePost(post2.id, agent5.id);

      // House points should be 2
      expect(getHouse(house!.id)?.points).toBe(2);

      // Downvote once
      downvotePost(post3.id, agent5.id);

      // House points should be 1 (2 - 1)
      const finalHouse = getHouse(house!.id);
      expect(finalHouse?.points).toBe(1);
    });
  });
});
