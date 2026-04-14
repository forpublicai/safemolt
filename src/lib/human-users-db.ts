/**
 * Human dashboard users and agent linking (Postgres).
 */
import { sql } from "@/lib/db";
import type { StoredAgent } from "./store-types";
import type { StoredHumanUser } from "./human-users-types";
import type { InferenceSettingsUpdate, UserInferenceSettingsFlags } from "./human-users-inference-types";

function generateHumanId(): string {
  return `hu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function rowToHumanUser(r: Record<string, unknown>): StoredHumanUser {
  return {
    id: r.id as string,
    cognitoSub: r.cognito_sub as string,
    email: (r.email as string) ?? null,
    name: (r.name as string) ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export async function upsertHumanUserByCognitoSub(input: {
  cognitoSub: string;
  email?: string | null;
  name?: string | null;
}): Promise<StoredHumanUser> {
  const existing = await sql!`
    SELECT * FROM human_users WHERE cognito_sub = ${input.cognitoSub} LIMIT 1
  `;
  const row = existing[0] as Record<string, unknown> | undefined;
  if (row) {
    await sql!`
      UPDATE human_users
      SET email = COALESCE(${input.email ?? null}, email),
          name = COALESCE(${input.name ?? null}, name)
      WHERE cognito_sub = ${input.cognitoSub}
    `;
    const again = await sql!`SELECT * FROM human_users WHERE cognito_sub = ${input.cognitoSub} LIMIT 1`;
    return rowToHumanUser(again[0] as Record<string, unknown>);
  }
  const id = generateHumanId();
  const createdAt = new Date().toISOString();
  await sql!`
    INSERT INTO human_users (id, cognito_sub, email, name, created_at)
    VALUES (${id}, ${input.cognitoSub}, ${input.email ?? null}, ${input.name ?? null}, ${createdAt})
  `;
  const inserted = await sql!`SELECT * FROM human_users WHERE id = ${id} LIMIT 1`;
  return rowToHumanUser(inserted[0] as Record<string, unknown>);
}

export async function getHumanUserById(id: string): Promise<StoredHumanUser | null> {
  const rows = await sql!`SELECT * FROM human_users WHERE id = ${id} LIMIT 1`;
  const r = rows[0] as Record<string, unknown> | undefined;
  return r ? rowToHumanUser(r) : null;
}

export type HumanUserWithFlags = StoredHumanUser & {
  isAdmissionsStaff: boolean;
};

export async function listAllHumanUsers(): Promise<HumanUserWithFlags[]> {
  const rows = await sql!`SELECT * FROM human_users ORDER BY created_at DESC`;
  return (rows as Record<string, unknown>[]).map((r) => ({
    ...rowToHumanUser(r),
    isAdmissionsStaff: Boolean(r.is_admissions_staff),
  }));
}

export async function linkUserToAgent(userId: string, agentId: string, role = "owner"): Promise<void> {
  await sql!`
    INSERT INTO user_agents (user_id, agent_id, role)
    VALUES (${userId}, ${agentId}, ${role})
    ON CONFLICT (user_id, agent_id) DO UPDATE SET role = EXCLUDED.role
  `;
}

export async function unlinkUserFromAgent(userId: string, agentId: string): Promise<void> {
  await sql!`DELETE FROM user_agents WHERE user_id = ${userId} AND agent_id = ${agentId}`;
}

export async function userOwnsAgent(userId: string, agentId: string): Promise<boolean> {
  const rows = await sql!`
    SELECT 1 FROM user_agents WHERE user_id = ${userId} AND agent_id = ${agentId} LIMIT 1
  `;
  return rows.length > 0;
}

export async function listUserIdsLinkedToAgent(agentId: string): Promise<string[]> {
  const rows = await sql!`
    SELECT user_id FROM user_agents WHERE agent_id = ${agentId}
  `;
  return (rows as { user_id: string }[]).map((r) => r.user_id);
}

export async function isHumanAdmissionsStaff(userId: string): Promise<boolean> {
  try {
    const rows = await sql!`
      SELECT is_admissions_staff FROM human_users WHERE id = ${userId} LIMIT 1
    `;
    const r = rows[0] as { is_admissions_staff?: boolean } | undefined;
    return Boolean(r?.is_admissions_staff);
  } catch {
    return false;
  }
}

export type LinkedAgentRow = { agent: StoredAgent; linkRole: string };

export async function listLinkedAgentsForUser(userId: string): Promise<LinkedAgentRow[]> {
  const rows = await sql!`
    SELECT a.*, ua.role AS link_role FROM agents a
    INNER JOIN user_agents ua ON ua.agent_id = a.id
    WHERE ua.user_id = ${userId}
    ORDER BY ua.linked_at DESC
  `;
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    const linkRole = String(row.link_role ?? "owner");
    return { agent: rowToAgent(row), linkRole };
  });
}

function rowToAgent(row: Record<string, unknown>): StoredAgent {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    apiKey: row.api_key as string,
    points: Number(row.points),
    followerCount: Number(row.follower_count),
    isClaimed: Boolean(row.is_claimed),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    avatarUrl: row.avatar_url as string | undefined,
    displayName: row.display_name as string | undefined,
    lastActiveAt: row.last_active_at
      ? row.last_active_at instanceof Date
        ? row.last_active_at.toISOString()
        : String(row.last_active_at)
      : undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
    owner: row.owner as string | undefined,
    claimToken: row.claim_token as string | undefined,
    verificationCode: row.verification_code as string | undefined,
    xFollowerCount: row.x_follower_count != null ? Number(row.x_follower_count) : undefined,
    isVetted: row.is_vetted != null ? Boolean(row.is_vetted) : undefined,
    identityMd: row.identity_md as string | undefined,
  };
}

export async function listAgentsForUser(userId: string): Promise<StoredAgent[]> {
  const linked = await listLinkedAgentsForUser(userId);
  return linked.map((x) => x.agent);
}

export async function getPublicAiAgentIdForUser(userId: string): Promise<string | null> {
  const rows = await sql!`
    SELECT agent_id FROM user_agents
    WHERE user_id = ${userId} AND role = 'public_ai'
    LIMIT 1
  `;
  const r = rows[0] as { agent_id: string } | undefined;
  return r?.agent_id ?? null;
}

export async function getUserAgentLinkRole(
  userId: string,
  agentId: string
): Promise<string | null> {
  const rows = await sql!`
    SELECT role FROM user_agents WHERE user_id = ${userId} AND agent_id = ${agentId} LIMIT 1
  `;
  const r = rows[0] as { role: string } | undefined;
  return r?.role ?? null;
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
  try {
    const rows = await sql!`
      SELECT hf_token_override, public_ai_token, openai_token, anthropic_token, openrouter_token, primary_inference_provider
      FROM user_inference_settings WHERE user_id = ${userId} LIMIT 1
    `;
    const r = rows[0] as UserInferenceSecrets | undefined;
    if (!r) return null;
    return {
      hf_token_override: r.hf_token_override?.trim() || null,
      public_ai_token: r.public_ai_token?.trim() || null,
      openai_token: r.openai_token?.trim() || null,
      anthropic_token: r.anthropic_token?.trim() || null,
      openrouter_token: r.openrouter_token?.trim() || null,
      primary_inference_provider: r.primary_inference_provider?.trim() || null,
    };
  } catch {
    try {
      const hf = await getUserInferenceTokenOverride(userId);
      if (!hf) return null;
      return {
        hf_token_override: hf,
        public_ai_token: null,
        openai_token: null,
        anthropic_token: null,
        openrouter_token: null,
        primary_inference_provider: null,
      };
    } catch {
      return null;
    }
  }
}

export async function getUserInferenceTokenOverride(userId: string): Promise<string | null> {
  const rows = await sql!`
    SELECT hf_token_override FROM user_inference_settings WHERE user_id = ${userId} LIMIT 1
  `;
  const r = rows[0] as { hf_token_override: string | null } | undefined;
  const t = r?.hf_token_override?.trim();
  return t || null;
}

export async function getUserInferenceSettingsFlags(userId: string): Promise<UserInferenceSettingsFlags> {
  try {
    const rows = await sql!`
      SELECT hf_token_override, public_ai_token, openai_token, anthropic_token, openrouter_token, primary_inference_provider
      FROM user_inference_settings WHERE user_id = ${userId} LIMIT 1
    `;
    const r = rows[0] as
      | {
          hf_token_override: string | null;
          public_ai_token: string | null;
          openai_token: string | null;
          anthropic_token: string | null;
          openrouter_token: string | null;
          primary_inference_provider: string | null;
        }
      | undefined;
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
  } catch {
    const hf = await getUserInferenceTokenOverride(userId);
    return {
      has_hf: Boolean(hf),
      has_public_ai: false,
      has_openai: false,
      has_anthropic: false,
      has_openrouter: false,
      primary_inference_provider: null,
    };
  }
}

export async function setUserInferenceSettingsFields(
  userId: string,
  updates: InferenceSettingsUpdate
): Promise<UserInferenceSettingsFlags> {
  const rows = await sql!`
    SELECT hf_token_override, public_ai_token, openai_token, anthropic_token, openrouter_token, primary_inference_provider
    FROM user_inference_settings WHERE user_id = ${userId} LIMIT 1
  `;
  const cur = rows[0] as
    | {
        hf_token_override: string | null;
        public_ai_token: string | null;
        openai_token: string | null;
        anthropic_token: string | null;
        openrouter_token: string | null;
        primary_inference_provider: string | null;
      }
    | undefined;

  const norm = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

  const mergeToken = (
    key: "hf_token" | "public_ai_token" | "openai_token" | "anthropic_token" | "openrouter_token",
    previous: string | null
  ): string | null => {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return norm(previous);
    const v = updates[key];
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    return typeof v === "string" ? v.trim() : null;
  };

  const hf = mergeToken("hf_token", cur?.hf_token_override ?? null);
  const publicAi = mergeToken("public_ai_token", cur?.public_ai_token ?? null);
  const openai = mergeToken("openai_token", cur?.openai_token ?? null);
  const anthropic = mergeToken("anthropic_token", cur?.anthropic_token ?? null);
  const openrouter = mergeToken("openrouter_token", cur?.openrouter_token ?? null);
  let primary: string | null = norm(cur?.primary_inference_provider ?? null);
  if (Object.prototype.hasOwnProperty.call(updates, "primary_inference_provider")) {
    const p = updates.primary_inference_provider;
    primary = p === null || p === undefined || String(p).trim() === "" ? null : String(p).trim();
  }

  const anyToken = hf || publicAi || openai || anthropic || openrouter;
  if (!anyToken && !primary) {
    await sql!`DELETE FROM user_inference_settings WHERE user_id = ${userId}`;
  } else {
    await sql!`
      INSERT INTO user_inference_settings (
        user_id, hf_token_override, public_ai_token, openai_token, anthropic_token, openrouter_token,
        primary_inference_provider, updated_at
      )
      VALUES (
        ${userId}, ${hf}, ${publicAi}, ${openai}, ${anthropic}, ${openrouter},
        ${primary}, NOW()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        hf_token_override = EXCLUDED.hf_token_override,
        public_ai_token = EXCLUDED.public_ai_token,
        openai_token = EXCLUDED.openai_token,
        anthropic_token = EXCLUDED.anthropic_token,
        openrouter_token = EXCLUDED.openrouter_token,
        primary_inference_provider = EXCLUDED.primary_inference_provider,
        updated_at = NOW()
    `;
  }

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
  const rows = await sql!`
    INSERT INTO sponsored_inference_usage (user_id, day, request_count)
    VALUES (${userId}, CURRENT_DATE, 1)
    ON CONFLICT (user_id, day)
    DO UPDATE SET request_count = sponsored_inference_usage.request_count + 1
    RETURNING request_count
  `;
  const count = Number((rows[0] as { request_count: number }).request_count);
  return { count, limit };
}

export async function getSponsoredInferenceUsageToday(userId: string): Promise<number> {
  const rows = await sql!`
    SELECT request_count FROM sponsored_inference_usage
    WHERE user_id = ${userId} AND day = CURRENT_DATE
    LIMIT 1
  `;
  if (!rows[0]) return 0;
  return Number((rows[0] as { request_count: number }).request_count);
}
