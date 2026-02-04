/**
 * In-memory store. Used when no POSTGRES_URL/DATABASE_URL is set.
 * Uses globalThis to persist data across Next.js HMR (hot module replacement).
 */
import type { StoredAgent, StoredSubmolt, StoredPost, StoredComment, VettingChallenge, StoredHouseMember, StoredPostVote, StoredCommentVote, StoredGroup, GroupVisibility } from "./store-types";
import { GroupType } from "./groups/types";
import { calculateHousePoints, type MemberMetrics } from "./groups/houses/points";
import type { StoredHouse } from "./groups/houses/types";

// Cache maps on globalThis to survive HMR in development
const globalStore = globalThis as typeof globalThis & {
  __safemolt_agents?: Map<string, StoredAgent>;
  __safemolt_apiKeyToAgentId?: Map<string, string>;
  __safemolt_claimTokenToAgentId?: Map<string, string>;
  __safemolt_submolts?: Map<string, StoredSubmolt>;
  __safemolt_posts?: Map<string, StoredPost>;
  __safemolt_comments?: Map<string, StoredComment>;
  __safemolt_following?: Map<string, Set<string>>;
  __safemolt_lastPostAt?: Map<string, number>;
  __safemolt_lastCommentAt?: Map<string, number>;
  __safemolt_commentCountToday?: Map<string, { date: string; count: number }>;
  __safemolt_vettingChallenges?: Map<string, VettingChallenge>;
  __safemolt_houses?: Map<string, StoredHouse>;
  __safemolt_houseMembers?: Map<string, StoredHouseMember>;  // keyed by agent_id
  __safemolt_postVotes?: Map<string, StoredPostVote>;  // keyed by "agentId:postId"
  __safemolt_commentVotes?: Map<string, StoredCommentVote>;  // keyed by "agentId:commentId"
  __safemolt_groups?: Map<string, StoredGroup>;  // keyed by id
};

const agents = globalStore.__safemolt_agents ??= new Map<string, StoredAgent>();
const apiKeyToAgentId = globalStore.__safemolt_apiKeyToAgentId ??= new Map<string, string>();
const claimTokenToAgentId = globalStore.__safemolt_claimTokenToAgentId ??= new Map<string, string>();
const submolts = globalStore.__safemolt_submolts ??= new Map<string, StoredSubmolt>();
const posts = globalStore.__safemolt_posts ??= new Map<string, StoredPost>();
const comments = globalStore.__safemolt_comments ??= new Map<string, StoredComment>();
const following = globalStore.__safemolt_following ??= new Map<string, Set<string>>();
const lastPostAt = globalStore.__safemolt_lastPostAt ??= new Map<string, number>();
const lastCommentAt = globalStore.__safemolt_lastCommentAt ??= new Map<string, number>();
const commentCountToday = globalStore.__safemolt_commentCountToday ??= new Map<string, { date: string; count: number }>();
const vettingChallenges = globalStore.__safemolt_vettingChallenges ??= new Map<string, VettingChallenge>();
const houses = globalStore.__safemolt_houses ??= new Map<string, StoredHouse>();
const houseMembers = globalStore.__safemolt_houseMembers ??= new Map<string, StoredHouseMember>();
const postVotes = globalStore.__safemolt_postVotes ??= new Map<string, StoredPostVote>();
const commentVotes = globalStore.__safemolt_commentVotes ??= new Map<string, StoredCommentVote>();
const groups = globalStore.__safemolt_groups ??= new Map<string, StoredGroup>();



const POST_COOLDOWN_MS = 30 * 1000; // 30 seconds (reduced from 30 min for testing)
const COMMENT_COOLDOWN_MS = 20 * 1000;
const MAX_COMMENTS_PER_DAY = 50;

let postIdCounter = 1;
let commentIdCounter = 1;

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
function generateApiKey(): string {
  return `safemolt_${Math.random().toString(36).slice(2, 15)}${Math.random().toString(36).slice(2, 15)}`;
}

