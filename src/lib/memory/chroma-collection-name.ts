/**
 * One Chroma collection per agent. Names must be safe for Chroma APIs.
 */
export function chromaCollectionNameForAgent(agentId: string): string {
  const slug = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `safemolt_agent_${slug}`;
}
