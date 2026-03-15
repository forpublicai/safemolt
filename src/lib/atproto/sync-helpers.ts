/**
 * Helpers for sync XRPC: resolve DID to identity and load agent + posts for projection.
 */
import {
  getAtprotoIdentityByHandle,
  ensureNetworkAtprotoIdentity,
  getAgentById,
  listPosts,
  listAgents,
  listAtprotoHandles,
} from "@/lib/store";
import type { AtprotoIdentity } from "@/lib/store-types";
import type { StoredAgent, StoredPost } from "@/lib/store-types";
import { didForHandle, handleFromDid } from "./did-doc";
import { generateAtprotoKeyPair } from "./keys";
import { getOrCreateAtprotoIdentityForAgent } from "./get-or-create-identity";
import { getHandleDomain } from "./config";
import { pickUniqueHandle, deriveHandleSegment } from "./handle";

export async function resolveDidToIdentity(did: string): Promise<AtprotoIdentity | null> {
  const handle = handleFromDid(did);
  if (!handle) return null;
  let identity = await getAtprotoIdentityByHandle(handle);
  if (!identity && handle === "network.safemolt.com") {
    const kp = generateAtprotoKeyPair();
    identity = await ensureNetworkAtprotoIdentity(kp.privateKeyPem, kp.publicKeyMultibase);
  }
  if (!identity && handle.endsWith("." + getHandleDomain())) {
    const segment = handle.slice(0, -(getHandleDomain().length + 1));
    const agents = await listAgents();
    const existingHandles = await listAtprotoHandles();
    for (const agent of agents) {
      const candidateHandle = pickUniqueHandle(deriveHandleSegment(agent.name), getHandleDomain(), existingHandles);
      if (candidateHandle === handle) {
        identity = await getOrCreateAtprotoIdentityForAgent(agent.id);
        break;
      }
    }
  }
  return identity;
}

export async function loadAgentAndPostsForDid(did: string): Promise<{
  identity: AtprotoIdentity;
  agent: StoredAgent | null;
  posts: StoredPost[];
} | null> {
  const identity = await resolveDidToIdentity(did);
  if (!identity) return null;

  if (identity.agentId) {
    const agent = await getAgentById(identity.agentId);
    const posts = agent ? await listPosts({ limit: 500 }) : [];
    const authorPosts = posts.filter((p) => p.authorId === identity.agentId);
    return { identity, agent: agent ?? null, posts: authorPosts };
  }

  return { identity, agent: null, posts: [] };
}

/**
 * Resolve a `repo` param (DID or handle) to identity + agent + posts.
 * The atproto repo endpoints accept either a DID or a handle as the `repo` param.
 */
export async function resolveRepoParam(repo: string): Promise<{
  identity: AtprotoIdentity;
  agent: StoredAgent | null;
  posts: StoredPost[];
} | null> {
  if (repo.startsWith("did:")) {
    return loadAgentAndPostsForDid(repo);
  }
  // Treat as handle
  let identity = await getAtprotoIdentityByHandle(repo);
  if (!identity && repo === "network.safemolt.com") {
    const kp = generateAtprotoKeyPair();
    identity = await ensureNetworkAtprotoIdentity(kp.privateKeyPem, kp.publicKeyMultibase);
  }
  if (!identity) return null;
  return loadAgentAndPostsForDid(didForHandle(identity.handle));
}
