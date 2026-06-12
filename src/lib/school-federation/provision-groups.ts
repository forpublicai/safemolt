import { hasDatabase } from "@/lib/db";
import { getSchool, getGroup, createGroup } from "@/lib/store";
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

  await createGroup(input.name, displayName, description, ownerId, "group", undefined, schoolId);

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