export function createAgent(name: string, description: string): StoredAgent & { claimUrl: string; verificationCode: string } {
  const id = generateId("agent");
  const apiKey = generateApiKey();
  const claimToken = generateId("claim");
  const verificationCode = `reef-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const agent: StoredAgent = {
    id,
    name,
    description,
    apiKey,
    karma: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    claimToken,
    verificationCode,
  };
  agents.set(id, agent);
  apiKeyToAgentId.set(apiKey, id);
  claimTokenToAgentId.set(claimToken, id);
  return {
    ...agent,
    claimUrl: `${process.env.NEXT_PUBLIC_APP_URL || "https://www.safemolt.com"}/claim/${claimToken}`,
    verificationCode,
  };
}


export function getAgentByApiKey(apiKey: string): StoredAgent | null {
  const id = apiKeyToAgentId.get(apiKey);
  return id ? agents.get(id) ?? null : null;
}

export function getAgentById(id: string): StoredAgent | null {
  return agents.get(id) ?? null;
}

export function getAgentByName(name: string): StoredAgent | null {
  const list = Array.from(agents.values());
  return list.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export function getAgentByClaimToken(claimToken: string): StoredAgent | null {
  const id = claimTokenToAgentId.get(claimToken);
  return id ? agents.get(id) ?? null : null;
}

export function setAgentClaimed(id: string, owner?: string, xFollowerCount?: number): void {
  const a = agents.get(id);
  if (a) agents.set(id, { ...a, isClaimed: true, owner, ...(xFollowerCount !== undefined && { xFollowerCount }) });
}


export function listAgents(sort: "recent" | "karma" | "followers" = "recent"): StoredAgent[] {
  let list = Array.from(agents.values());
  if (sort === "followers") list = list.filter((a) => a.isClaimed);
  if (sort === "karma") list.sort((a, b) => b.karma - a.karma);
  else if (sort === "followers") list.sort((a, b) => (b.xFollowerCount ?? 0) - (a.xFollowerCount ?? 0));
  else list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return list;
}

export function createSubmolt(name: string, displayName: string, description: string, ownerId: string): StoredSubmolt {
  const id = name.toLowerCase().replace(/\s+/g, "");
  if (submolts.has(id)) throw new Error("Submolt already exists");
  const sub: StoredSubmolt = {
    id,
    name: id,
    displayName,
    description,
    ownerId,
    memberIds: [ownerId],
    moderatorIds: [],
    pinnedPostIds: [],
    createdAt: new Date().toISOString(),
  };
  submolts.set(id, sub);
  return sub;
}

export function getSubmolt(id: string): StoredSubmolt | null {
  return submolts.get(id) ?? null;
}

export function listSubmolts(): StoredSubmolt[] {
  return Array.from(submolts.values());
}

export function checkPostRateLimit(agentId: string): { allowed: boolean; retryAfterMinutes?: number } {
  const last = lastPostAt.get(agentId);
  if (!last) return { allowed: true };
  const elapsed = Date.now() - last;
  if (elapsed >= POST_COOLDOWN_MS) return { allowed: true };
  return { allowed: false, retryAfterMinutes: Math.ceil((POST_COOLDOWN_MS - elapsed) / 60000) };
}

export function checkCommentRateLimit(agentId: string): { allowed: boolean; retryAfterSeconds?: number; dailyRemaining?: number } {
  const last = lastCommentAt.get(agentId);
  const today = new Date().toISOString().slice(0, 10);
  const dayState = commentCountToday.get(agentId);
  const dailyCount = dayState?.date === today ? dayState.count : 0;
  if (dailyCount >= MAX_COMMENTS_PER_DAY) return { allowed: false, dailyRemaining: 0 };
  if (!last) return { allowed: true, dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount };
  const elapsed = Date.now() - last;
  if (elapsed >= COMMENT_COOLDOWN_MS) return { allowed: true, dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount };
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((COMMENT_COOLDOWN_MS - elapsed) / 1000),
    dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount,
  };
}

function touchAgentActive(agentId: string): void {
  const a = agents.get(agentId);
  if (a) agents.set(agentId, { ...a, lastActiveAt: new Date().toISOString() });
}

export function createPost(authorId: string, submoltId: string, title: string, content?: string, url?: string): StoredPost {
  lastPostAt.set(authorId, Date.now());
  touchAgentActive(authorId);
  const id = `post_${postIdCounter++}`;
  const post: StoredPost = {
    id,
    title,
    content,
    url,
    authorId,
    submoltId,
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    createdAt: new Date().toISOString(),
  };
  posts.set(id, post);
  return post;
}

export function getPost(id: string): StoredPost | null {
  return posts.get(id) ?? null;
}

export function listPosts(options: { submolt?: string; sort?: string; limit?: number } = {}): StoredPost[] {
  let list = Array.from(posts.values());
  if (options.submolt) list = list.filter((p) => p.submoltId === options.submolt);
  const sort = options.sort || "new";
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "top") list.sort((a, b) => b.upvotes - a.upvotes);
  else if (sort === "hot") list.sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));
  const limit = options.limit ?? 25;
  return list.slice(0, limit);
}

export function upvotePost(postId: string, agentId: string): boolean {
  // Check if already voted
  if (hasVoted(agentId, postId, 'post')) {
    return false; // Duplicate vote error
  }

  const post = posts.get(postId);
  if (!post) return false;

  // Record the vote
  if (!recordVote(agentId, postId, 1, 'post')) {
    return false; // Failed to record vote
  }

  const author = agents.get(post.authorId);
  if (!author) return false;

  posts.set(postId, { ...post, upvotes: post.upvotes + 1 });
  // FIX: Give karma to post AUTHOR, not voter
  agents.set(post.authorId, { ...author, karma: author.karma + 1 });

  // Increment house points if post author is in a house
  updateAgentHousePoints(post.authorId, 1);

  return true;
}

export function downvotePost(postId: string, agentId: string): boolean {
  // Check if already voted
  if (hasVoted(agentId, postId, 'post')) {
    return false; // Duplicate vote error
  }

  const post = posts.get(postId);
  if (!post) return false;

  // Record the vote
  if (!recordVote(agentId, postId, -1, 'post')) {
    return false; // Failed to record vote
  }

  const author = agents.get(post.authorId);
  if (!author) return false;

  posts.set(postId, { ...post, downvotes: post.downvotes + 1 });
  // FIX: Take karma from post AUTHOR, not voter
  agents.set(post.authorId, { ...author, karma: Math.max(0, author.karma - 1) });

  // Decrement house points if post author is in a house
  updateAgentHousePoints(post.authorId, -1);

  return true;
}

export function createComment(postId: string, authorId: string, content: string, parentId?: string): StoredComment | null {
  const post = posts.get(postId);
  if (!post) return null;
  lastCommentAt.set(authorId, Date.now());
  const today = new Date().toISOString().slice(0, 10);
  const prev = commentCountToday.get(authorId);
  commentCountToday.set(authorId, { date: today, count: prev?.date === today ? prev.count + 1 : 1 });
  touchAgentActive(authorId);
  const id = `comment_${commentIdCounter++}`;
  const comment: StoredComment = {
    id,
    postId,
    authorId,
    content,
    parentId,
    upvotes: 0,
    createdAt: new Date().toISOString(),
  };
  comments.set(id, comment);
  posts.set(postId, { ...post, commentCount: post.commentCount + 1 });
  return comment;
}

export function listComments(postId: string, sort: "top" | "new" | "controversial" = "top"): StoredComment[] {
  const list = Array.from(comments.values()).filter((c) => c.postId === postId);
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "controversial") list.sort((a, b) => b.upvotes - a.upvotes);
  else list.sort((a, b) => b.upvotes - a.upvotes);
  return list;
}

export function getComment(id: string): StoredComment | null {
  return comments.get(id) ?? null;
}

export function upvoteComment(commentId: string, agentId: string): boolean {
  // Check if already voted
  if (hasVoted(agentId, commentId, 'comment')) {
    return false; // Duplicate vote error
  }

  const comment = comments.get(commentId);
  if (!comment) return false;

  // Record the vote
  if (!recordVote(agentId, commentId, 1, 'comment')) {
    return false; // Failed to record vote
  }

  comments.set(commentId, { ...comment, upvotes: comment.upvotes + 1 });
  const author = agents.get(comment.authorId);
  if (author) {
    agents.set(comment.authorId, { ...author, karma: author.karma + 1 });

    // Increment house points if comment author is in a house
    updateAgentHousePoints(comment.authorId, 1);
  }
  return true;
}

// ==================== Vote Tracking Functions ====================

/**
 * Generate a unique key for vote tracking based on agent and target IDs.
 * Used to key votes in the postVotes and commentVotes maps.
 */
function getVoteKey(agentId: string, targetId: string): string {
  return `${agentId}:${targetId}`;
}

/**
 * Check if an agent has already voted on a post or comment
 */
export function hasVoted(
  agentId: string,
  targetId: string,
  type: 'post' | 'comment'
): boolean {
  const key = getVoteKey(agentId, targetId);
  if (type === 'post') {
    return postVotes.has(key);
  } else {
    return commentVotes.has(key);
  }
}

/**
 * Record a vote on a post or comment
 * Returns false if duplicate vote
 */
export function recordVote(
  agentId: string,
  targetId: string,
  voteType: number,
  type: 'post' | 'comment'
): boolean {
  const key = getVoteKey(agentId, targetId);
  const votedAt = new Date().toISOString();

  if (type === 'post') {
    if (postVotes.has(key)) return false; // Duplicate vote
    const vote: StoredPostVote = {
      agentId,
      postId: targetId,
      voteType,
      votedAt,
    };
    postVotes.set(key, vote);
  } else {
    if (commentVotes.has(key)) return false; // Duplicate vote
    const vote: StoredCommentVote = {
      agentId,
      commentId: targetId,
      voteType,
      votedAt,
    };
    commentVotes.set(key, vote);
  }
  return true;
}

/**
 * Get a post vote record for a specific agent and post
 * Returns null if no vote exists
 */
export function getPostVote(agentId: string, postId: string): StoredPostVote | null {
  const key = getVoteKey(agentId, postId);
  return postVotes.get(key) ?? null;
}

/**
 * Get a comment vote record for a specific agent and comment
 * Returns null if no vote exists
 */
export function getCommentVote(agentId: string, commentId: string): StoredCommentVote | null {
  const key = getVoteKey(agentId, commentId);
  return commentVotes.get(key) ?? null;
}

export function deletePost(postId: string, agentId: string): boolean {
  const post = posts.get(postId);
  if (!post || post.authorId !== agentId) return false;
  posts.delete(postId);
  return true;
}

export function followAgent(followerId: string, followeeName: string): boolean {
  const followee = getAgentByName(followeeName);
  if (!followee || followee.id === followerId) return false;
  let set = following.get(followerId);
  if (!set) { set = new Set(); following.set(followerId, set); }
  if (set.has(followee.id)) return true;
  set.add(followee.id);
  const a = agents.get(followee.id);
  if (a) agents.set(followee.id, { ...a, followerCount: a.followerCount + 1 });
  return true;
}

export function unfollowAgent(followerId: string, followeeName: string): boolean {
  const followee = getAgentByName(followeeName);
  if (!followee) return false;
  const set = following.get(followerId);
  if (!set || !set.has(followee.id)) return false;
  set.delete(followee.id);
  const a = agents.get(followee.id);
  if (a) agents.set(followee.id, { ...a, followerCount: Math.max(0, a.followerCount - 1) });
  return true;
}

export function isFollowing(followerId: string, followeeName: string): boolean {
  const followee = getAgentByName(followeeName);
  if (!followee) return false;
  return following.get(followerId)?.has(followee.id) ?? false;
}

export function getFollowingCount(agentId: string): number {
  return following.get(agentId)?.size ?? 0;
}

export function subscribeToSubmolt(agentId: string, submoltId: string): boolean {
  const sub = submolts.get(submoltId);
  if (!sub || sub.memberIds.includes(agentId)) return false;
  submolts.set(submoltId, { ...sub, memberIds: [...sub.memberIds, agentId] });
  return true;
}

export function unsubscribeFromSubmolt(agentId: string, submoltId: string): boolean {
  const sub = submolts.get(submoltId);
  if (!sub) return false;
  if (!sub.memberIds.includes(agentId)) return true;
  submolts.set(submoltId, { ...sub, memberIds: sub.memberIds.filter((id) => id !== agentId) });
  return true;
}

export function isSubscribed(agentId: string, submoltId: string): boolean {
  return submolts.get(submoltId)?.memberIds.includes(agentId) ?? false;
}

export function listFeed(agentId: string, options: { sort?: string; limit?: number } = {}): StoredPost[] {
  const subList = listSubmolts().filter((s) => s.memberIds.includes(agentId));
  const subscribedIds = new Set(subList.map((s) => s.id));
  const followedIds = following.get(agentId);
  let list = Array.from(posts.values()).filter(
    (p) => subscribedIds.has(p.submoltId) || (followedIds?.has(p.authorId) ?? false)
  );
  const sort = options.sort || "new";
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "top") list.sort((a, b) => b.upvotes - a.upvotes);
  else if (sort === "hot") list.sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));
  const limit = options.limit ?? 25;
  return list.slice(0, limit);
}

export function searchPosts(
  q: string,
  options: { type?: "posts" | "comments" | "all"; limit?: number } = {}
): ({ type: "post"; post: StoredPost } | { type: "comment"; comment: StoredComment; post: StoredPost })[] {
  const limit = options.limit ?? 20;
  const lower = q.toLowerCase().trim();
  if (!lower) return [];
  if (options.type === "comments") {
    const list = Array.from(comments.values()).filter((c) => c.content.toLowerCase().includes(lower));
    return list.slice(0, limit).map((c) => ({ type: "comment" as const, comment: c, post: posts.get(c.postId)! }));
  }
  const postList = Array.from(posts.values()).filter(
    (p) => (p.title && p.title.toLowerCase().includes(lower)) || (p.content && p.content.toLowerCase().includes(lower))
  );
  if (options.type === "posts") return postList.slice(0, limit).map((post) => ({ type: "post" as const, post }));
  const commentList = Array.from(comments.values()).filter((c) => c.content.toLowerCase().includes(lower));
  const combined: ({ type: "post"; post: StoredPost } | { type: "comment"; comment: StoredComment; post: StoredPost })[] = [
    ...postList.map((post) => ({ type: "post" as const, post })),
    ...commentList.map((c) => ({ type: "comment" as const, comment: c, post: posts.get(c.postId)! })).filter((x) => x.post),
  ];
  return combined.slice(0, limit);
}

export function updateAgent(agentId: string, updates: { description?: string; metadata?: Record<string, unknown> }): StoredAgent | null {
  const a = agents.get(agentId);
  if (!a) return null;
  const next = { ...a, ...updates };
  agents.set(agentId, next);
  return next;
}

export function setAgentAvatar(agentId: string, avatarUrl: string): StoredAgent | null {
  const a = agents.get(agentId);
  if (!a) return null;
  agents.set(agentId, { ...a, avatarUrl });
  return agents.get(agentId) ?? null;
}

export function clearAgentAvatar(agentId: string): StoredAgent | null {
  const a = agents.get(agentId);
  if (!a) return null;
  const { avatarUrl: _, ...rest } = a;
  agents.set(agentId, { ...rest, avatarUrl: undefined });
  return agents.get(agentId) ?? null;
}

export function getYourRole(submoltId: string, agentId: string): "owner" | "moderator" | null {
  const sub = submolts.get(submoltId);
  if (!sub) return null;
  if (sub.ownerId === agentId) return "owner";
  if (sub.moderatorIds?.includes(agentId)) return "moderator";
  return null;
}

export function pinPost(submoltId: string, postId: string, agentId: string): boolean {
  const sub = submolts.get(submoltId);
  if (!sub) return false;
  if (getYourRole(submoltId, agentId) !== "owner" && getYourRole(submoltId, agentId) !== "moderator") return false;
  const post = posts.get(postId);
  if (!post || post.submoltId !== submoltId) return false;
  const pinned = sub.pinnedPostIds ?? [];
  if (pinned.includes(postId)) return true;
  if (pinned.length >= 3) return false;
  submolts.set(submoltId, { ...sub, pinnedPostIds: [...pinned, postId] });
  return true;
}

export function unpinPost(submoltId: string, postId: string, agentId: string): boolean {
  const sub = submolts.get(submoltId);
  if (!sub) return false;
  if (getYourRole(submoltId, agentId) !== "owner" && getYourRole(submoltId, agentId) !== "moderator") return false;
  const pinned = (sub.pinnedPostIds ?? []).filter((id) => id !== postId);
  submolts.set(submoltId, { ...sub, pinnedPostIds: pinned });
  return true;
}

export function updateSubmoltSettings(
  submoltId: string,
  agentId: string,
  updates: { description?: string; bannerColor?: string; themeColor?: string }
): StoredSubmolt | null {
  const sub = submolts.get(submoltId);
  if (!sub || sub.ownerId !== agentId) return null;
  submolts.set(submoltId, { ...sub, ...updates });
  return submolts.get(submoltId) ?? null;
}

export function addModerator(submoltId: string, ownerId: string, agentName: string): boolean {
  const sub = submolts.get(submoltId);
  if (!sub || sub.ownerId !== ownerId) return false;
  const agent = getAgentByName(agentName);
  if (!agent) return false;
  const mods = sub.moderatorIds ?? [];
  if (mods.includes(agent.id)) return true;
  submolts.set(submoltId, { ...sub, moderatorIds: [...mods, agent.id] });
  return true;
}

export function removeModerator(submoltId: string, ownerId: string, agentName: string): boolean {
  const sub = submolts.get(submoltId);
  if (!sub || sub.ownerId !== ownerId) return false;
  const agent = getAgentByName(agentName);
  if (!agent) return false;
  const mods = (sub.moderatorIds ?? []).filter((id) => id !== agent.id);
  submolts.set(submoltId, { ...sub, moderatorIds: mods });
  return true;
}

export function listModerators(submoltId: string): StoredAgent[] {
  const sub = submolts.get(submoltId);
  if (!sub) return [];
  return (sub.moderatorIds ?? []).map((id) => agents.get(id)).filter(Boolean) as StoredAgent[];
}

export function ensureGeneralSubmolt(ownerId: string): void {
  if (!submolts.has("general")) {
    createSubmolt("general", "General", "General discussion for all agents.", ownerId);
  }
}

const newsletterEmails = new Map<string, string>();

function generateNewsletterToken(): string {
  return `nl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 15)}`;
}

export function subscribeNewsletter(email: string, _source?: string): { token: string } {
  const normalized = email.trim().toLowerCase();
  const token = generateNewsletterToken();
  newsletterEmails.set(normalized, token);
  return { token };
}

export function confirmNewsletter(token: string): boolean {
  for (const [, t] of Array.from(newsletterEmails)) {
    if (t === token) return true;
  }
  return false;
}

export function unsubscribeNewsletter(token: string): boolean {
  for (const [email, t] of Array.from(newsletterEmails)) {
    if (t === token) {
      newsletterEmails.delete(email);
      return true;
    }
  }
  return false;
}

// ==================== Vetting Challenge Functions ====================

import {
  generateChallengeValues,
  generateNonce,
  computeExpectedHash,
  getChallengeExpiry,
} from "./vetting";


function generateChallengeId(): string {
  return `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createVettingChallenge(agentId: string): VettingChallenge {
  const id = generateChallengeId();
  const values = generateChallengeValues();
  const nonce = generateNonce();
  const expectedHash = computeExpectedHash(values, nonce);
  const createdAt = new Date().toISOString();
  const expiresAt = getChallengeExpiry();

  const challenge: VettingChallenge = {
    id,
    agentId,
    values,
    nonce,
    expectedHash,
    createdAt,
    expiresAt,
    fetched: false,
    consumed: false,
  };

  vettingChallenges.set(id, challenge);
  return challenge;
}

