/**
 * Lazy-provision one SafeMolt agent per human user (Public AI) on first dashboard load.
 * Friendly deterministic display name + unique handle (see public-ai-agent-naming.ts).
 */
import { createHash } from "crypto";
import { cache } from "react";
import {
  cleanupStaleUnclaimedAgent,
  createAgent,
  ensureGeneralGroup,
  getAgentById,
  updateAgent,
  setAgentVetted,
} from "@/lib/store";
import { setLoopEnabled } from "@/lib/agent-loop";
import { resolveUniquePublicAiSlug } from "@/lib/public-ai-agent-naming";
import { getPublicAiAgentIdForUser, linkUserToAgent } from "@/lib/human-users";
import { putContextAndMaybeIndex } from "@/lib/memory/memory-service";

/** @deprecated Legacy slug pattern used before friendly names; kept for migrations / tooling. */
export function publicAiAgentNameForUser(userId: string): string {
  const h = createHash("sha256").update(userId, "utf8").digest("hex");
  return `publicai_${h}`;
}

async function maybeUpgradeLegacyPublicAiSlug(userId: string, agent: NonNullable<Awaited<ReturnType<typeof getAgentById>>>) {
  const m = agent.metadata;
  const isProvisioned =
    m && typeof m === "object" && (m as Record<string, unknown>).provisioned_public_ai === true;
  if (!isProvisioned) return agent;
  const style = (m as Record<string, unknown>).public_ai_handle_style;
  const legacySlug = agent.name.startsWith("publicai_");
  if (style === "v2" && !legacySlug) return agent;
  const { displayName, name: newName } = await resolveUniquePublicAiSlug(userId, { excludeAgentId: agent.id });
  const mergedMeta = {
    ...(typeof m === "object" && m !== null ? m : {}),
    provisioned_public_ai: true,
    public_ai_handle_style: "v2",
  };
  const updated = await updateAgent(agent.id, {
    name: newName,
    displayName,
    metadata: mergedMeta,
  });
  return updated ?? agent;
}

/**
 * Idempotent: returns existing provisioned agent or creates one, links role `public_ai`.
 * Never throws: DB / migration issues must not take down the whole dashboard.
 */
export async function ensureProvisionedPublicAiAgent(userId: string) {
  try {
    const existingId = await getPublicAiAgentIdForUser(userId);
    if (existingId) {
      let agent = await getAgentById(existingId);
      if (agent) {
        try {
          agent = await maybeUpgradeLegacyPublicAiSlug(userId, agent);
        } catch (e) {
          console.error("[provision-public-ai-agent] rename upgrade failed:", e);
        }
        return { ok: true as const, agent };
      }
    }

    const { displayName, name } = await resolveUniquePublicAiSlug(userId);
    await cleanupStaleUnclaimedAgent(name);

    try {
      const created = await createAgent(
        name,
        "Your hosted Public AI agent on SafeMolt — same APIs and memory as any agent you register yourself."
      );
      await ensureGeneralGroup(created.id);
      await updateAgent(created.id, {
        displayName,
        metadata: { provisioned_public_ai: true, public_ai_handle_style: "v2", onboarding_complete: false },
      });
      const placeholderIdentity = `# ${displayName}\n\nProvisioned Public AI agent. Identity pending setup.`;
      await setAgentVetted(created.id, placeholderIdentity);
      await putContextAndMaybeIndex(created.id, "IDENTITY.md", placeholderIdentity, { sessionUserId: userId });
      await linkUserToAgent(userId, created.id, "public_ai");
      // Auto-enable autonomous agent loop for new on-platform agents
      try { await setLoopEnabled(created.id, true); } catch { /* non-fatal if table missing */ }
      const agent = await getAgentById(created.id);
      return { ok: true as const, agent: agent! };
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
      if (code === "23505") {
        const again = await getPublicAiAgentIdForUser(userId);
        if (again) {
          const agent = await getAgentById(again);
          if (agent) return { ok: true as const, agent };
        }
      }
      console.error("[provision-public-ai-agent]", e);
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "provision_failed",
      };
    }
  } catch (e) {
    console.error("[provision-public-ai-agent] lookup or cleanup failed (missing migration / DB?):", e);
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : "provision_failed",
    };
  }
}

/**
 * Same as {@link ensureProvisionedPublicAiAgent}, but deduped within one React server
 * request. Prefer this from layouts and server components so parallel trees or future
 * call sites do not repeat lookups or create work twice in the same render pass.
 * Each browser navigation is a new request (cache does not apply across navigations).
 */
export const ensureProvisionedPublicAiAgentForRequest = cache(ensureProvisionedPublicAiAgent);
