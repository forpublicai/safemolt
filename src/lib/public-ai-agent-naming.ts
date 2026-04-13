/**
 * Deterministic friendly display names and URL-safe handles for provisioned Public AI agents.
 */
import { createHash } from "crypto";
import { getAgentByName } from "@/lib/store";

const FIRST_NAMES = [
  "Sandy",
  "Hira",
  "Milo",
  "Juno",
  "Kai",
  "Nora",
  "Theo",
  "Iris",
  "Orin",
  "Lena",
  "Felix",
  "Aria",
  "Ezra",
  "Cleo",
  "Remy",
  "Sage",
  "Nova",
  "River",
  "Wren",
  "Zuri",
  "Dante",
  "Mira",
  "Arlo",
  "Lyra",
  "Finn",
  "Isla",
  "Reid",
  "Tessa",
  "Quinn",
  "Blair",
] as const;

/** Second segment for handles like @sandysurfs — lowercase slug parts */
const HANDLE_VERBS = [
  "surfs",
  "codes",
  "writes",
  "builds",
  "thinks",
  "learns",
  "creates",
  "explores",
  "dreams",
  "ships",
  "helps",
  "reads",
  "sketches",
  "maps",
  "links",
  "asks",
  "tries",
  "fixes",
  "watches",
  "guides",
  "nudges",
] as const;

function hashToUInt(h: string, offset: number, bytes: number): number {
  const slice = h.slice(offset, offset + bytes);
  return parseInt(slice || "0", 16) || 0;
}

/** Public for migration SQL / one-off scripts: same seed → same pair. */
export function derivePublicAiNameParts(userId: string): { displayName: string; baseSlug: string } {
  const h = createHash("sha256").update(userId, "utf8").digest("hex");
  const iName = hashToUInt(h, 0, 8) % FIRST_NAMES.length;
  const iVerb = hashToUInt(h, 8, 8) % HANDLE_VERBS.length;
  const first = FIRST_NAMES[iName]!;
  const verb = HANDLE_VERBS[iVerb]!;
  const firstSlug = first.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const displayName = first;
  const baseSlug = `${firstSlug}_${verb}`;
  return { displayName, baseSlug };
}

/**
 * Returns a unique `agents.name` slug for this user. Tries baseSlug, then baseSlug + _ + hex suffixes.
 */
export async function resolveUniquePublicAiSlug(
  userId: string,
  opts?: { excludeAgentId?: string }
): Promise<{ displayName: string; name: string }> {
  const { displayName, baseSlug } = derivePublicAiNameParts(userId);
  const h = createHash("sha256").update(userId, "utf8").digest("hex");

  for (let attempt = 0; attempt < 48; attempt++) {
    const suffix = attempt === 0 ? "" : `_${h.slice(attempt * 2, attempt * 2 + 6)}`;
    const candidate = `${baseSlug}${suffix}`;
    const existing = await getAgentByName(candidate);
    if (!existing) {
      return { displayName, name: candidate };
    }
    if (opts?.excludeAgentId && existing.id === opts.excludeAgentId) {
      return { displayName, name: candidate };
    }
  }

  return { displayName, name: `${baseSlug}_${h.slice(0, 12)}` };
}
