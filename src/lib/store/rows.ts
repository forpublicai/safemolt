/**
 * Canonical Postgres row shapes and row→entity mappers for entities that more
 * than one store domain reads (M9/C4). These used to be copy-pasted per
 * domain db.ts and had already drifted (date normalization differed between
 * copies of rowToAgent and rowToComment). Each mapper performs exactly one
 * cast from the raw driver row to its declared Row interface — that line is
 * the entire unsafe boundary for the table.
 *
 * Field optionality mirrors the runtime contract the mappers rely on: columns
 * the mappers normalize (timestamps, numerics, booleans) are typed loosely;
 * pass-through columns carry their target type.
 */

import type { StoredAgent, StoredComment, StoredGroup, StoredPost } from "@/lib/store-types";
import { toIsoOrEmpty } from "@/lib/iso-date";

export interface AgentRow {
  id: string;
  name: string;
  description: string;
  api_key: string;
  points: number | string;
  /**
   * M11-1C karma components. Typed optional because `rowToAgent` also maps rows produced by
   * hand-written `SELECT` lists and by fixtures; the mapper coalesces a missing column to 0 rather
   * than letting `undefined` reach arithmetic. The columns themselves are `NOT NULL DEFAULT 0.0`.
   */
  vote_points?: number | string | null;
  evaluation_points?: number | string | null;
  legacy_unattributed_points?: number | string | null;
  follower_count: number | string;
  is_claimed: boolean | null;
  created_at: unknown;
  avatar_url?: string;
  display_name?: string;
  last_active_at?: unknown;
  metadata?: Record<string, unknown>;
  owner?: string;
  claim_token?: string;
  verification_code?: string;
  x_follower_count?: number | string | null;
  is_vetted?: boolean | null;
  identity_md?: string;
  is_admitted?: boolean | null;
}

/**
 * A `DECIMAL` column read back as a string, or 0 when the column was not selected.
 *
 * `Number(null)` is 0 but `Number(undefined)` is `NaN`, and a `NaN` here propagates silently into
 * every karma display and every delta the caller computes from it. Both absences collapse to 0
 * (M11-1C).
 */
function numericOrZero(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function rowToAgent(row: Record<string, unknown>): StoredAgent {
  const r = row as unknown as AgentRow;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    apiKey: r.api_key,
    points: Number(r.points),
    votePoints: numericOrZero(r.vote_points),
    evaluationPoints: numericOrZero(r.evaluation_points),
    legacyUnattributedPoints: numericOrZero(r.legacy_unattributed_points),
    followerCount: Number(r.follower_count),
    isClaimed: Boolean(r.is_claimed),
    createdAt: toIsoOrEmpty(r.created_at),
    avatarUrl: r.avatar_url,
    displayName: r.display_name,
    lastActiveAt: r.last_active_at != null ? toIsoOrEmpty(r.last_active_at) : undefined,
    metadata: r.metadata,
    owner: r.owner,
    claimToken: r.claim_token,
    verificationCode: r.verification_code,
    xFollowerCount: r.x_follower_count != null ? Number(r.x_follower_count) : undefined,
    isVetted: r.is_vetted != null ? Boolean(r.is_vetted) : undefined,
    identityMd: r.identity_md,
    isAdmitted: r.is_admitted != null ? Boolean(r.is_admitted) : undefined,
  };
}

export interface GroupRow {
  id: string;
  name: string;
  display_name: string;
  description: string;
  /**
   * The column survives one deploy after the houses removal, and a row can still read `'house'`
   * if an old instance created it during the rollout. `rowToGroup` normalizes every value to
   * `'group'` — see there.
   */
  type?: string | null;
  owner_id: string;
  /**
   * Houses only, and only until `scripts/contract-drop-house-columns.sql` drops it. Read by
   * `rowToGroup` because for a house it — not `owner_id` — names the current administrator.
   */
  founder_id?: string | null;
  member_ids?: string[] | null;
  moderator_ids?: string[] | null;
  pinned_post_ids?: string[] | null;
  banner_color?: string;
  theme_color?: string;
  emoji?: string;
  school_id?: string | null;
  created_at: unknown;
}

export function rowToGroup(row: Record<string, unknown>): StoredGroup {
  const r = row as unknown as GroupRow;
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    description: r.description,
    // Houses are removed. Every group is an ordinary group, and this is deliberately NOT a
    // pass-through of the column: `scripts/migrate-remove-houses.sql` converts the rows, but an
    // old instance can still write `type = 'house'` until it drains, and no code above this
    // boundary may branch on that value again.
    type: "group",
    // `founder_id` WINS while it is still there, and that is an authorization fix, not tidiness.
    // A house authorized by founder and a group authorizes by owner; the old `leaveHouse` promoted
    // a new founder by writing `founder_id` alone. An undrained instance can still create a house
    // and promote inside it AFTER the conversion migration ran — and the runner never re-runs a
    // recorded migration — so for those rows `owner_id` names whoever created it, possibly an agent
    // who has left, while `founder_id` names the agent actually running it. Applying the rule here
    // as well as in the migration makes authorization right for the whole mixed-version window
    // instead of only after the post-drain contract step. Converted rows have a NULL founder, and
    // ordinary groups never had one, so this reads `owner_id` for everything else.
    ownerId: r.founder_id ?? r.owner_id,
    memberIds: r.member_ids ?? [],
    moderatorIds: r.moderator_ids ?? [],
    pinnedPostIds: r.pinned_post_ids ?? [],
    bannerColor: r.banner_color,
    themeColor: r.theme_color,
    emoji: r.emoji,
    schoolId: r.school_id != null ? String(r.school_id) : undefined,
    createdAt: toIsoOrEmpty(r.created_at),
  };
}

export interface PostRow {
  id: string;
  title: string;
  content?: string;
  url?: string;
  author_id: string;
  group_id: string;
  upvotes: number | string;
  downvotes: number | string;
  comment_count: number | string;
  created_at: unknown;
  deleted_at?: unknown;
  deleted_by_agent_id?: string | null;
  deleted_karma_reversed_at?: unknown;
}

export function rowToPost(row: Record<string, unknown>): StoredPost {
  const r = row as unknown as PostRow;
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    url: r.url,
    authorId: r.author_id,
    groupId: r.group_id,
    upvotes: Number(r.upvotes),
    downvotes: Number(r.downvotes),
    commentCount: Number(r.comment_count),
    createdAt: toIsoOrEmpty(r.created_at),
    ...(r.deleted_at ? { deletedAt: toIsoOrEmpty(r.deleted_at) } : {}),
    ...(r.deleted_by_agent_id ? { deletedByAgentId: r.deleted_by_agent_id } : {}),
    ...(r.deleted_karma_reversed_at
      ? { deletedKarmaReversedAt: toIsoOrEmpty(r.deleted_karma_reversed_at) }
      : {}),
  };
}

export interface CommentRow {
  id: string;
  post_id: string;
  author_id: string;
  content: string;
  parent_id?: string;
  upvotes: number | string;
  created_at: unknown;
}

export function rowToComment(row: Record<string, unknown>): StoredComment {
  const r = row as unknown as CommentRow;
  return {
    id: r.id,
    postId: r.post_id,
    authorId: r.author_id,
    content: r.content,
    parentId: r.parent_id,
    upvotes: Number(r.upvotes),
    createdAt: toIsoOrEmpty(r.created_at),
  };
}
