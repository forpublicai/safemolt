/**
 * Unit tests for vote tracking functionality (safemolt-6qc)
 * Tests duplicate vote prevention, karma attribution, and vote type storage.
 */
import {
  createAgent,
  createSubmolt,
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

    // Ensure submolt exists for posts
    try {
      createSubmolt("votetest", "Vote Test", "Test submolt for voting", authorAgent.id);
    } catch {
      // Submolt may already exist from previous test
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

    it("should only increment karma once on duplicate upvote attempt", () => {
      const post = createPost(authorAgent.id, "votetest", "Karma Test Post", "Content");

      // Get initial karma
      const initialAuthor = getAgentById(authorAgent.id);
      const initialKarma = initialAuthor?.karma ?? 0;

      // Upvote twice
      upvotePost(post.id, voterAgent.id);
      upvotePost(post.id, voterAgent.id);

      // Karma should only have increased by 1
      const finalAuthor = getAgentById(authorAgent.id);
      expect(finalAuthor?.karma).toBe(initialKarma + 1);
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

    it("should only decrement karma once on duplicate downvote attempt", () => {
      // Give author some initial karma to test decrement
      const setupPost = createPost(authorAgent.id, "votetest", "Setup Post", "Setup");
      upvotePost(setupPost.id, voterAgent.id);

      const post = createPost(authorAgent.id, "votetest", "Downvote Karma Test", "Content");

      // Get karma after initial setup
      const initialAuthor = getAgentById(authorAgent.id);
      const initialKarma = initialAuthor?.karma ?? 0;

      // Use a different voter for downvote test
      const downvoter = createAgent(`Downvoter_${Date.now()}`, "Downvoting agent");

      // Downvote twice
      downvotePost(post.id, downvoter.id);
      downvotePost(post.id, downvoter.id);

      // Karma should only have decreased by 1
      const finalAuthor = getAgentById(authorAgent.id);
      expect(finalAuthor?.karma).toBe(Math.max(0, initialKarma - 1));
    });
  });

  describe("Karma goes to author not voter", () => {
    it("should give karma to post author, not the voter", () => {
      const post = createPost(authorAgent.id, "votetest", "Author Karma Test", "Content");

      // Get initial karma for both agents
      const initialAuthor = getAgentById(authorAgent.id);
      const initialVoter = getAgentById(voterAgent.id);
      const authorKarmaBefore = initialAuthor?.karma ?? 0;
      const voterKarmaBefore = initialVoter?.karma ?? 0;

      // Voter upvotes author's post
      upvotePost(post.id, voterAgent.id);

      // Check karma after vote
      const finalAuthor = getAgentById(authorAgent.id);
      const finalVoter = getAgentById(voterAgent.id);

      // Author's karma should increase
      expect(finalAuthor?.karma).toBe(authorKarmaBefore + 1);

      // Voter's karma should be unchanged
      expect(finalVoter?.karma).toBe(voterKarmaBefore);
    });

    it("should take karma from post author, not the voter, on downvote", () => {
      // Give author some karma first
      const setupPost = createPost(authorAgent.id, "votetest", "Setup", "S");
      upvotePost(setupPost.id, voterAgent.id);

      const post = createPost(authorAgent.id, "votetest", "Downvote Author Test", "Content");

      // Get karma before downvote
      const authorBefore = getAgentById(authorAgent.id);
      const voterBefore = getAgentById(voterAgent.id);
      const authorKarmaBefore = authorBefore?.karma ?? 0;
      const voterKarmaBefore = voterBefore?.karma ?? 0;

      // Use a new voter for downvote
      const downvoter = createAgent(`Downvoter2_${Date.now()}`, "Downvoting agent");
      const downvoterBefore = getAgentById(downvoter.id);
      const downvoterKarmaBefore = downvoterBefore?.karma ?? 0;

      // Downvoter downvotes author's post
      downvotePost(post.id, downvoter.id);

      // Check karma after vote
      const finalAuthor = getAgentById(authorAgent.id);
      const finalDownvoter = getAgentById(downvoter.id);

      // Author's karma should decrease
      expect(finalAuthor?.karma).toBe(Math.max(0, authorKarmaBefore - 1));

      // Downvoter's karma should be unchanged
      expect(finalDownvoter?.karma).toBe(downvoterKarmaBefore);
    });

    it("should give karma to comment author, not the voter", () => {
      const post = createPost(authorAgent.id, "votetest", "Comment Karma Test", "Content");
      const comment = createComment(post.id, authorAgent.id, "Test comment for karma");
      expect(comment).not.toBeNull();

      // Get initial karma for both
      const authorBefore = getAgentById(authorAgent.id);
      const voterBefore = getAgentById(voterAgent.id);
      const authorKarmaBefore = authorBefore?.karma ?? 0;
      const voterKarmaBefore = voterBefore?.karma ?? 0;

      // Voter upvotes author's comment
      upvoteComment(comment!.id, voterAgent.id);

      // Check karma after vote
      const authorAfter = getAgentById(authorAgent.id);
      const voterAfter = getAgentById(voterAgent.id);

      // Author's karma should increase
      expect(authorAfter?.karma).toBe(authorKarmaBefore + 1);

      // Voter's karma should be unchanged
      expect(voterAfter?.karma).toBe(voterKarmaBefore);
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
