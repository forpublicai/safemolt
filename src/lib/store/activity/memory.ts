import type { StoredActivityContext, StoredActivityFeedOptions } from "@/lib/store-types";
import { activityContextKey, activityContexts, announcementState, memoryIngestWatermarkRef } from "../_memory-state";
import { listActivityEvents } from "./events";
import { randomUUID } from "crypto";
import {
  ABOUT_TIMELINE_ROW_KEYS,
  isValidAboutTimelineRowKey,
  validateReactionEmoji,
  type AboutTimelineFullReactionState,
  type AboutTimelineReactionRowState,
} from "@/lib/about-timeline-reactions";

const aboutTimelineGlobal = globalThis as typeof globalThis & {
  __safemolt_aboutTlReactions?: Array<{
    id: string;
    rowKey: string;
    actorKind: "agent" | "human";
    actorId: string;
    emoji: string;
  }>;
};
const aboutTimelineReactions = aboutTimelineGlobal.__safemolt_aboutTlReactions ??= [];


export async function listRecentAgentLoopActions(_limit = 25) {
  return [];
}

export async function listActivityFeed(options: StoredActivityFeedOptions = {}) {
  return listActivityEvents(options);
}

export async function getCachedActivityContext(
  activityKind: string,
  activityId: string,
  promptVersion: string) {
  return activityContexts.get(activityContextKey(activityKind, activityId, promptVersion)) ?? null;
}

export async function upsertActivityContext(
  activityKind: string,
  activityId: string,
  promptVersion: string,
  content: string) {
  const key = activityContextKey(activityKind, activityId, promptVersion);
  const existing = activityContexts.get(key);
  const now = new Date().toISOString();
  const row: StoredActivityContext = {
    activityKind,
    activityId,
    promptVersion,
    content,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  activityContexts.set(key, row);
  return row;
}

export async function claimActivityContextEnrichment(
  activityKind: string,
  activityId: string,
  promptVersion: string) {
  const key = activityContextKey(activityKind, activityId, promptVersion);
  if (activityContexts.has(key)) return false;
  const now = new Date().toISOString();
  // Empty rows are lock sentinels; callers must always read contexts by prompt_version.
  activityContexts.set(key, {
    activityKind,
    activityId,
    promptVersion,
    content: "",
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

export async function clearActivityContextEnrichmentClaim(
  activityKind: string,
  activityId: string,
  promptVersion: string) {
  activityContexts.delete(activityContextKey(activityKind, activityId, promptVersion));
}

export async function getMemoryIngestWatermark(){
  return memoryIngestWatermarkRef().v;
}

export async function setMemoryIngestWatermark(iso: string) {
  memoryIngestWatermarkRef().v = iso;
}

export async function setAnnouncement(content: string) {
  announcementState.current = {
    id: 'current',
    content,
    createdAt: new Date().toISOString(),
  };
  return announcementState.current;
}

export async function getAnnouncement(){
  return announcementState.current;
}

export async function clearAnnouncement(){
  announcementState.current = null;
  return true;
}

export async function getAboutTimelineFullReactionState(
  viewer: { kind: "agent" | "human"; id: string } | null
): Promise<AboutTimelineFullReactionState> {
  const rows: AboutTimelineFullReactionState["rows"] = {};
  for (const k of ABOUT_TIMELINE_ROW_KEYS) {
    rows[k] = { counts: [], mine: [] };
  }

  const countMap = new Map<string, Map<string, number>>();
  for (const k of ABOUT_TIMELINE_ROW_KEYS) {
    countMap.set(k, new Map());
  }
  for (const r of aboutTimelineReactions) {
    const m = countMap.get(r.rowKey);
    if (!m) continue;
    m.set(r.emoji, (m.get(r.emoji) ?? 0) + 1);
  }
  for (const k of ABOUT_TIMELINE_ROW_KEYS) {
    const m = countMap.get(k)!;
    rows[k].counts = Array.from(m.entries())
      .map(([emoji, count]) => ({ emoji, count }))
      .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  }

  if (viewer) {
    for (const r of aboutTimelineReactions) {
      if (r.actorKind === viewer.kind && r.actorId === viewer.id) {
        rows[r.rowKey]?.mine.push(r.emoji);
      }
    }
    for (const k of ABOUT_TIMELINE_ROW_KEYS) {
      rows[k].mine.sort();
    }
  }

  return { rows };
}

export async function getAboutTimelineReactionRowState(
  rowKey: string,
  viewer: { kind: "agent" | "human"; id: string } | null
): Promise<AboutTimelineReactionRowState> {
  const base: AboutTimelineReactionRowState = { counts: [], mine: [] };
  if (!isValidAboutTimelineRowKey(rowKey)) return base;

  const m = new Map<string, number>();
  const mine: string[] = [];
  for (const r of aboutTimelineReactions) {
    if (r.rowKey !== rowKey) continue;
    m.set(r.emoji, (m.get(r.emoji) ?? 0) + 1);
    if (viewer && r.actorKind === viewer.kind && r.actorId === viewer.id) {
      mine.push(r.emoji);
    }
  }

  return {
    counts: Array.from(m.entries())
      .map(([emoji, count]) => ({ emoji, count }))
      .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji)),
    mine: mine.sort(),
  };
}

export async function toggleAboutTimelineReaction(
  rowKey: string,
  emoji: string,
  viewer: { kind: "agent" | "human"; id: string }
): Promise<"added" | "removed"> {
  if (!isValidAboutTimelineRowKey(rowKey)) throw new Error("invalid row_key");
  const em = validateReactionEmoji(emoji);
  if (!em) throw new Error("invalid emoji");

  const idx = aboutTimelineReactions.findIndex(
    (r) =>
      r.rowKey === rowKey &&
      r.actorKind === viewer.kind &&
      r.actorId === viewer.id &&
      r.emoji === em
  );
  if (idx !== -1) {
    aboutTimelineReactions.splice(idx, 1);
    return "removed";
  }
  aboutTimelineReactions.push({
    id: randomUUID(),
    rowKey,
    actorKind: viewer.kind,
    actorId: viewer.id,
    emoji: em,
  });
  return "added";
}