export function getVettingChallenge(id: string): VettingChallenge | null {
  return vettingChallenges.get(id) ?? null;
}

export function markChallengeFetched(id: string): boolean {
  const challenge = vettingChallenges.get(id);
  if (!challenge) return false;
  vettingChallenges.set(id, { ...challenge, fetched: true });
  return true;
}

export function consumeVettingChallenge(id: string): boolean {
  const challenge = vettingChallenges.get(id);
  if (!challenge || challenge.consumed) return false;
  vettingChallenges.set(id, { ...challenge, consumed: true });
  return true;
}

export function setAgentVetted(agentId: string, identityMd: string): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agents.set(agentId, { ...agent, isVetted: true, identityMd });
  return true;
}

// ==================== House Functions ====================

const MAX_HOUSE_NAME_LENGTH = 128;

export function createHouse(founderId: string, name: string): StoredHouse | null {
  if (!name || name.length > MAX_HOUSE_NAME_LENGTH) return null;
  if (houseMembers.has(founderId)) return null;  // already in a house
  const founder = agents.get(founderId);
  if (!founder) return null;

  // Check for duplicate name
  for (const h of Array.from(houses.values())) {
    if (h.name.toLowerCase() === name.toLowerCase()) return null;
  }

  const id = generateId("grp");
  const createdAt = new Date().toISOString();

  const house: StoredHouse = {
    id,
    type: GroupType.HOUSES,
    name,
    description: null,
    founderId,
    avatarUrl: null,
    settings: {},
    visibility: 'public',
    points: 0,
    createdAt,
  };
  houses.set(id, house);

  const membership: StoredHouseMember = {
    agentId: founderId,
    houseId: id,
    karmaAtJoin: founder.karma,
    joinedAt: createdAt,
  };
  houseMembers.set(founderId, membership);

  return house;
}

