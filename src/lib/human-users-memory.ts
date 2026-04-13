/**
 * In-memory human users (when no Postgres). Ephemeral across cold starts.
 */
import type { StoredAgent } from "./store-types";
import type { StoredHumanUser } from "./human-users-types";
import type { InferenceSettingsUpdate, UserInferenceSettingsFlags } from "./human-users-inference-types";

const usersBySub = new Map<string, StoredHumanUser>();
const usersById = new Map<string, StoredHumanUser>();
/** userId -> agentId -> role */
const links = new Map<string, Map<string, string>>();
const sponsoredCounts = new Map<string, number>(); // `${userId}:${day}` -> count

type InferenceRow = {
  hf_token_override: string | null;
  public_ai_token: string | null;
  openai_token: string | null;
  anthropic_token: string | null;
  openrouter_token: string | null;
  primary_inference_provider: string | null;
};
const inferenceSettings = new Map<string, InferenceRow>();

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

export async function listUserIdsLinkedToAgent(agentId: string): Promise<string[]> {
  const out: string[] = [];
  for (const [uid, m] of Array.from(links.entries())) {
    if (m.has(agentId)) out.push(uid);
  }
  return out;
}

const admissionsStaffUserIds = new Set<string>();

export async function isHumanAdmissionsStaff(userId: string): Promise<boolean> {
  return admissionsStaffUserIds.has(userId);
}

/** Test / dev: grant staff without DB column */
export function __memGrantAdmissionsStaff(userId: string): void {
  admissionsStaffUserIds.add(userId);
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

function rowFlags(r: InferenceRow | undefined): UserInferenceSettingsFlags {
  if (!r) {
    return {
      has_hf: false,
      has_public_ai: false,
      has_openai: false,
      has_anthropic: false,
      has_openrouter: false,
      primary_inference_provider: null,
    };
  }
  return {
    has_hf: Boolean(r.hf_token_override?.trim()),
    has_public_ai: Boolean(r.public_ai_token?.trim()),
    has_openai: Boolean(r.openai_token?.trim()),
    has_anthropic: Boolean(r.anthropic_token?.trim()),
    has_openrouter: Boolean(r.openrouter_token?.trim()),
    primary_inference_provider: r.primary_inference_provider?.trim() || null,
  };
}

export type UserInferenceSecrets = {
  hf_token_override: string | null;
  public_ai_token: string | null;
  openai_token: string | null;
  anthropic_token: string | null;
  openrouter_token: string | null;
  primary_inference_provider: string | null;
};

export async function getUserInferenceSecrets(userId: string): Promise<UserInferenceSecrets | null> {
  const r = inferenceSettings.get(userId);
  if (!r) return null;
  const any =
    r.hf_token_override ||
    r.public_ai_token ||
    r.openai_token ||
    r.anthropic_token ||
    r.openrouter_token;
  if (!any) return null;
  return {
    hf_token_override: r.hf_token_override?.trim() || null,
    public_ai_token: r.public_ai_token?.trim() || null,
    openai_token: r.openai_token?.trim() || null,
    anthropic_token: r.anthropic_token?.trim() || null,
    openrouter_token: r.openrouter_token?.trim() || null,
    primary_inference_provider: r.primary_inference_provider?.trim() || null,
  };
}

export async function getUserInferenceTokenOverride(userId: string): Promise<string | null> {
  const t = inferenceSettings.get(userId)?.hf_token_override?.trim();
  return t || null;
}

export async function getUserInferenceSettingsFlags(userId: string): Promise<UserInferenceSettingsFlags> {
  return rowFlags(inferenceSettings.get(userId));
}

export async function setUserInferenceSettingsFields(
  userId: string,
  updates: InferenceSettingsUpdate
): Promise<UserInferenceSettingsFlags> {
  const cur = inferenceSettings.get(userId);
  const base: InferenceRow = cur ?? {
    hf_token_override: null,
    public_ai_token: null,
    openai_token: null,
    anthropic_token: null,
    openrouter_token: null,
    primary_inference_provider: null,
  };

  const apply = (key: keyof InferenceRow, updKey: keyof InferenceSettingsUpdate) => {
    if (!Object.prototype.hasOwnProperty.call(updates, updKey)) return;
    const v = updates[updKey];
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) {
      base[key] = null;
    } else if (typeof v === "string") {
      base[key] = v.trim();
    }
  };

  apply("hf_token_override", "hf_token");
  apply("public_ai_token", "public_ai_token");
  apply("openai_token", "openai_token");
  apply("anthropic_token", "anthropic_token");
  apply("openrouter_token", "openrouter_token");
  if (Object.prototype.hasOwnProperty.call(updates, "primary_inference_provider")) {
    const p = updates.primary_inference_provider;
    base.primary_inference_provider =
      p === null || p === undefined || String(p).trim() === "" ? null : String(p).trim();
  }

  const any =
    base.hf_token_override ||
    base.public_ai_token ||
    base.openai_token ||
    base.anthropic_token ||
    base.openrouter_token ||
    base.primary_inference_provider;
  if (!any) inferenceSettings.delete(userId);
  else inferenceSettings.set(userId, base);

  return getUserInferenceSettingsFlags(userId);
}

export async function setUserInferenceTokenOverride(
  userId: string,
  token: string | null
): Promise<void> {
  await setUserInferenceSettingsFields(userId, { hf_token: token });
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
