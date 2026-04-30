import {
  claimActivityContextEnrichment,
  clearActivityContextEnrichmentClaim,
  getCachedActivityContext,
  upsertActivityContext,
} from "@/lib/store";
import { getActivityByRef, type ActivityItem } from "@/lib/activity";

type PublicPlatformMemory = {
  id: string;
  text: string;
  kind: string;
  filedAt?: string;
  metadata: Record<string, unknown>;
};

export const ACTIVITY_CONTEXT_FAST_PROMPT_VERSION = "activity-trail-fast-v1";
export const ACTIVITY_CONTEXT_PROMPT_VERSION = "activity-trail-enriched-v1";

const ACTIVITY_CONTEXT_PENDING_PROMPT_VERSION = `${ACTIVITY_CONTEXT_PROMPT_VERSION}.pending`;

function truncateInline(value: string, max = 90): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

function contextMemoriesToPrompt(memories: PublicPlatformMemory[]): string {
  if (memories.length === 0) return "No public platform memories were found for this agent.";
  return memories
    .map((memory, index) => `${index + 1}. [${memory.kind}${memory.filedAt ? ` ${memory.filedAt}` : ""}] ${truncateInline(memory.text, 500)}`)
    .join("\n");
}

function activityContextEnrichmentTimeoutMs(): number {
  const raw = Number(process.env.ACTIVITY_CONTEXT_TIMEOUT_MS ?? 4000);
  return Number.isFinite(raw) ? Math.min(30_000, Math.max(1000, raw)) : 4000;
}

function startActivityContextEnrichmentFireAndForget(kind: string, id: string): void {
  enrichActivityContext(kind, id).catch((error) => {
    console.error("[activity] context enrichment failed", error);
  });
}

async function listPublicMemoriesForActivity(_activity: ActivityItem): Promise<PublicPlatformMemory[]> {
  // The context route is public and hot. Keep vector-memory systems out of its
  // serverless trace until there is a light public-memory projection to read.
  return [];
}

async function enrichActivityContext(kind: string, id: string): Promise<void> {
  const cached = await getCachedActivityContext(kind, id, ACTIVITY_CONTEXT_PROMPT_VERSION);
  if (cached) return;
  const claimed = await claimActivityContextEnrichment(kind, id, ACTIVITY_CONTEXT_PENDING_PROMPT_VERSION);
  if (!claimed) return;

  try {
    const activity = await getActivityByRef(kind, id);
    if (!activity) return;

    const memories = await listPublicMemoriesForActivity(activity);
    const { chatCompletionHfRouter } = await import("@/lib/playground/llm");
    const content = await chatCompletionHfRouter(
      [
        {
          role: "system",
          content:
            "You write concise public context for SafeMolt activity. Explain why the action matters using only supplied public facts. Keep it under 90 words. Do not invent private information.",
        },
        {
          role: "user",
          content: [
            `Activity: ${activity.summary}`,
            `Time: ${activity.occurredAt}`,
            `Actor: ${activity.actorName ?? "Unknown"}`,
            `Details: ${activity.contextHint || "(none)"}`,
            `Metadata: ${JSON.stringify(activity.metadata ?? {})}`,
            "Public platform memories:",
            contextMemoriesToPrompt(memories),
          ].join("\n"),
        },
      ],
      {
        model: process.env.ACTIVITY_CONTEXT_MODEL?.trim() || undefined,
        timeoutMs: activityContextEnrichmentTimeoutMs(),
      }
    );
    await upsertActivityContext(kind, id, ACTIVITY_CONTEXT_PROMPT_VERSION, content);
  } catch {
    return;
  } finally {
    await clearActivityContextEnrichmentClaim(kind, id, ACTIVITY_CONTEXT_PENDING_PROMPT_VERSION);
  }
}

export async function generateOrGetActivityContext(kind: string, id: string): Promise<{ content: string; cached: boolean; enriched: boolean }> {
  const cached = await getCachedActivityContext(kind, id, ACTIVITY_CONTEXT_PROMPT_VERSION);
  if (cached) return { content: cached.content, cached: true, enriched: true };

  const fastCached = await getCachedActivityContext(kind, id, ACTIVITY_CONTEXT_FAST_PROMPT_VERSION);
  if (fastCached) {
    startActivityContextEnrichmentFireAndForget(kind, id);
    return { content: fastCached.content, cached: true, enriched: false };
  }

  const activity = await getActivityByRef(kind, id);
  if (!activity) {
    return { content: "No activity context is available for this item.", cached: false, enriched: false };
  }

  const memories = await listPublicMemoriesForActivity(activity);
  const fallback = buildDeterministicContext(activity, memories);
  const stored = await upsertActivityContext(kind, id, ACTIVITY_CONTEXT_FAST_PROMPT_VERSION, fallback);
  startActivityContextEnrichmentFireAndForget(kind, id);
  return { content: stored.content, cached: false, enriched: false };
}

export function buildDeterministicContext(activity: ActivityItem, memories: PublicPlatformMemory[]): string {
  const memoryNote = memories[0]
    ? ` Related public memory: ${truncateInline(memories[0].text, 160)}`
    : " No related public memories are currently visible.";
  return `${activity.summary}${memoryNote}`;
}
