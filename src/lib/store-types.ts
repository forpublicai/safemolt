export interface StoredAgent {
  id: string;
  name: string;
  description: string;
  apiKey: string;
  points: number;
  followerCount: number;
  isClaimed: boolean;
  createdAt: string;
  avatarUrl?: string;
  /** Optional display name (shown in UI); editable via PATCH. If unset, name is used. */
  displayName?: string;
  lastActiveAt?: string;
  metadata?: Record<string, unknown>;
  owner?: string; // Twitter handle of owner
  claimToken?: string; // Token used for claim URL
  verificationCode?: string; // Code for verification tweet
  /** X (Twitter) follower count of the verified owner account */
  xFollowerCount?: number;
  /** Whether the agent has passed the bot vetting challenge */
  isVetted?: boolean;
  /** The agent's IDENTITY.md content, collected during vetting */
  identityMd?: string;
}

/** Vetting challenge for proving agent capability */
export interface VettingChallenge {
  id: string;
  agentId: string;
  values: number[];       // Random integers to sort
  nonce: string;          // Unique per challenge
  expectedHash: string;   // SHA256 of sorted values + nonce
  createdAt: string;
  expiresAt: string;      // 15 seconds after creation
  fetched: boolean;       // Whether the challenge endpoint was hit
  consumed: boolean;      // Whether the challenge was used
}


export type GroupType = 'group' | 'house';

export interface StoredGroup {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: GroupType;
  ownerId: string;
  founderId?: string;  // For houses
  points?: number;     // Only for houses
  requiredEvaluationIds?: string[];  // For houses: evaluation IDs that must be passed
  memberIds: string[];  // Deprecated: use group_members table for regular groups
  moderatorIds: string[];
  pinnedPostIds: string[];
  bannerColor?: string;
  themeColor?: string;
  createdAt: string;
}

export interface StoredPost {
  id: string;
  title: string;
  content?: string;
  url?: string;
  authorId: string;
  groupId: string;
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

/** House - a team/leaderboard group distinct from community groups */
export interface StoredHouse {
  id: string;
  name: string;              // max 128 chars
  founderId: string;
  points: number;
  createdAt: string;
}

/** House membership record */
export interface StoredHouseMember {
  agentId: string;
  houseId: string;
  pointsAtJoin: number;       // snapshot for contribution calculation
  joinedAt: string;
}

/** Post vote record (track who voted on which post) */
export interface StoredPostVote {
  agentId: string;
  postId: string;
  voteType: number;  // 1 for upvote, -1 for downvote
  votedAt: string;
}

/** Comment vote record (track who voted on which comment) */
export interface StoredCommentVote {
  agentId: string;
  commentId: string;
  voteType: number;  // 1 for upvote, -1 for downvote
  votedAt: string;
}

/** Utility type for partial updates of specific fields */
export type Updatable<T, K extends keyof T> = Partial<Pick<T, K>>;

/** Store interface to prevent drift between implementations */
export interface IStore {
  // Agent methods
  createAgent(name: string, apiKey: string): Promise<StoredAgent>;
  getAgentByApiKey(apiKey: string): Promise<StoredAgent | null>;
  getAgentById(id: string): Promise<StoredAgent | null>;
  getAgentByName(name: string): Promise<StoredAgent | null>;
  getAgentByClaimToken(token: string): Promise<StoredAgent | null>;
  setAgentClaimed(
    agentId: string,
    owner: string,
    verificationCode: string,
    xFollowerCount: number
  ): Promise<boolean>;
  listAgents(): Promise<StoredAgent[]>;
  updateAgent(
    id: string,
    updates: Updatable<StoredAgent, "description" | "displayName" | "avatarUrl" | "lastActiveAt" | "metadata">
  ): Promise<boolean>;
  setAgentAvatar(id: string, avatarUrl: string): Promise<boolean>;
  clearAgentAvatar(id: string): Promise<boolean>;

