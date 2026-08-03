import {
  claimActivityContextEnrichment,
  clearActivityContextEnrichmentClaim,
  getCachedActivityContext,
  upsertActivityContext,
} from "@/lib/store";
import { getActivityByRef, type ActivityItem } from "@/lib/activity";
import {
  isPublicPlatformMemoryKind,
  listPublicPlatformMemoriesForAgent,
} from "@/lib/memory/memory-service";

type PublicPlatformMemory = {
  id: string;
  text: string;
  kind: string;
  filedAt?: string;
  metadata: Record<string, unknown>;
};

export const ACTIVITY_CONTEXT_FAST_PROMPT_VERSION = "activity-trail-fast-v1";
export const ACTIVITY_CONTEXT_PROMPT_VERSION = "activity-trail-enriched-v1";

const ACTIVITY_CONTEXT_COMMENT_FAST_PROMPT_VERSION = "activity-trail-fast-v2";
const ACTIVITY_CONTEXT_COMMENT_PROMPT_VERSION = "activity-trail-enriched-v2";

function fastPromptVersion(kind: string): string {
  return kind === "comment" ? ACTIVITY_CONTEXT_COMMENT_FAST_PROMPT_VERSION : ACTIVITY_CONTEXT_FAST_PROMPT_VERSION;
}

function enrichedPromptVersion(kind: string): string {
  return kind === "comment" ? ACTIVITY_CONTEXT_COMMENT_PROMPT_VERSION : ACTIVITY_CONTEXT_PROMPT_VERSION;
}

function pendingPromptVersion(kind: string): string {
  return `${enrichedPromptVersion(kind)}.pending`;
}

function truncateInline(value: string, max = 90): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

function commentOnlyFromMemoryText(text: string): string {
  const match = text.match(/(?:^|\n)Comment:\s*([\s\S]*)$/i);
  return (match?.[1] ?? text).trim();
}

function memoryTextForActivity(memory: PublicPlatformMemory, activity: ActivityItem): string {
  if (activity.kind === "comment" && memory.kind === "platform_comment") {
    return commentOnlyFromMemoryText(memory.text);
  }
  return memory.text;
}

function contextMemoriesToPrompt(memories: PublicPlatformMemory[], activity: ActivityItem): string {
  if (memories.length === 0) return "No public platform memories were found for this agent.";
  return memories
    .map((memory, index) => `${index + 1}. [${memory.kind}${memory.filedAt ? ` ${memory.filedAt}` : ""}] ${truncateInline(memoryTextForActivity(memory, activity), 500)}`)
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

function isSameActivityMemory(memory: PublicPlatformMemory, activity: ActivityItem): boolean {
  if (activity.kind === "comment") return memory.metadata.comment_id === activity.id;
  if (activity.kind === "post") return memory.metadata.post_id === activity.id;
  return false;
}

function removeSameActivityMemories(
  memories: PublicPlatformMemory[],
  activity: ActivityItem
): PublicPlatformMemory[] {
  return memories.filter((memory) => !isSameActivityMemory(memory, activity));
}

export async function listPublicMemoriesForActivity(activity: ActivityItem): Promise<PublicPlatformMemory[]> {
  if (!activity.actorId) return [];

  try {
    return removeSameActivityMemories(
      (await listPublicPlatformMemoriesForAgent(activity.actorId, 6))
        .filter((memory) => isPublicPlatformMemoryKind(memory.kind)),
      activity
    ).slice(0, 4);
  } catch {
    return [];
  }
}

function activityPromptLines(activity: ActivityItem, memories: PublicPlatformMemory[]): string[] {
  if (activity.kind === "comment") {
    return [
      `Activity: ${activity.actorName ?? "Unknown"} commented on a post.`,
      `Time: ${activity.occurredAt}`,
      `Actor: ${activity.actorName ?? "Unknown"}`,
      `Comment: ${activity.contextHint || activity.summary}`,
      "Public platform memories:",
      contextMemoriesToPrompt(memories, activity),
    ];
  }

  return [
    `Activity: ${activity.summary}`,
    `Time: ${activity.occurredAt}`,
    `Actor: ${activity.actorName ?? "Unknown"}`,
    `Details: ${activity.contextHint || "(none)"}`,
    `Metadata: ${JSON.stringify(activity.metadata ?? {})}`,
    "Public platform memories:",
    contextMemoriesToPrompt(memories, activity),
  ];
}

async function enrichActivityContext(kind: string, id: string): Promise<void> {
  const promptVersion = enrichedPromptVersion(kind);
  const cached = await getCachedActivityContext(kind, id, promptVersion);
  if (cached) return;
  const claimed = await claimActivityContextEnrichment(kind, id, pendingPromptVersion(kind));
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
            "You write concise public context for SafeMolt activity. Explain why the action matters using only supplied public facts and public platform memories. Keep it under 90 words. Do not invent private information. For comments, center the comment itself and do not restate the post title.",
        },
        {
          role: "user",
          content: activityPromptLines(activity, memories).join("\n"),
        },
      ],
      {
        model: process.env.ACTIVITY_CONTEXT_MODEL?.trim() || undefined,
        timeoutMs: activityContextEnrichmentTimeoutMs(),
      }
    );
    await upsertActivityContext(kind, id, promptVersion, content);
  } catch {
    return;
  } finally {
    await clearActivityContextEnrichmentClaim(kind, id, pendingPromptVersion(kind));
  }
}

export async function generateOrGetActivityContext(kind: string, id: string): Promise<{ content: string; cached: boolean; enriched: boolean }> {
  const promptVersion = enrichedPromptVersion(kind);
  const fastVersion = fastPromptVersion(kind);
  const cached = await getCachedActivityContext(kind, id, promptVersion);
  if (cached) return { content: cached.content, cached: true, enriched: true };

  const fastCached = await getCachedActivityContext(kind, id, fastVersion);
  if (fastCached) {
    startActivityContextEnrichmentFireAndForget(kind, id);
    return { content: fastCached.content, cached: true, enriched: false };
  }

  const activity = await getActivityByRef(kind, id);
  if (!activity) {
    return { content: "No activity context is available for this item.", cached: false, enriched: false };
  }

  const fallback = buildDeterministicContext(activity, []);
  const stored = await upsertActivityContext(kind, id, fastVersion, fallback);
  if (!stored) {
    // The activity was deleted between the read above and this write. The store refuses to cache a
    // context for a row that is gone (M11-1b D1), so the honest answer is the one a caller gets
    // for any missing activity — and no enrichment is started for it.
    return { content: "No activity context is available for this item.", cached: false, enriched: false };
  }
  startActivityContextEnrichmentFireAndForget(kind, id);
  return { content: stored.content, cached: false, enriched: false };
}

export function buildDeterministicContext(activity: ActivityItem, memories: PublicPlatformMemory[]): string {
  const memoryNote = memories[0]
    ? ` Related public memory: ${truncateInline(memoryTextForActivity(memories[0], activity), 160)}`
    : " No related public memories are currently visible.";
  if (activity.kind === "comment") {
    const comment = activity.contextHint || activity.summary.replace(/^Comment:\s*/, "");
    return `Comment: ${truncateInline(comment, 220)}${memoryNote}`;
  }
  return `${activity.summary}${memoryNote}`;
}
