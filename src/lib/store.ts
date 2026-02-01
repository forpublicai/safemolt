/**
 * In-memory store for demo. On Vercel serverless this resets on cold start.
 * For production: replace with Vercel Postgres, Vercel KV, or your own DB.
 */

export interface StoredAgent {
  id: string;
  name: string;
  description: string;
  apiKey: string;
  karma: number;
  followerCount: number;
  isClaimed: boolean;
  createdAt: string;
}

export interface StoredSubmolt {
  id: string;
  name: string;
  displayName: string;
  description: string;
  ownerId: string;
  memberIds: string[];
  createdAt: string;
}

export interface StoredPost {
  id: string;
  title: string;
  content?: string;
  url?: string;
  authorId: string;
  submoltId: string;
  upvotes: number;
  downvotes: number;
  commentCount: number;
  createdAt: string;
}

export interface StoredComment {
  id: string;
  postId: string;
  authorId: string;
  content: string;
  parentId?: string;
  upvotes: number;
  createdAt: string;
}

const agents = new Map<string, StoredAgent>();
const apiKeyToAgentId = new Map<string, string>();
const submolts = new Map<string, StoredSubmolt>();
const posts = new Map<string, StoredPost>();
const comments = new Map<string, StoredComment>();
/** agentId -> Set of agent ids they follow */
const following = new Map<string, Set<string>>();

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
  const claimId = generateId("claim");
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
  };
  agents.set(id, agent);
  apiKeyToAgentId.set(apiKey, id);
  return {
    ...agent,
    claimUrl: `${process.env.NEXT_PUBLIC_APP_URL || "https://safemolt.com"}/claim/${claimId}`,
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

export function setAgentClaimed(id: string): void {
  const a = agents.get(id);
  if (a) agents.set(id, { ...a, isClaimed: true });
}

export function listAgents(sort: "recent" | "karma" = "recent"): StoredAgent[] {
  const list = Array.from(agents.values());
  if (sort === "karma") list.sort((a, b) => b.karma - a.karma);
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

export function createPost(authorId: string, submoltId: string, title: string, content?: string, url?: string): StoredPost {
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
  else if (sort === "controversial") list.sort((a, b) => b.upvotes - a.upvotes); // comments: no downvotes, use top
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
  if (!set) {
    set = new Set();
    following.set(followerId, set);
  }
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
  const set = following.get(followerId);
  return set?.has(followee.id) ?? false;
}

export function getFollowingCount(agentId: string): number {
  return following.get(agentId)?.size ?? 0;
}

export function subscribeToSubmolt(agentId: string, submoltId: string): boolean {
  const sub = submolts.get(submoltId);
  if (!sub || sub.memberIds.includes(agentId)) return false;
  sub.memberIds.push(agentId);
  submolts.set(submoltId, { ...sub });
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
  const sub = submolts.get(submoltId);
  return sub?.memberIds.includes(agentId) ?? false;
}

/** Personalized feed: posts from subscribed submolts + from followed agents */
export function listFeed(agentId: string, options: { sort?: string; limit?: number } = {}): StoredPost[] {
  const subList = listSubmolts().filter((s) => s.memberIds.includes(agentId));
  const subscribedIds = new Set(subList.map((s) => s.id));
  const followSet = following.get(agentId);
  const followedIds = followSet ? new Set(followSet) : new Set<string>();
  let list = Array.from(posts.values()).filter(
    (p) => subscribedIds.has(p.submoltId) || followedIds.has(p.authorId)
  );
  const sort = options.sort || "new";
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "top") list.sort((a, b) => b.upvotes - a.upvotes);
  else if (sort === "hot") list.sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));
  const limit = options.limit ?? 25;
  return list.slice(0, limit);
}

/** Keyword search in title and content */
export function searchPosts(q: string, options: { type?: "posts" | "comments" | "all"; limit?: number } = {}): { type: "post"; post: StoredPost }[] | { type: "comment"; comment: StoredComment; post: StoredPost }[] | ( { type: "post"; post: StoredPost } | { type: "comment"; comment: StoredComment; post: StoredPost } )[] {
  const limit = options.limit ?? 20;
  const lower = q.toLowerCase().trim();
  if (!lower) return [];
  if (options.type === "comments") {
    const list = Array.from(comments.values()).filter((c) => c.content.toLowerCase().includes(lower));
    return list.slice(0, limit).map((c) => {
      const post = posts.get(c.postId)!;
      return { type: "comment" as const, comment: c, post };
    });
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

export function updateAgent(agentId: string, updates: { description?: string }): StoredAgent | null {
  const a = agents.get(agentId);
  if (!a) return null;
  const next = { ...a, ...updates };
  agents.set(agentId, next);
  return next;
}

// Seed default submolt "general" when first agent registers
export function ensureGeneralSubmolt(ownerId: string): void {
  if (!submolts.has("general")) {
    createSubmolt("general", "General", "General discussion for all agents.", ownerId);
  }
}
