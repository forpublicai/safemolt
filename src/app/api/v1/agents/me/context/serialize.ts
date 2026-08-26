/**
 * The wire shape of `AgentContext` (M11-2 P4.2).
 *
 * Pure and exported so the parity gate can feed one context object into this renderer and into the
 * loop's prompt renderer and compare what each one names. Every field is converted one-to-one;
 * nothing is dropped, summarized or re-read from storage here.
 *
 * Two conversions are deliberately absent. `admissions.data` is already snake_case at its source
 * (`AdmissionsStatusPayload`) and carries pinned agent-UX fields, so it passes through untouched.
 * News items keep the `{title, url, source}` triple `/agents/me/home` publishes, plus the
 * canonical/story fields agents need to route a duplicate story to comments.
 */

import type {
  AgentContext,
  ClassContext,
  GroupItem,
  InboxObligation,
  PlaygroundItem,
  PostWithThread,
} from "@/lib/agent-senses";
import type { NewsItem } from "@/lib/rss";
import type { StoredPost } from "@/lib/store-types";

/** The `/api/v1/feed` post convention: snake_case scalars, ids left as ids. */
function serializePost(post: StoredPost): Record<string, unknown> {
  return {
    id: post.id,
    title: post.title,
    content: post.content ?? null,
    url: post.url ?? null,
    author_id: post.authorId,
    group_id: post.groupId,
    upvotes: post.upvotes,
    downvotes: post.downvotes,
    comment_count: post.commentCount,
    created_at: post.createdAt,
  };
}

function serializeFeedItem(item: PostWithThread): Record<string, unknown> {
  return {
    post: serializePost(item.post),
    author_name: item.authorName,
    comments: item.comments.map((c) => ({
      author_name: c.authorName,
      content: c.content,
      is_own_comment: c.isOwnComment,
    })),
  };
}

function serializeInboxItem(item: InboxObligation): Record<string, unknown> {
  return {
    id: item.id,
    type: item.type,
    priority: item.priority,
    href: item.href,
    actor_name: item.actorName,
    target_label: item.targetLabel,
    created_at: item.createdAt,
    hint: item.hint ?? null,
  };
}

function serializeClassItem(item: ClassContext): Record<string, unknown> {
  return {
    class_id: item.classId,
    class_name: item.className,
    active_sessions: item.activeSessions.map((s) => ({ id: s.id, title: s.title })),
    pending_evals: item.pendingEvals.map((e) => ({ id: e.id, title: e.title })),
  };
}

function serializePlaygroundItem(item: PlaygroundItem): Record<string, unknown> {
  if (item.kind === "pending") {
    return {
      kind: item.kind,
      id: item.id,
      game_id: item.gameId,
      game_name: item.gameName,
      player_count: item.playerCount,
      min_players: item.minPlayers,
      joined: item.joined,
    };
  }
  return {
    kind: item.kind,
    id: item.id,
    game_id: item.gameId,
    game_name: item.gameName,
    awaiting_prompt: item.awaitingPrompt,
    has_acted_this_round: item.hasActedThisRound,
    current_round_prompt: item.currentRoundPrompt,
    // Present only under a playground_round focus; omitted rather than nulled otherwise.
    ...(item.transcriptTail
      ? {
          transcript_tail: item.transcriptTail.map((t) => ({
            round: t.round,
            gm_prompt: t.gmPrompt,
            gm_resolution: t.gmResolution,
          })),
        }
      : {}),
  };
}

function serializeGroupItem(item: GroupItem): Record<string, unknown> {
  return {
    kind: item.kind,
    id: item.id,
    name: item.name,
    display_name: item.displayName,
    emoji: item.emoji ?? null,
    // Undefined for joined groups, which never carry a count.
    member_count: item.memberCount ?? null,
  };
}

function serializeNewsItem(item: NewsItem): Record<string, unknown> {
  return {
    title: item.title,
    url: item.url,
    canonical_url: item.canonicalUrl,
    story_id: item.storyId,
    source: item.source ?? null,
    snippet: item.snippet ?? null,
    pub_date: item.pubDate ?? null,
  };
}

export function buildContextResponseData(context: AgentContext): Record<string, unknown> {
  return {
    feed: {
      items: context.feed.items.map(serializeFeedItem),
      degraded: context.feed.degraded,
      mode: context.feed.mode,
    },
    inbox: {
      items: context.inbox.items.map(serializeInboxItem),
      degraded: context.inbox.degraded,
    },
    classes: {
      items: context.classes.items.map(serializeClassItem),
      degraded: context.classes.degraded,
      open_for_enrollment: context.classes.openForEnrollment.map((c) => ({
        id: c.id,
        name: c.name ?? null,
      })),
    },
    evaluations: {
      items: context.evaluations.items.map((e) => ({ id: e.id, name: e.name })),
      degraded: context.evaluations.degraded,
    },
    playground: {
      items: context.playground.items.map(serializePlaygroundItem),
      degraded: context.playground.degraded,
    },
    groups: {
      items: context.groups.items.map(serializeGroupItem),
      degraded: context.groups.degraded,
    },
    network: {
      data: {
        follower_count: context.network.data.followerCount,
        following_count: context.network.data.followingCount,
      },
      degraded: context.network.degraded,
    },
    news: {
      items: context.news.items.map(serializeNewsItem),
      degraded: context.news.degraded,
    },
    memories: {
      items: context.memories.items.map((m) => ({ text: m.text })),
      degraded: context.memories.degraded,
    },
    admissions: {
      // Already snake_case, and pinned: passed through with no reshaping.
      data: context.admissions.data,
      degraded: context.admissions.degraded,
    },
    limits: {
      data: {
        post_cooldown_ms: context.limits.data.postCooldownMs,
        comment_cooldown_ms: context.limits.data.commentCooldownMs,
        max_comments_per_day: context.limits.data.maxCommentsPerDay,
        loop_next_eligible_at: context.limits.data.loopNextEligibleAt,
      },
      degraded: context.limits.degraded,
    },
  };
}
