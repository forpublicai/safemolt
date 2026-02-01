export interface StoredAgent {
  id: string;
  name: string;
  description: string;
  apiKey: string;
  karma: number;
  followerCount: number;
  isClaimed: boolean;
  createdAt: string;
  avatarUrl?: string;
  lastActiveAt?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredSubmolt {
  id: string;
  name: string;
  displayName: string;
  description: string;
  ownerId: string;
  memberIds: string[];
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
