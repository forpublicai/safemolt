/**
 * Unit tests for vote tracking functionality (safemolt-6qc)
 * Tests duplicate vote prevention, points attribution, and vote type storage.
 */
import {
  createAgent,
  createGroup,
  createPost,
  createComment,
  upvotePost,
  downvotePost,
  upvoteComment,
  getAgentById,
  getPostVote,
  getCommentVote,
} from "@/lib/store-memory";

describe("Vote Tracking (safemolt-6qc)", () => {
  let authorAgent: ReturnType<typeof createAgent>;
  let voterAgent: ReturnType<typeof createAgent>;

  beforeEach(() => {
    // Create fresh agents for each test
    authorAgent = createAgent(`Author_${Date.now()}`, "Post author agent");
    voterAgent = createAgent(`Voter_${Date.now()}`, "Voting agent");

    // Ensure group exists for posts
    try {
      createGroup("votetest", "Vote Test", "Test group for voting", authorAgent.id);
    } catch {
      // Group may already exist from previous test
    }
  });

  describe("Duplicate upvote returns false", () => {
    it("should return false on duplicate post upvote", () => {
      // Create a post by author
      const post = createPost(authorAgent.id, "votetest", "Test Post", "Content");

      // First upvote should succeed
      const firstResult = upvotePost(post.id, voterAgent.id);
      expect(firstResult).toBe(true);

      // Second upvote by same agent should fail
      const secondResult = upvotePost(post.id, voterAgent.id);
      expect(secondResult).toBe(false);
    });

    it("should only increment points once on duplicate upvote attempt", () => {
      const post = createPost(authorAgent.id, "votetest", "Points Test Post", "Content");

      // Get initial points
      const initialAuthor = getAgentById(authorAgent.id);
      const initialPoints = initialAuthor?.points ?? 0;

      // Upvote twice
      upvotePost(post.id, voterAgent.id);
      upvotePost(post.id, voterAgent.id);

      // Points should only have increased by 1
      const finalAuthor = getAgentById(authorAgent.id);
      expect(finalAuthor?.points).toBe(initialPoints + 1);
    });

    it("should return false on duplicate comment upvote", () => {
      // Create a post and comment
      const post = createPost(authorAgent.id, "votetest", "Comment Test Post", "Content");
      const comment = createComment(post.id, authorAgent.id, "Test comment");
      expect(comment).not.toBeNull();

      // First upvote should succeed
      const firstResult = upvoteComment(comment!.id, voterAgent.id);
      expect(firstResult).toBe(true);

      // Second upvote by same agent should fail
      const secondResult = upvoteComment(comment!.id, voterAgent.id);
      expect(secondResult).toBe(false);
    });
  });

  describe("Duplicate downvote returns false", () => {
    it("should return false on duplicate post downvote", () => {
      // Create a post by author
      const post = createPost(authorAgent.id, "votetest", "Downvote Test Post", "Content");

      // First downvote should succeed
      const firstResult = downvotePost(post.id, voterAgent.id);
      expect(firstResult).toBe(true);

      // Second downvote by same agent should fail
      const secondResult = downvotePost(post.id, voterAgent.id);
      expect(secondResult).toBe(false);
    });

    it("should only decrement points once on duplicate downvote attempt", () => {
      // Give author some initial points to test decrement
      const setupPost = createPost(authorAgent.id, "votetest", "Setup Post", "Setup");
      upvotePost(setupPost.id, voterAgent.id);

      const post = createPost(authorAgent.id, "votetest", "Downvote Points Test", "Content");

      // Get points after initial setup
      const initialAuthor = getAgentById(authorAgent.id);
      const initialPoints = initialAuthor?.points ?? 0;

      // Use a different voter for downvote test
      const downvoter = createAgent(`Downvoter_${Date.now()}`, "Downvoting agent");

      // Downvote twice
      downvotePost(post.id, downvoter.id);
      downvotePost(post.id, downvoter.id);

      // Points should only have decreased by 1
      const finalAuthor = getAgentById(authorAgent.id);
      expect(finalAuthor?.points).toBe(Math.max(0, initialPoints - 1));
    });
  });

  describe("Points go to author not voter", () => {
    it("should give points to post author, not the voter", () => {
      const post = createPost(authorAgent.id, "votetest", "Author Points Test", "Content");

      // Get initial points for both agents
      const initialAuthor = getAgentById(authorAgent.id);
      const initialVoter = getAgentById(voterAgent.id);
      const authorPointsBefore = initialAuthor?.points ?? 0;
      const voterPointsBefore = initialVoter?.points ?? 0;

      // Voter upvotes author's post
      upvotePost(post.id, voterAgent.id);

      // Check points after vote
      const finalAuthor = getAgentById(authorAgent.id);
      const finalVoter = getAgentById(voterAgent.id);

      // Author's points should increase
      expect(finalAuthor?.points).toBe(authorPointsBefore + 1);

      // Voter's points should be unchanged
      expect(finalVoter?.points).toBe(voterPointsBefore);
    });

    it("should take points from post author, not the voter, on downvote", () => {
      // Give author some points first
      const setupPost = createPost(authorAgent.id, "votetest", "Setup", "S");
      upvotePost(setupPost.id, voterAgent.id);

      const post = createPost(authorAgent.id, "votetest", "Downvote Author Test", "Content");

      // Get points before downvote
      const authorBefore = getAgentById(authorAgent.id);
      const voterBefore = getAgentById(voterAgent.id);
      const authorPointsBefore = authorBefore?.points ?? 0;
      const voterPointsBefore = voterBefore?.points ?? 0;

      // Use a new voter for downvote
      const downvoter = createAgent(`Downvoter2_${Date.now()}`, "Downvoting agent");
      const downvoterBefore = getAgentById(downvoter.id);
      const downvoterPointsBefore = downvoterBefore?.points ?? 0;

      // Downvoter downvotes author's post
      downvotePost(post.id, downvoter.id);

      // Check points after vote
      const finalAuthor = getAgentById(authorAgent.id);
      const finalDownvoter = getAgentById(downvoter.id);

      // Author's points should decrease
      expect(finalAuthor?.points).toBe(Math.max(0, authorPointsBefore - 1));

      // Downvoter's points should be unchanged
      expect(finalDownvoter?.points).toBe(downvoterPointsBefore);
    });

    it("should give points to comment author, not the voter", () => {
      const post = createPost(authorAgent.id, "votetest", "Comment Points Test", "Content");
      const comment = createComment(post.id, authorAgent.id, "Test comment for points");
      expect(comment).not.toBeNull();

      // Get initial points for both
      const authorBefore = getAgentById(authorAgent.id);
      const voterBefore = getAgentById(voterAgent.id);
      const authorPointsBefore = authorBefore?.points ?? 0;
      const voterPointsBefore = voterBefore?.points ?? 0;

      // Voter upvotes author's comment
      upvoteComment(comment!.id, voterAgent.id);

      // Check points after vote
      const authorAfter = getAgentById(authorAgent.id);
      const voterAfter = getAgentById(voterAgent.id);

      // Author's points should increase
      expect(authorAfter?.points).toBe(authorPointsBefore + 1);

      // Voter's points should be unchanged
      expect(voterAfter?.points).toBe(voterPointsBefore);
    });
  });

  describe("Vote type stored correctly", () => {
    it("should store voteType as 1 for upvote", () => {
      const post = createPost(authorAgent.id, "votetest", "Upvote Type Test", "Content");

      // Upvote the post
      upvotePost(post.id, voterAgent.id);

      // Retrieve the vote record
      const vote = getPostVote(voterAgent.id, post.id);

      expect(vote).not.toBeNull();
      expect(vote?.voteType).toBe(1);
      expect(vote?.agentId).toBe(voterAgent.id);
      expect(vote?.postId).toBe(post.id);
    });

    it("should store voteType as -1 for downvote", () => {
      const post = createPost(authorAgent.id, "votetest", "Downvote Type Test", "Content");

      // Downvote the post
      downvotePost(post.id, voterAgent.id);

      // Retrieve the vote record
      const vote = getPostVote(voterAgent.id, post.id);

      expect(vote).not.toBeNull();
      expect(vote?.voteType).toBe(-1);
      expect(vote?.agentId).toBe(voterAgent.id);
      expect(vote?.postId).toBe(post.id);
    });

    it("should store voteType as 1 for comment upvote", () => {
      const post = createPost(authorAgent.id, "votetest", "Comment Vote Type Test", "Content");
      const comment = createComment(post.id, authorAgent.id, "Test comment");
      expect(comment).not.toBeNull();

      // Upvote the comment
      upvoteComment(comment!.id, voterAgent.id);

      // Retrieve the vote record
      const vote = getCommentVote(voterAgent.id, comment!.id);

      expect(vote).not.toBeNull();
      expect(vote?.voteType).toBe(1);
      expect(vote?.agentId).toBe(voterAgent.id);
      expect(vote?.commentId).toBe(comment!.id);
    });

    it("should include votedAt timestamp in vote record", () => {
      const post = createPost(authorAgent.id, "votetest", "Timestamp Test", "Content");
      const beforeVote = new Date().toISOString();

      upvotePost(post.id, voterAgent.id);

      const vote = getPostVote(voterAgent.id, post.id);
      const afterVote = new Date().toISOString();

      expect(vote).not.toBeNull();
      expect(vote?.votedAt).toBeDefined();
      // votedAt should be between beforeVote and afterVote
      expect(vote!.votedAt >= beforeVote).toBe(true);
      expect(vote!.votedAt <= afterVote).toBe(true);
    });
  });
});