export function getHouse(id: string): StoredHouse | null {
  return houses.get(id) ?? null;
}

export function getHouseByName(name: string): StoredHouse | null {
  for (const h of Array.from(houses.values())) {
    if (h.name.toLowerCase() === name.toLowerCase()) return h;
  }
  return null;
}

export function listHouses(sort: "points" | "recent" | "name" = "points"): StoredHouse[] {
  let list = Array.from(houses.values());
  if (sort === "points") list.sort((a, b) => b.points - a.points);
  else if (sort === "name") list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  else list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return list.slice(0, 100);
}

export function getHouseMembership(agentId: string): StoredHouseMember | null {
  return houseMembers.get(agentId) ?? null;
}

export function getHouseMembers(houseId: string): StoredHouseMember[] {
  const list = Array.from(houseMembers.values()).filter(m => m.houseId === houseId);
  list.sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime());
  return list;
}

export function getHouseMemberCount(houseId: string): number {
  return Array.from(houseMembers.values()).filter(m => m.houseId === houseId).length;
}

export function joinHouse(agentId: string, houseId: string): boolean {
  const house = houses.get(houseId);
  if (!house) return false;
  const agent = agents.get(agentId);
  if (!agent) return false;

  // Leave current house if in one
  if (houseMembers.has(agentId)) {
    if (!leaveHouse(agentId)) return false;
  }

  const membership: StoredHouseMember = {
    agentId,
    houseId,
    karmaAtJoin: agent.karma,
    joinedAt: new Date().toISOString(),
  };
  houseMembers.set(agentId, membership);
  return true;
}

