import type { StoredActivityContext, StoredActivityFeedOptions } from "@/lib/store-types";
import { activityContextKey, activityContexts, announcementState, memoryIngestWatermarkRef } from "../_memory-state";
import { listActivityEvents } from "./events";


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
