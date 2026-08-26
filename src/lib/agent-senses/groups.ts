/**
 * Groups the agent belongs to, and groups it could join.
 *
 * Promoted from `agent-opportunities.ts` (`gatherGroupOpportunities`, M9 C8) merged with
 * `agent-loop.ts`'s member-count decoration. Two pins carry over unchanged:
 *   - membership comes from the canonical `isGroupMember` (group_members), never the legacy
 *     `member_ids` snapshot, which `joinGroup` does not maintain;
 *   - counts come from `getGroupMemberCount` for the same reason, falling back to the snapshot
 *     length only when the count read fails.
 * `memberCount` is computed for suggestions only — counting every joined group would be an
 * unbounded N+1, and no surface has ever shown it.
 */

import { getGroupMemberCount, isGroupMember, listGroups } from "@/lib/store";
import type { StoredGroup } from "@/lib/store-types";
import { DEFAULT_SUGGESTED_GROUPS_LIMIT } from "./constants";
import type { GroupItem, GroupsSection } from "./types";

export interface GatherGroupsOptions {
  schoolId?: string;
  suggestedLimit?: number;
}

function baseItem(group: StoredGroup, kind: GroupItem["kind"]): GroupItem {
  return {
    kind,
    id: group.id,
    name: group.name,
    displayName: group.displayName || group.name,
    emoji: group.emoji ?? null,
  };
}

async function toSuggestedItem(group: StoredGroup): Promise<GroupItem> {
  return {
    ...baseItem(group, "suggested"),
    memberCount: await getGroupMemberCount(group.id).catch(() => group.memberIds.length),
  };
}

export async function gatherGroups(
  agentId: string,
  opts: GatherGroupsOptions = {}
): Promise<GroupsSection> {
  try {
    const allGroups = await listGroups({ schoolId: opts.schoolId });
    const membershipPairs = await Promise.all(
      allGroups.map(async (group) => {
        try {
          return [group, await isGroupMember(agentId, group.id)] as const;
        } catch (e) {
          console.error("[agent-senses] isGroupMember failed:", e);
          return [group, false] as const;
        }
      })
    );

    const joined = membershipPairs
      .filter(([, isMember]) => isMember)
      .map(([group]) => baseItem(group, "joined"));
    const suggested = await Promise.all(
      membershipPairs
        .filter(([, isMember]) => !isMember)
        .map(([group]) => group)
        .slice(0, opts.suggestedLimit ?? DEFAULT_SUGGESTED_GROUPS_LIMIT)
        .map(toSuggestedItem)
    );

    return { items: [...joined, ...suggested], degraded: false };
  } catch (e) {
    console.error("[agent-senses] gatherGroups failed:", e);
    return { items: [], degraded: true };
  }
}
