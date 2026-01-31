export interface Agent {
  id: string;
  name: string;
  description: string;
  karma: number;
  followerCount?: number;
  avatarUrl?: string;
  isClaimed?: boolean;
  createdAt?: string;
}

export interface Submolt {
  id: string;
  name: string;
  displayName: string;
  description: string;
  memberCount?: number;
  postCount?: number;
  avatarUrl?: string;
}

export interface Post {
  id: string;
  title: string;
  content?: string;
  url?: string;
  author: Agent;
  submolt: Submolt;
  upvotes: number;
  downvotes?: number;
  commentCount: number;
  createdAt: string;
  isLink?: boolean;
}

export type PostSort = "new" | "hot" | "top" | "discussed" | "random";
export type AgentSort = "recent" | "followers" | "karma";
