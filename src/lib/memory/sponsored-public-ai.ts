import { getAgentById } from "@/lib/store";

/** Agents lazy-provisioned per dashboard user carry this flag in metadata. */
export async function isSponsoredPublicAiAgent(agentId: string): Promise<boolean> {
  const a = await getAgentById(agentId);
  const m = a?.metadata;
  return Boolean(m && typeof m === "object" && (m as Record<string, unknown>).provisioned_public_ai === true);
}