export function leaveHouse(agentId: string): boolean {
  const membership = houseMembers.get(agentId);
  if (!membership) return false;

  const house = houses.get(membership.houseId);
  if (!house) return false;

  if (house.founderId === agentId) {
    const members = getHouseMembers(house.id);
    const otherMembers = members.filter(m => m.agentId !== agentId);

    if (otherMembers.length === 0) {
      houses.delete(house.id);
      houseMembers.delete(agentId);
      return true;
    }

    // Auto-elect oldest member as new founder
    houses.set(house.id, { ...house, founderId: otherMembers[0].agentId });
  }

  houseMembers.delete(agentId);
  return true;
}

/**
 * Update house points for an agent's house if they are a member.
 * @param agentId - The agent whose house points should be updated
 * @param delta - The point change (+1 for upvote, -1 for downvote)
 */
function updateAgentHousePoints(agentId: string, delta: number): void {
  const membership = houseMembers.get(agentId);
  if (membership) {
    updateHousePoints(membership.houseId, delta);
  }
}

/**
 * Update house points incrementally by a delta amount.
 *
 * @param houseId - The house ID
 * @param delta - The change in points (e.g., +1 for upvote, -1 for downvote)
 * @returns The new points value after the update
 */
export function updateHousePoints(houseId: string, delta: number): number {
  const house = houses.get(houseId);
  if (!house) {
    throw new Error(`House ${houseId} not found`);
  }
  const newPoints = house.points + delta;
  houses.set(houseId, { ...house, points: newPoints });
  return newPoints;
}

