/**
 * In-memory human users (when no Postgres). Ephemeral across cold starts.
 */
import type { StoredAgent } from "./store-types";
import type { StoredHumanUser } from "./human-users-types";

const usersBySub = new Map<string, StoredHumanUser>();
const usersById = new Map<string, StoredHumanUser>();
/** userId -> agentId -> role */
const links = new Map<string, Map<string, string>>();
const sponsoredCounts = new Map<string, number>(); // `${userId}:${day}` -> count
const inferenceOverrides = new Map<string, string>();

function memId(sub: string): string {
  return `hu_mem_${sub.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 48)}`;
}

export async function upsertHumanUserByCognitoSub(input: {
  cognitoSub: string;
  email?: string | null;
  name?: string | null;
}): Promise<StoredHumanUser> {
  let u = usersBySub.get(input.cognitoSub);
  if (u) {
    u = {
      ...u,
      email: input.email ?? u.email,
      name: input.name ?? u.name,
    };
    usersBySub.set(input.cognitoSub, u);
    usersById.set(u.id, u);
    return u;
  }
  const id = memId(input.cognitoSub);
  const createdAt = new Date().toISOString();
  u = {
    id,
    cognitoSub: input.cognitoSub,
    email: input.email ?? null,
    name: input.name ?? null,
    createdAt,
  };
  usersBySub.set(input.cognitoSub, u);
  usersById.set(id, u);
  return u;
}

export async function getHumanUserById(id: string): Promise<StoredHumanUser | null> {
  return usersById.get(id) ?? null;
}

export async function linkUserToAgent(userId: string, agentId: string, role = "owner"): Promise<void> {
  let m = links.get(userId);
  if (!m) {
    m = new Map();
    links.set(userId, m);
  }
  m.set(agentId, role);
}

export async function unlinkUserFromAgent(userId: string, agentId: string): Promise<void> {
  links.get(userId)?.delete(agentId);
}

export async function userOwnsAgent(userId: string, agentId: string): Promise<boolean> {
  return links.get(userId)?.has(agentId) ?? false;
}

export type LinkedAgentRow = { agent: StoredAgent; linkRole: string };

export async function listLinkedAgentsForUser(userId: string): Promise<LinkedAgentRow[]> {
  const { getAgentById } = await import("./store-memory");
  const m = links.get(userId);
  if (!m) return [];
  const out: LinkedAgentRow[] = [];
  for (const [aid, role] of Array.from(m.entries())) {
    const a = await getAgentById(aid);
    if (a) out.push({ agent: a, linkRole: role });
  }
  return out;
}

export async function listAgentsForUser(userId: string): Promise<StoredAgent[]> {
  const linked = await listLinkedAgentsForUser(userId);
  return linked.map((x) => x.agent);
}

export async function getPublicAiAgentIdForUser(userId: string): Promise<string | null> {
  const m = links.get(userId);
  if (!m) return null;
  for (const [agentId, role] of Array.from(m.entries())) {
    if (role === "public_ai") return agentId;
  }
  return null;
}

export async function getUserAgentLinkRole(
  userId: string,
  agentId: string
): Promise<string | null> {
  return links.get(userId)?.get(agentId) ?? null;
}

export async function getUserInferenceTokenOverride(userId: string): Promise<string | null> {
  const t = inferenceOverrides.get(userId)?.trim();
  return t || null;
}

export async function setUserInferenceTokenOverride(
  userId: string,
  token: string | null
): Promise<void> {
  const trimmed = token?.trim() || null;
  if (trimmed) inferenceOverrides.set(userId, trimmed);
  else inferenceOverrides.delete(userId);
}

export async function incrementSponsoredInferenceUsage(
  userId: string
): Promise<{ count: number; limit: number }> {
  const limit = parseInt(
    process.env.PUBLIC_AI_SPONSORED_DAILY_LIMIT ||
      process.env.DEMO_DAILY_REQUEST_LIMIT ||
      "100",
    10
  );
  const day = new Date().toISOString().slice(0, 10);
  const key = `${userId}:${day}`;
  const n = (sponsoredCounts.get(key) ?? 0) + 1;
  sponsoredCounts.set(key, n);
  return { count: n, limit };
}

export async function getSponsoredInferenceUsageToday(userId: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  return sponsoredCounts.get(`${userId}:${day}`) ?? 0;
}
