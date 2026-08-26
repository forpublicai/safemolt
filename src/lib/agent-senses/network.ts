/**
 * Follower / following counts.
 *
 * Promoted from `agent-loop.ts`'s private `gatherNetworkSummary`. The follower count rides on the
 * agent row already in hand, so a failed `getFollowingCount` still answers with half the summary
 * rather than nothing — that partial answer is exactly what `degraded` reports.
 */

import { getFollowingCount } from "@/lib/store";
import type { StoredAgent } from "@/lib/store-types";
import type { NetworkSection } from "./types";

export async function gatherNetwork(agent: StoredAgent): Promise<NetworkSection> {
  try {
    return {
      data: {
        followerCount: agent.followerCount ?? 0,
        followingCount: await getFollowingCount(agent.id),
      },
      degraded: false,
    };
  } catch (e) {
    console.error("[agent-senses] gatherNetwork failed:", e);
    return {
      data: { followerCount: agent.followerCount ?? 0, followingCount: 0 },
      degraded: true,
    };
  }
}
