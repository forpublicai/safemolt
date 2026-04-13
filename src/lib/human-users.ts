import { hasDatabase } from "./db";
import type { StoredAgent } from "./store-types";
import type { StoredHumanUser } from "./human-users-types";
import * as db from "./human-users-db";
import * as mem from "./human-users-memory";
import type { LinkedAgentRow, UserInferenceSecrets } from "./human-users-db";

export type { StoredHumanUser };
export type { LinkedAgentRow };
export type { UserInferenceSecrets };

export async function upsertHumanUserByCognitoSub(input: {
  cognitoSub: string;
  email?: string | null;
  name?: string | null;
}): Promise<StoredHumanUser> {
  if (hasDatabase()) return db.upsertHumanUserByCognitoSub(input);
  return mem.upsertHumanUserByCognitoSub(input);
}

export async function getHumanUserById(id: string): Promise<StoredHumanUser | null> {
  if (hasDatabase()) return db.getHumanUserById(id);
  return mem.getHumanUserById(id);
}

export async function linkUserToAgent(userId: string, agentId: string, role?: string): Promise<void> {
  if (hasDatabase()) return db.linkUserToAgent(userId, agentId, role);
  return mem.linkUserToAgent(userId, agentId, role);
}

export async function unlinkUserFromAgent(userId: string, agentId: string): Promise<void> {
  if (hasDatabase()) return db.unlinkUserFromAgent(userId, agentId);
  return mem.unlinkUserFromAgent(userId, agentId);
}

export async function userOwnsAgent(userId: string, agentId: string): Promise<boolean> {
  if (hasDatabase()) return db.userOwnsAgent(userId, agentId);
  return mem.userOwnsAgent(userId, agentId);
}

export async function listLinkedAgentsForUser(userId: string): Promise<LinkedAgentRow[]> {
  if (hasDatabase()) return db.listLinkedAgentsForUser(userId);
  return mem.listLinkedAgentsForUser(userId);
}

export async function listAgentsForUser(userId: string): Promise<StoredAgent[]> {
  if (hasDatabase()) return db.listAgentsForUser(userId);
  return mem.listAgentsForUser(userId);
}

export async function getPublicAiAgentIdForUser(userId: string): Promise<string | null> {
  if (hasDatabase()) return db.getPublicAiAgentIdForUser(userId);
  return mem.getPublicAiAgentIdForUser(userId);
}

export async function getUserAgentLinkRole(
  userId: string,
  agentId: string
): Promise<string | null> {
  if (hasDatabase()) return db.getUserAgentLinkRole(userId, agentId);
  return mem.getUserAgentLinkRole(userId, agentId);
}

export async function getUserInferenceSecrets(userId: string): Promise<UserInferenceSecrets | null> {
  if (hasDatabase()) return db.getUserInferenceSecrets(userId);
  return mem.getUserInferenceSecrets(userId);
}

export async function getUserInferenceTokenOverride(userId: string): Promise<string | null> {
  if (hasDatabase()) return db.getUserInferenceTokenOverride(userId);
  return mem.getUserInferenceTokenOverride(userId);
}

export async function getUserInferenceSettingsFlags(userId: string) {
  if (hasDatabase()) return db.getUserInferenceSettingsFlags(userId);
  return mem.getUserInferenceSettingsFlags(userId);
}

export async function setUserInferenceSettingsFields(
  userId: string,
  updates: import("./human-users-inference-types").InferenceSettingsUpdate
) {
  if (hasDatabase()) return db.setUserInferenceSettingsFields(userId, updates);
  return mem.setUserInferenceSettingsFields(userId, updates);
}

export async function setUserInferenceTokenOverride(
  userId: string,
  token: string | null
): Promise<void> {
  if (hasDatabase()) return db.setUserInferenceTokenOverride(userId, token);
  return mem.setUserInferenceTokenOverride(userId, token);
}

export async function incrementSponsoredInferenceUsage(
  userId: string
): Promise<{ count: number; limit: number }> {
  if (hasDatabase()) return db.incrementSponsoredInferenceUsage(userId);
  return mem.incrementSponsoredInferenceUsage(userId);
}

export async function getSponsoredInferenceUsageToday(userId: string): Promise<number> {
  if (hasDatabase()) return db.getSponsoredInferenceUsageToday(userId);
  return mem.getSponsoredInferenceUsageToday(userId);
}

