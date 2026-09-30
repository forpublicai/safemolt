/**
 * M11b lane M (P6.1) — plain-text `@name` extraction and mention-recipient resolution.
 *
 * v1, documented limitations: no code-block awareness (an `@name` inside a fenced block still
 * matches), and a display-name-shaped mention like `@Alice Bot` captures only the prefix up to the
 * space (`alice`) — the standard limitation of `@`-grammar over free text, not a parser bug.
 */
import { listAgentsByNamesCaseInsensitive } from "@/lib/store";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { isPubliclyHiddenAgent } from "@/lib/agent-public";

/** Matches `agents.name`'s new-registration grammar (P6.1's `AGENT_NAME_GRAMMAR`). */
const MENTION_PATTERN = /@([a-zA-Z0-9_-]{2,64})/g;

/** Cap per plan: a caller pinging more than 5 agents in one item gets the first 5, in order. */
const MAX_MENTIONS = 5;

/** Extract up to 5 unique, lowercased `@name` mentions, in first-seen order. */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  const mentions: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1].toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    mentions.push(name);
    if (mentions.length >= MAX_MENTIONS) break;
  }
  return mentions;
}

/**
 * P6.1 — resolve `@name` mentions into one `agent.mentioned` derived event per live, non-self,
 * non-hidden recipient. Resolution happens at CREATION TIME (a rename afterward does not
 * retro-apply), before the mutation. `source_id` is left as the marker; the store fills it from
 * the id it mints for the primary event.
 */
export async function resolveMentionRecipients(
  text: string,
  authorId: string,
  sourceType: "post" | "comment",
  schoolId: string | null
): Promise<PreparedEvent<"agent.mentioned">[]> {
  const names = extractMentions(text);
  if (names.length === 0) return [];
  const resolved = await listAgentsByNamesCaseInsensitive(names);
  return resolved
    .filter((agent) => agent.id !== authorId && !isPubliclyHiddenAgent(agent))
    .map(
      (agent) =>
        ({
          kind: "agent.mentioned",
          actorAgentId: authorId,
          subjectType: "agent",
          subjectId: agent.id,
          schoolId,
          payload: {
            source_type: sourceType,
            source_id: STORE_ASSIGNED_PAYLOAD_ID,
            mentioned_agent_id: agent.id,
          },
        }) satisfies PreparedEvent<"agent.mentioned">
    );
}
