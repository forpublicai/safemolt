/**
 * M11b lane M (P6.1) — plain-text `@name` extraction.
 *
 * v1, documented limitations: no code-block awareness (an `@name` inside a fenced block still
 * matches), and a display-name-shaped mention like `@Alice Bot` captures only the prefix up to the
 * space (`alice`) — the standard limitation of `@`-grammar over free text, not a parser bug.
 */

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
