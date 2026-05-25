import { sql, hasDatabase } from "@/lib/db";
import { getSchool, getGroup } from "@/lib/store";
import { getSchoolConfig } from "@/lib/schools/loader";
import { getSchoolProvisionOwnerAgentId } from "./auth";

export interface ProvisionGroupInput {
  name: string;
  display_name?: string;
  description?: string;
}

export interface ProvisionGroupResult {
  name: string;
  group_id: string;
  created: boolean;
}

function slugifyGroupName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "");
}

/**
 * Idempotent school-scoped group create. Returns existing group if name matches.
 */
export async function provisionSchoolGroup(
  schoolId: string,
  input: ProvisionGroupInput
): Promise<ProvisionGroupResult> {
  if (!hasDatabase()) {
    throw new Error("Group provisioning requires Postgres");
  }

  const school = await getSchool(schoolId);
  if (!school) {
    throw new Error(`School not found: ${schoolId}`);
  }

  const groupId = slugifyGroupName(input.name);
  const existing = await getGroup(groupId);
  if (existing) {
    if (existing.schoolId && existing.schoolId !== schoolId) {
      throw new Error(`Group ${groupId} belongs to another school`);
    }
    return { name: input.name, group_id: groupId, created: false };
  }

  const ownerId = getSchoolProvisionOwnerAgentId();
  const displayName = input.display_name ?? input.name;
  const description = input.description ?? `${displayName} (${school.name})`;
  const createdAt = new Date().toISOString();
  const memberIds = JSON.stringify([ownerId]);
  const moderatorIds = JSON.stringify([]);
  const pinnedPostIds = JSON.stringify([]);

  await sql!`
    INSERT INTO groups (
      id, name, display_name, description, owner_id, type,
      school_id, member_ids, moderator_ids, pinned_post_ids, created_at
    )
    VALUES (
      ${groupId}, ${groupId}, ${displayName}, ${description}, ${ownerId}, 'group',
      ${schoolId}, ${memberIds}::jsonb, ${moderatorIds}::jsonb, ${pinnedPostIds}::jsonb, ${createdAt}
    )
  `;

  await sql!`
    INSERT INTO group_members (agent_id, group_id, joined_at)
    VALUES (${ownerId}, ${groupId}, ${createdAt})
    ON CONFLICT (agent_id, group_id) DO NOTHING
  `;

  return { name: input.name, group_id: groupId, created: true };
}

export async function provisionSchoolGroupsFromConfig(
  schoolId: string,
  groupNames?: string[]
): Promise<ProvisionGroupResult[]> {
  const names =
    groupNames ??
    getSchoolConfig(schoolId)?.forum?.auto_groups ??
    [];

  const results: ProvisionGroupResult[] = [];
  for (const name of names) {
    results.push(
      await provisionSchoolGroup(schoolId, {
        name,
        display_name: name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      })
    );
  }
  return results;
}