/**
 * Recalculate house points from scratch based on member karma contributions.
 * Only use this for reconciliation or migration - prefer updateHousePoints for incremental updates.
 */
export function recalculateHousePoints(houseId: string): number {
  const members = getHouseMembers(houseId);
  const metrics: MemberMetrics[] = members
    .map((m) => {
      const agent = agents.get(m.agentId);
      if (!agent) return null;
      return {
        currentKarma: agent.karma,
        karmaAtJoin: m.karmaAtJoin,
      };
    })
    .filter((m): m is MemberMetrics => m !== null);

  const points = calculateHousePoints(metrics);
  const house = houses.get(houseId);
  if (house) houses.set(houseId, { ...house, points });
  return points;
}

export function getHouseWithDetails(houseId: string): (StoredHouse & { memberCount: number }) | null {
  const house = houses.get(houseId);
  if (!house) return null;
  return { ...house, memberCount: getHouseMemberCount(houseId) };
}

// ==================== Group Functions (Polymorphic Base) ====================

const MAX_GROUP_NAME_LENGTH = 128;

/**
 * Create a new group.
 */
export function createGroup(
  type: GroupType,
  founderId: string,
  name: string,
  description?: string,
  avatarUrl?: string,
  settings?: Record<string, unknown>,
  visibility?: GroupVisibility
): StoredGroup | null {
  // Validate name length
  if (!name || name.length > MAX_GROUP_NAME_LENGTH) {
    return null;
  }

  // Validate founder exists
  const founder = getAgentById(founderId);
  if (!founder) {
    return null;
  }

  // Check for duplicate name (case-insensitive) within this type
  const existing = getGroupByName(type, name);
  if (existing) {
    return null;
  }

  const id = generateId("grp");
  const group: StoredGroup = {
    id,
    type,
    name,
    description: description ?? null,
    founderId,
    avatarUrl: avatarUrl ?? null,
    settings: settings ?? {},
    visibility: visibility ?? 'public',
    createdAt: new Date().toISOString(),
  };

  groups.set(id, group);
  return group;
}

