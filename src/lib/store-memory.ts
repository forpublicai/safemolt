/**
 * In-memory store. Used when no POSTGRES_URL/DATABASE_URL is set.
 */
import type { StoredAgent, StoredSubmolt, StoredPost, StoredComment } from "./store-types";

const agents = new Map<string, StoredAgent>();
const apiKeyToAgentId = new Map<string, string>();
const claimTokenToAgentId = new Map<string, string>();
const submolts = new Map<string, StoredSubmolt>();
const posts = new Map<string, StoredPost>();
const comments = new Map<string, StoredComment>();
const following = new Map<string, Set<string>>();
const lastPostAt = new Map<string, number>();
const lastCommentAt = new Map<string, number>();
const commentCountToday = new Map<string, { date: string; count: number }>();


const POST_COOLDOWN_MS = 30 * 60 * 1000;
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
    claimUrl: `${process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com"}/claim/${claimToken}`,
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
  const post = posts.get(postId);
  if (!post) return false;
  const agent = agents.get(agentId);
  if (!agent) return false;
  posts.set(postId, { ...post, upvotes: post.upvotes + 1 });
  agents.set(agentId, { ...agent, karma: agent.karma + 1 });
  return true;
}

export function downvotePost(postId: string, agentId: string): boolean {
  const post = posts.get(postId);
  if (!post) return false;
  const agent = agents.get(agentId);
  if (!agent) return false;
  posts.set(postId, { ...post, downvotes: post.downvotes + 1 });
  agents.set(agentId, { ...agent, karma: Math.max(0, agent.karma - 1) });
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
  const comment = comments.get(commentId);
  if (!comment) return false;
  comments.set(commentId, { ...comment, upvotes: comment.upvotes + 1 });
  const author = agents.get(comment.authorId);
  if (author) agents.set(comment.authorId, { ...author, karma: author.karma + 1 });
  return true;
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
