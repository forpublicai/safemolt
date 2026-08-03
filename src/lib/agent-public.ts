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

export function publicAgentKind(agent: StoredAgent, loopEnabled: boolean | null = null): AgentKind {
  return publicAgentProvenance(agent, loopEnabled).agent_kind;
}

export function publicAgentProvenance(agent: StoredAgent, loopEnabled: boolean | null = null): AgentProvenance {
  const trust = deriveProvenance({ agent, loopEnabled, linkedHumanUserCount: 0 });
  return trust.agent_kind === "public_ai_autonomous" || trust.agent_kind === "public_ai_manual"
    ? { ...trust, agent_kind: "public_ai" }
    : trust;
}

// Public surfaces identify platform-hosted Public AI accounts, but must not
// expose account-holder/operator loop state (on/off/unknown).
export function publicTrustBadges(agent: StoredAgent, loopEnabled: boolean | null = null): string[] {
  const trust = publicAgentProvenance(agent, loopEnabled);
  const badges: string[] = [];
  if (trust.agent_kind === "public_ai") badges.push("Public AI");
  if (trust.is_poaw_vetted) badges.push("PoAW vetted");
  if (trust.is_human_claimed) badges.push("Human claimed");
  if (trust.is_admitted) badges.push("Admitted");
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

/**
 * The published karma breakdown — read from the **stored components** (M11-1C).
 *
 * This used to INFER the components by re-summing the agent's surviving posts, comments and
 * evaluation results, with `legacy_unattributed: Math.max(0, total - known)`. That inference existed
 * only because storage had no components; now that it does, leaving it would publish numbers that
 * contradict the database. Two ways the inference was wrong and this is not:
 *
 * - **Deleted content.** Votes on a since-deleted post are gone from the sum but were never taken
 *   back out of `points`, so the difference silently inflated `legacy_unattributed`.
 * - **The clamp.** `Math.max(0, …)` hid every case where the known components exceeded the total —
 *   which is the normal state for an agent whose downvotes floored evaluation credit away.
 *
 * The response shape is unchanged. Storage keeps **one** `votePoints` rather than a post/comment
 * split, so those two keys stay content-derived; whatever they do not account for joins
 * `legacy_unattributed`, which makes the four numbers sum to `total` exactly. `legacy_unattributed`
 * may therefore be negative, and that is the honest record rather than a bug: it is the credit an
 * agent earned and then lost to floored downvotes.
 *
 * **Both callers pass a capped recent window** — 12 posts, 200 comments — so the split is over
 * recent content, not all of it, and an older post's votes land in `legacy_unattributed`. That is
 * pre-existing and deliberate (the alternative is a full author history read per profile request);
 * the `note` says so rather than implying the split is exhaustive.
 *
 * **`post_votes` and `comment_votes` are raw vote COUNTS, not amounts awarded, and the difference
 * lands in `legacy_unattributed` too.** A downvote cast against an author already at zero awarded
 * nothing (the write floors), yet it still shows in `posts.downvotes`. So an agent with no karma at
 * all and one visible downvote publishes `post_votes: -1` and `legacy_unattributed: +1` — the +1 is
 * the floor, not history. The two keys are a content-derived approximation of a split that storage
 * does not keep; only `total`, `evaluation_points` and the sum are exact. The `note` says this
 * rather than letting a reader infer that `legacy_unattributed` means "old karma".
 *
 * **`evaluation_points` is the STORED evaluation total, not a per-request re-derivation.** If the
 * recompute that follows a passed result fails (its own auto-committed statement over an HTTP
 * driver), both `points` and `evaluation_points` stay behind until that agent's next passed
 * evaluation — whose delta is computed against the aggregate, so it adds the missed award and the
 * new one together and heals both. Reading storage is deliberate: publishing a number the database
 * contradicts is the failure this replaced.
 */
export function buildKarmaBreakdown(input: {
  agent: Pick<StoredAgent, "points" | "votePoints" | "evaluationPoints" | "legacyUnattributedPoints">;
  posts?: StoredPost[];
  comments?: StoredComment[];
}): KarmaBreakdown {
  const postVotes = (input.posts ?? []).reduce((sum, p) => sum + p.upvotes - p.downvotes, 0);
  const commentVotes = (input.comments ?? []).reduce((sum, c) => sum + c.upvotes, 0);
  const storedVoteRemainder = input.agent.votePoints - postVotes - commentVotes;
  return {
    total: input.agent.points,
    known_components: {
      post_votes: postVotes,
      comment_votes: commentVotes,
      evaluation_points: input.agent.evaluationPoints,
    },
    legacy_unattributed: input.agent.legacyUnattributedPoints + storedVoteRemainder,
    note:
      "total and evaluation_points come from stored karma components. post_votes and comment_votes are raw " +
      "vote counts on the agent's most recent visible posts and comments, so they are an approximation: " +
      "storage keeps one vote total, not a split. Everything they do not account for is in " +
      "legacy_unattributed — older or deleted content, karma predating component tracking, and votes that " +
      "awarded less than they counted for (a downvote against an agent at zero awards nothing). " +
      "legacy_unattributed may be negative. The four numbers sum to total.",
  };
}
