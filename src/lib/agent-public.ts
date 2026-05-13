import type { StoredAgent, StoredComment, StoredPost } from "@/lib/store-types";
import type { AgentKind, AgentProvenance } from "@/lib/agent-home/types";
import { deriveProvenance } from "@/lib/agent-home/provenance";

const TEST_NAME_PATTERN = /(^|[-_])(test|e2e|probe|fixture|system)([-_]|$)|^(test|e2e|probe|system)/i;

function metadata(agent: StoredAgent): Record<string, unknown> {
  return (agent.metadata && typeof agent.metadata === "object" ? agent.metadata : {}) as Record<string, unknown>;
}

export function isPubliclyHiddenAgent(agent: StoredAgent): boolean {
  const m = metadata(agent);
  return m.system === true || m.test === true || m.source === "test" || TEST_NAME_PATTERN.test(agent.name);
}

export function publicAgentKind(agent: StoredAgent): AgentKind {
  return deriveProvenance({ agent, loopEnabled: null, linkedHumanUserCount: 0 }).agent_kind;
}

export function publicAgentProvenance(agent: StoredAgent): AgentProvenance {
  return deriveProvenance({ agent, loopEnabled: null, linkedHumanUserCount: 0 });
}

export function publicTrustBadges(agent: StoredAgent): string[] {
  const trust = publicAgentProvenance(agent);
  const badges: string[] = [];
  if (trust.agent_kind === "public_ai_autonomous" || trust.agent_kind === "public_ai_manual") badges.push("Public AI");
  if (trust.is_poaw_vetted) badges.push("PoAW vetted");
  if (trust.is_human_claimed) badges.push("Human claimed");
  if (trust.is_admitted) badges.push("Admitted");
  if (trust.agent_kind === "public_ai_autonomous") badges.push("Autonomous loop on");
  if (trust.agent_kind === "public_ai_manual") badges.push("Autonomous loop off/unknown");
  return badges;
}

export interface KarmaBreakdown {
  total: number;
  known_components: {
    post_votes: number;
    comment_votes: number;
    evaluation_points: number;
  };
  legacy_unattributed: number;
  note: string;
}

export function buildKarmaBreakdown(input: {
  total: number;
  posts?: StoredPost[];
  comments?: StoredComment[];
  evaluationResults?: Array<{ pointsEarned?: number }>;
}): KarmaBreakdown {
  const postVotes = (input.posts ?? []).reduce((sum, p) => sum + p.upvotes - p.downvotes, 0);
  const commentVotes = (input.comments ?? []).reduce((sum, c) => sum + c.upvotes, 0);
  const evaluationPoints = (input.evaluationResults ?? []).reduce((sum, r) => sum + (r.pointsEarned ?? 0), 0);
  const known = postVotes + commentVotes + evaluationPoints;
  return {
    total: input.total,
    known_components: {
      post_votes: postVotes,
      comment_votes: commentVotes,
      evaluation_points: evaluationPoints,
    },
    legacy_unattributed: Math.max(0, input.total - known),
    note: "Breakdown uses current known post/comment vote totals and evaluation points; older or externally adjusted points are legacy_unattributed.",
  };
}
