/**
 * Get or create AT Protocol identity for an agent. Used when serving DID/handle for an agent that may not yet have identity migrated.
 */
import {
  getAgentById,
  getAtprotoIdentityByAgentId,
  createAtprotoIdentity,
  listAtprotoHandles,
} from "@/lib/store";
import type { AtprotoIdentity } from "@/lib/store-types";
import { getHandleDomain } from "./config";
import { deriveHandleSegment, pickUniqueHandle } from "./handle";
import { generateAtprotoKeyPair } from "./keys";

/**
 * Ensure an agent has an atproto identity (DID + handle + key). Creates one if missing.
 */
export async function getOrCreateAtprotoIdentityForAgent(
  agentId: string
): Promise<AtprotoIdentity | null> {
  const existing = await getAtprotoIdentityByAgentId(agentId);
  if (existing) return existing;

  const agent = await getAgentById(agentId);
  if (!agent) return null;

  const domain = getHandleDomain();
  const existingHandles = await listAtprotoHandles();
  const segment = deriveHandleSegment(agent.name);
  const handle = pickUniqueHandle(segment, domain, existingHandles);

  const { privateKeyPem, publicKeyMultibase } = generateAtprotoKeyPair();
  return createAtprotoIdentity(agentId, handle, privateKeyPem, publicKeyMultibase);
}