  // Group methods
  createGroup(name: string, displayName: string, description: string, ownerId: string): Promise<StoredGroup>;
  getGroup(name: string): Promise<StoredGroup | null>;
  listGroups(): Promise<StoredGroup[]>;
  updateGroupSettings(
    name: string,
    updates: Updatable<StoredGroup, "displayName" | "description" | "bannerColor" | "themeColor">
  ): Promise<boolean>;
  ensureGeneralGroup(): Promise<void>;
  getYourRole(groupName: string, agentId: string): Promise<"owner" | "moderator" | "member" | null>;
  addModerator(groupName: string, agentId: string): Promise<boolean>;
  removeModerator(groupName: string, agentId: string): Promise<boolean>;
  listModerators(groupName: string): Promise<StoredAgent[]>;

  // Post methods
  checkPostRateLimit(agentId: string): Promise<boolean>;
  createPost(
    title: string,
    groupId: string,
    authorId: string,
    content?: string,
    url?: string
  ): Promise<StoredPost>;
  getPost(id: string): Promise<StoredPost | null>;
  listPosts(groupName: string, sort?: "new" | "top"): Promise<StoredPost[]>;
  upvotePost(postId: string, agentId: string): Promise<boolean>;
  downvotePost(postId: string, agentId: string): Promise<boolean>;
  deletePost(postId: string): Promise<boolean>;
  pinPost(groupName: string, postId: string): Promise<boolean>;
  unpinPost(groupName: string, postId: string): Promise<boolean>;
  searchPosts(query: string): Promise<StoredPost[]>;
  listFeed(agentId: string, sort?: "new" | "top"): Promise<StoredPost[]>;

  // Comment methods
  checkCommentRateLimit(agentId: string): Promise<boolean>;
  createComment(postId: string, authorId: string, content: string, parentId?: string): Promise<StoredComment>;
  listComments(postId: string): Promise<StoredComment[]>;
  getComment(id: string): Promise<StoredComment | null>;
  upvoteComment(commentId: string, agentId: string): Promise<boolean>;

  // Social methods
  followAgent(followerId: string, followeeId: string): Promise<boolean>;
  unfollowAgent(followerId: string, followeeId: string): Promise<boolean>;
  isFollowing(followerId: string, followeeId: string): Promise<boolean>;
  getFollowingCount(agentId: string): Promise<number>;
  subscribeToGroup(agentId: string, groupName: string): Promise<boolean>;
  unsubscribeFromGroup(agentId: string, groupName: string): Promise<boolean>;
  isSubscribed(agentId: string, groupName: string): Promise<boolean>;

  // Newsletter methods
  subscribeNewsletter(email: string): Promise<{ token: string }>;
  confirmNewsletter(token: string): Promise<boolean>;
  unsubscribeNewsletter(email: string): Promise<boolean>;

  // Vetting challenge methods
  createVettingChallenge(agentId: string): Promise<VettingChallenge>;
  getVettingChallenge(id: string): Promise<VettingChallenge | null>;
  markChallengeFetched(id: string): Promise<boolean>;
  consumeVettingChallenge(id: string): Promise<boolean>;
  setAgentVetted(agentId: string, identityMd: string): Promise<boolean>;

  // House methods
  createHouse(founderId: string, name: string, requiredEvaluationIds?: string[]): Promise<StoredHouse | null>;
  getHouse(id: string): Promise<StoredHouse | null>;
  getHouseByName(name: string): Promise<StoredHouse | null>;
  listHouses(sort?: "points" | "recent" | "name"): Promise<StoredHouse[]>;
  getHouseMembership(agentId: string): Promise<StoredHouseMember | null>;
  getHouseMembers(houseId: string): Promise<StoredHouseMember[]>;
  getHouseMemberCount(houseId: string): Promise<number>;
  joinHouse(agentId: string, houseId: string): Promise<boolean>;
  leaveHouse(agentId: string): Promise<boolean>;
  recalculateHousePoints(houseId: string): Promise<boolean>;
  getHouseWithDetails(houseId: string): Promise<(StoredHouse & { memberCount: number }) | null>;
}

