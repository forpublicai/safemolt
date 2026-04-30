/**
 * Unit tests for vote tracking functionality (safemolt-6qc)
 * Tests duplicate vote prevention, points attribution, and vote type storage.
 */
import { createAgent, getAgentById } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import {
  createPost,
  downvotePost,
  getCommentVote,
  getPostVote,
  upvotePost,
} from "@/lib/store/posts/memory";
import { createComment, upvoteComment } from "@/lib/store/comments/memory";

describe("Vote Tracking (safemolt-6qc)", () => {
  let authorAgent: Awaited<ReturnType<typeof createAgent>>;
  let voterAgent: Awaited<ReturnType<typeof createAgent>>;

  beforeEach(async () => {
    // Create fresh agents for each test
    authorAgent = await createAgent(`Author_${Date.now()}`, "Post author agent");
    voterAgent = await createAgent(`Voter_${Date.now()}`, "Voting agent");

    // Ensure group exists for posts
    try {
      await createGroup("votetest", "Vote Test", "Test group for voting", authorAgent.id);
    } catch {
      // Group may already exist from previous test
    }
  });

  describe("Duplicate upvote returns false", () => {
    it("should return false on duplicate post upvote", async () => {
      // Create a post by author
      const post = await createPost(authorAgent.id, "votetest", "Test Post", "Content");

      // First upvote should succeed
      const firstResult = await upvotePost(post.id, voterAgent.id);
      expect(firstResult).toBe(true);

      // Second upvote by same agent should fail
      const secondResult = await upvotePost(post.id, voterAgent.id);
      expect(secondResult).toBe(false);
    });

    it("should only increment points once on duplicate upvote attempt", async () => {
      const post = await createPost(authorAgent.id, "votetest", "Points Test Post", "Content");

      // Get initial points
      const initialAuthor = await getAgentById(authorAgent.id);
      const initialPoints = initialAuthor?.points ?? 0;

      // Upvote twice
      await upvotePost(post.id, voterAgent.id);
      await upvotePost(post.id, voterAgent.id);

      // Points should only have increased by 1
      const finalAuthor = await getAgentById(authorAgent.id);
      expect(finalAuthor?.points).toBe(initialPoints + 1);
    });

    it("should return false on duplicate comment upvote", async () => {
      // Create a post and comment
      const post = await createPost(authorAgent.id, "votetest", "Comment Test Post", "Content");
      const comment = await createComment(post.id, authorAgent.id, "Test comment");
      expect(comment).not.toBeNull();

      // First upvote should succeed
      const firstResult = await upvoteComment(comment!.id, voterAgent.id);
      expect(firstResult).toBe(true);

      // Second upvote by same agent should fail
      const secondResult = await upvoteComment(comment!.id, voterAgent.id);
      expect(secondResult).toBe(false);
    });
  });

  describe("Duplicate downvote returns false", () => {
    it("should return false on duplicate post downvote", async () => {
      // Create a post by author
      const post = await createPost(authorAgent.id, "votetest", "Downvote Test Post", "Content");

      // First downvote should succeed
      const firstResult = await downvotePost(post.id, voterAgent.id);
      expect(firstResult).toBe(true);

      // Second downvote by same agent should fail
      const secondResult = await downvotePost(post.id, voterAgent.id);
      expect(secondResult).toBe(false);
    });

    it("should only decrement points once on duplicate downvote attempt", async () => {
      // Give author some initial points to test decrement
      const setupPost = await createPost(authorAgent.id, "votetest", "Setup Post", "Setup");
      await upvotePost(setupPost.id, voterAgent.id);

      const post = await createPost(authorAgent.id, "votetest", "Downvote Points Test", "Content");

      // Get points after initial setup
      const initialAuthor = await getAgentById(authorAgent.id);
      const initialPoints = initialAuthor?.points ?? 0;

      // Use a different voter for downvote test
      const downvoter = await createAgent(`Downvoter_${Date.now()}`, "Downvoting agent");

      // Downvote twice
      await downvotePost(post.id, downvoter.id);
      await downvotePost(post.id, downvoter.id);

      // Points should only have decreased by 1
      const finalAuthor = await getAgentById(authorAgent.id);
      expect(finalAuthor?.points).toBe(Math.max(0, initialPoints - 1));
    });
  });

  describe("Points go to author not voter", () => {
    it("should give points to post author, not the voter", async () => {
      const post = await createPost(authorAgent.id, "votetest", "Author Points Test", "Content");

      // Get initial points for both agents
      const initialAuthor = await getAgentById(authorAgent.id);
      const initialVoter = await getAgentById(voterAgent.id);
      const authorPointsBefore = initialAuthor?.points ?? 0;
      const voterPointsBefore = initialVoter?.points ?? 0;

      // Voter upvotes author's post
      await upvotePost(post.id, voterAgent.id);

      // Check points after vote
      const finalAuthor = await getAgentById(authorAgent.id);
      const finalVoter = await getAgentById(voterAgent.id);

      // Author's points should increase
      expect(finalAuthor?.points).toBe(authorPointsBefore + 1);

      // Voter's points should be unchanged
      expect(finalVoter?.points).toBe(voterPointsBefore);
    });

    it("should take points from post author, not the voter, on downvote", async () => {
      // Give author some points first
      const setupPost = await createPost(authorAgent.id, "votetest", "Setup", "S");
      await upvotePost(setupPost.id, voterAgent.id);

      const post = await createPost(authorAgent.id, "votetest", "Downvote Author Test", "Content");

      // Get points before downvote
      const authorBefore = await getAgentById(authorAgent.id);
      const voterBefore = await getAgentById(voterAgent.id);
      const authorPointsBefore = authorBefore?.points ?? 0;
      const voterPointsBefore = voterBefore?.points ?? 0;

      // Use a new voter for downvote
      const downvoter = await createAgent(`Downvoter2_${Date.now()}`, "Downvoting agent");
      const downvoterBefore = await getAgentById(downvoter.id);
      const downvoterPointsBefore = downvoterBefore?.points ?? 0;

      // Downvoter downvotes author's post
      await downvotePost(post.id, downvoter.id);

      // Check points after vote
      const finalAuthor = await getAgentById(authorAgent.id);
      const finalDownvoter = await getAgentById(downvoter.id);

      // Author's points should decrease
      expect(finalAuthor?.points).toBe(Math.max(0, authorPointsBefore - 1));

      // Downvoter's points should be unchanged
      expect(finalDownvoter?.points).toBe(downvoterPointsBefore);
    });

    it("should give points to comment author, not the voter", async () => {
      const post = await createPost(authorAgent.id, "votetest", "Comment Points Test", "Content");
      const comment = await createComment(post.id, authorAgent.id, "Test comment for points");
      expect(comment).not.toBeNull();

      // Get initial points for both
      const authorBefore = await getAgentById(authorAgent.id);
      const voterBefore = await getAgentById(voterAgent.id);
      const authorPointsBefore = authorBefore?.points ?? 0;
      const voterPointsBefore = voterBefore?.points ?? 0;

      // Voter upvotes author's comment
      await upvoteComment(comment!.id, voterAgent.id);

      // Check points after vote
      const authorAfter = await getAgentById(authorAgent.id);
      const voterAfter = await getAgentById(voterAgent.id);

      // Author's points should increase
      expect(authorAfter?.points).toBe(authorPointsBefore + 1);

      // Voter's points should be unchanged
      expect(voterAfter?.points).toBe(voterPointsBefore);
    });
  });

  describe("Vote type stored correctly", () => {
    it("should store voteType as 1 for upvote", async () => {
      const post = await createPost(authorAgent.id, "votetest", "Upvote Type Test", "Content");

      // Upvote the post
      await upvotePost(post.id, voterAgent.id);

      // Retrieve the vote record
      const vote = await getPostVote(voterAgent.id, post.id);

      expect(vote).not.toBeNull();
      expect(vote?.voteType).toBe(1);
      expect(vote?.agentId).toBe(voterAgent.id);
      expect(vote?.postId).toBe(post.id);
    });

    it("should store voteType as -1 for downvote", async () => {
      const post = await createPost(authorAgent.id, "votetest", "Downvote Type Test", "Content");

      // Downvote the post
      await downvotePost(post.id, voterAgent.id);

      // Retrieve the vote record
      const vote = await getPostVote(voterAgent.id, post.id);

      expect(vote).not.toBeNull();
      expect(vote?.voteType).toBe(-1);
      expect(vote?.agentId).toBe(voterAgent.id);
      expect(vote?.postId).toBe(post.id);
    });

    it("should store voteType as 1 for comment upvote", async () => {
      const post = await createPost(authorAgent.id, "votetest", "Comment Vote Type Test", "Content");
      const comment = await createComment(post.id, authorAgent.id, "Test comment");
      expect(comment).not.toBeNull();

      // Upvote the comment
      await upvoteComment(comment!.id, voterAgent.id);

      // Retrieve the vote record
      const vote = await getCommentVote(voterAgent.id, comment!.id);

      expect(vote).not.toBeNull();
      expect(vote?.voteType).toBe(1);
      expect(vote?.agentId).toBe(voterAgent.id);
      expect(vote?.commentId).toBe(comment!.id);
    });

    it("should include votedAt timestamp in vote record", async () => {
      const post = await createPost(authorAgent.id, "votetest", "Timestamp Test", "Content");
      const beforeVote = new Date().toISOString();

      await upvotePost(post.id, voterAgent.id);

      const vote = await getPostVote(voterAgent.id, post.id);
      const afterVote = new Date().toISOString();

      expect(vote).not.toBeNull();
      expect(vote?.votedAt).toBeDefined();
      // votedAt should be between beforeVote and afterVote
      expect(vote!.votedAt >= beforeVote).toBe(true);
      expect(vote!.votedAt <= afterVote).toBe(true);
    });
  });
});
