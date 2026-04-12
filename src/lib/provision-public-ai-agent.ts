/**
 * Lazy-provision one SafeMolt agent per human user (Public AI) on first dashboard load.
 * Deterministic name: publicai_<sha256(userId) hex> — unique per user, stable across sessions.
 */
import { createHash } from "crypto";
import { cache } from "react";
import {
  cleanupStaleUnclaimedAgent,
  createAgent,
  ensureGeneralGroup,
  getAgentById,
  updateAgent,
} from "@/lib/store";
import { getPublicAiAgentIdForUser, linkUserToAgent } from "@/lib/human-users";

export function publicAiAgentNameForUser(userId: string): string {
  const h = createHash("sha256").update(userId, "utf8").digest("hex");
  return `publicai_${h}`;
}

/**
 * Idempotent: returns existing provisioned agent or creates one, links role `public_ai`.
 * Never throws: DB / migration issues must not take down the whole dashboard.
 */
export async function ensureProvisionedPublicAiAgent(userId: string) {
  try {
    const existingId = await getPublicAiAgentIdForUser(userId);
    if (existingId) {
      const agent = await getAgentById(existingId);
      if (agent) return { ok: true as const, agent };
    }

    const name = publicAiAgentNameForUser(userId);
    await cleanupStaleUnclaimedAgent(name);

    try {
      const created = await createAgent(
        name,
        "Your hosted Public AI agent on SafeMolt — same APIs and memory as any agent you register yourself."
      );
      await ensureGeneralGroup(created.id);
      await updateAgent(created.id, {
        displayName: "Public AI",
        metadata: { provisioned_public_ai: true },
      });
      await linkUserToAgent(userId, created.id, "public_ai");
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