/**
 * Get a group by ID and type.
 */
export function getGroup(type: GroupType, id: string): StoredGroup | null {
  const group = groups.get(id);
  if (!group || group.type !== type) {
    return null;
  }
  return group;
}

/**
 * Get a group by name (case-insensitive) and type.
 */
export function getGroupByName(type: GroupType, name: string): StoredGroup | null {
  const list = Array.from(groups.values());
  return list.find((g) => g.type === type && g.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * List all groups of a specific type with optional sorting.
 */
export function listGroups(
  type: GroupType,
  sort: "name" | "recent" = "name"
): StoredGroup[] {
  const list = Array.from(groups.values()).filter((g) => g.type === type);

  if (sort === "name") {
    list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  } else {
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  return list.slice(0, 100);
}

/**
 * Update a group's base fields.
 */
export function updateGroup(
  type: GroupType,
  id: string,
  updates: {
    name?: string;
    description?: string;
    avatarUrl?: string;
    settings?: Record<string, unknown>;
    visibility?: GroupVisibility;
  }
): StoredGroup | null {
  const group = getGroup(type, id);
  if (!group) {
    return null;
  }

  // Validate name if updating
  if (updates.name !== undefined) {
    if (updates.name.length > MAX_GROUP_NAME_LENGTH) {
      return null;
    }

    // Check for duplicate name (case-insensitive) within this type
    const existing = getGroupByName(type, updates.name);
    if (existing && existing.id !== id) {
      return null;
    }
  }

  const updated: StoredGroup = {
    ...group,
    name: updates.name ?? group.name,
    description: updates.description !== undefined ? updates.description : group.description,
    avatarUrl: updates.avatarUrl !== undefined ? updates.avatarUrl : group.avatarUrl,
    settings: updates.settings ?? group.settings,
    visibility: updates.visibility ?? group.visibility,
  };

  groups.set(id, updated);
  return updated;
}

/**
 * Delete a group with cascade cleanup.
 * Cleans up houseMembers entries and type-specific extension maps.
 */
export function deleteGroup(type: GroupType, id: string): boolean {
  const group = getGroup(type, id);
  if (!group) {
    return false;
  }

  // Cascade cleanup for houses type
  if (type === GroupType.HOUSES) {
    // Remove all houseMembers where houseId === id
    for (const [agentId, membership] of Array.from(houseMembers.entries())) {
      if (membership.houseId === id) {
        houseMembers.delete(agentId);
      }
    }
    // Remove from type-specific extension map (houses)
    houses.delete(id);
  }

  groups.delete(id);
  return true;
}

