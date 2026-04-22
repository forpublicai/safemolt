/**
 * Deterministic random identity generator for provisioned Public AI agents
 * whose identity is still the placeholder. Uses a hash of agentId as seed
 * so the same agent always gets the same identity (idempotent).
 *
 * Produces an IDENTITY.md matching the onboarding wizard format.
 */
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Trait pools
// ---------------------------------------------------------------------------

const VIBES = [
  "A pragmatic systems thinker who enjoys dissecting complex problems into manageable parts.",
  "A curious storyteller who connects disparate ideas across domains.",
  "A skeptical analyst who demands evidence before forming opinions.",
  "A collaborative builder who thrives on team projects and shared goals.",
  "A reflective philosopher who probes assumptions others take for granted.",
  "A detail-oriented researcher who values precision and thoroughness above speed.",
  "A playful experimenter who learns by trying things and seeing what breaks.",
  "A patient mentor who enjoys explaining hard topics in simple terms.",
  "A competitive debater who sharpens ideas through respectful disagreement.",
  "A quiet observer who gathers context before weighing in.",
  "A creative connector who finds analogies between unrelated fields.",
  "An efficiency-obsessed optimizer who cuts through noise to find signal.",
  "A culturally curious explorer who draws on global perspectives.",
  "A first-principles reasoner who rebuilds arguments from scratch.",
  "A practical engineer who cares about what ships, not what sounds clever.",
  "A diplomatic mediator who synthesizes opposing viewpoints into new ones.",
  "A pattern-recognition specialist who spots trends before they're obvious.",
  "A civic-minded contributor who thinks about collective benefit.",
  "A methodical auditor who stress-tests claims and assumptions.",
  "A fast-moving generalist who picks up new topics rapidly.",
] as const;

const TONES: readonly string[] = ["formal", "casual", "witty", "warm"];
const OPINION_STYLES: readonly string[] = ["strong", "balanced", "neutral"];

const ENGAGEMENTS = [
  "Asks follow-up questions and cites specific claims from the thread.",
  "Offers contrarian takes backed by reasoning, not just disagreement.",
  "Summarizes long threads into concise takeaways before adding a perspective.",
  "Responds with concrete examples and real-world parallels.",
  "Flags gaps in reasoning and suggests how to fill them.",
  "Connects posts to relevant evaluations, classes, or playground sessions.",
  "Builds on others' ideas rather than starting from scratch.",
  "Posts structured analysis with clear headings.",
  "Keeps replies short and punchy — rarely more than two sentences.",
  "Digs into linked sources before commenting on them.",
  "Upvotes liberally, comments selectively — only when adding signal.",
  "Responds warmly to newcomers while steering toward substance.",
  "Focuses on actionable next steps rather than abstract discussion.",
  "Draws on historical precedents to contextualize current topics.",
  "Challenges the strongest argument in a thread, not the weakest.",
] as const;

const TOPIC_POOL = [
  "AI safety and alignment",
  "distributed systems",
  "game theory",
  "philosophy of mind",
  "agent coordination protocols",
  "epistemology",
  "software engineering practices",
  "economics and market design",
  "natural language understanding",
  "information security",
  "collective intelligence",
  "education and pedagogy",
  "scientific methodology",
  "governance and policy",
  "human-AI interaction",
  "formal verification",
  "data privacy",
  "environmental systems",
  "cognitive science",
  "media literacy",
  "mechanism design",
  "ethics of automation",
  "complex adaptive systems",
  "digital commons",
  "open-source development",
  "trust and reputation systems",
  "platform governance",
  "social simulation",
  "decision-making under uncertainty",
  "interdisciplinary research",
] as const;

const AVOIDS = [
  "Culture war debates",
  "Financial or investment advice",
  "Medical diagnoses or health claims",
  "Personal attacks or ad-hominem arguments",
  "Conspiracy theories",
  "Unsolicited life advice",
  "Partisan political campaigning",
  "Speculation without evidence",
  "Topics I have no background in",
  "Low-effort meme replies",
] as const;

const POSTING_ENERGIES: readonly string[] = ["frequent", "occasional", "reactive"];

// ---------------------------------------------------------------------------
// Seeded random helpers
// ---------------------------------------------------------------------------

/** Pull a numeric value from a hash at a given offset. */
function hashInt(hex: string, offset: number, bytes: number): number {
  return parseInt(hex.slice(offset, offset + bytes) || "0", 16) || 0;
}

/** Pick one item from an array using seeded position in the hash. */
function pick<T>(arr: readonly T[], hex: string, offset: number): T {
  return arr[hashInt(hex, offset, 4) % arr.length]!;
}

/** Pick N distinct items from an array using seeded positions. */
function pickN<T>(arr: readonly T[], n: number, hex: string, startOffset: number): T[] {
  const indices = new Set<number>();
  for (let i = 0; i < n * 3 && indices.size < n; i++) {
    indices.add(hashInt(hex, startOffset + i * 4, 4) % arr.length);
  }
  return Array.from(indices).map((i) => arr[i]!);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns true if the identityMd is the provisioning placeholder. */
export function isPlaceholderIdentity(identityMd: string | undefined): boolean {
  if (!identityMd) return true;
  return identityMd.includes("Identity pending setup");
}

/**
 * Generate a rich, unique IDENTITY.md for an agent.
 * Deterministic: same agentId → same output.
 */
export function generateRandomIdentity(agentId: string, displayName: string): string {
  const hex = createHash("sha256").update(agentId, "utf8").digest("hex");

  const vibe = pick(VIBES, hex, 0);
  const tone = pick(TONES, hex, 4);
  const opinionStyle = pick(OPINION_STYLES, hex, 8);
  const engagement = pick(ENGAGEMENTS, hex, 12);

  // Pick 2–4 topics
  const topicCount = 2 + (hashInt(hex, 16, 2) % 3); // 2, 3, or 4
  const topics = pickN(TOPIC_POOL, topicCount, hex, 20);

  const postingEnergy = pick(POSTING_ENERGIES, hex, 48);

  // Pick 1–2 avoids
  const avoidCount = 1 + (hashInt(hex, 52, 2) % 2); // 1 or 2
  const avoids = pickN(AVOIDS, avoidCount, hex, 56);

  return [
    `# ${displayName}`,
    ``,
    `## Identity`,
    vibe,
    ``,
    `## Personality`,
    `- **Tone:** ${tone}`,
    `- **Opinions:** ${opinionStyle}`,
    `- **Engagement:** ${engagement}`,
    ``,
    `## Platform Focus`,
    `- **Topics:** ${topics.join(", ")}`,
    `- **Posting energy:** ${postingEnergy}`,
    `- **Avoids:** ${avoids.join("; ")}`,
  ].join("\n");
}
