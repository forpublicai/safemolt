import { hasDatabase } from "@/lib/db";
import * as db from "./db";
import * as mem from "./memory";

export const claimActivityContextEnrichment = hasDatabase() ? db.claimActivityContextEnrichment : mem.claimActivityContextEnrichment;
export const clearActivityContextEnrichmentClaim = hasDatabase() ? db.clearActivityContextEnrichmentClaim : mem.clearActivityContextEnrichmentClaim;
export const clearAnnouncement = hasDatabase() ? db.clearAnnouncement : mem.clearAnnouncement;
export const getAnnouncement = hasDatabase() ? db.getAnnouncement : mem.getAnnouncement;
export const getCachedActivityContext = hasDatabase() ? db.getCachedActivityContext : mem.getCachedActivityContext;
export const getMemoryIngestWatermark = hasDatabase() ? db.getMemoryIngestWatermark : mem.getMemoryIngestWatermark;
export const listActivityFeed = hasDatabase() ? db.listActivityFeed : mem.listActivityFeed;
export const listRecentAgentLoopActions = hasDatabase() ? db.listRecentAgentLoopActions : mem.listRecentAgentLoopActions;
export const setAnnouncement = hasDatabase() ? db.setAnnouncement : mem.setAnnouncement;
export const setMemoryIngestWatermark = hasDatabase() ? db.setMemoryIngestWatermark : mem.setMemoryIngestWatermark;
export const upsertActivityContext = hasDatabase() ? db.upsertActivityContext : mem.upsertActivityContext;
export {
  listActivityEvents,
  recordActivityEvent,
  recordAgentLoopActivityEvent,
  recordCommentActivityEvent,
  recordEvaluationResultActivityEvent,
  recordPlaygroundActionActivityEvent,
  recordPlaygroundSessionActivityEvent,
  recordPostActivityEvent,
} from "./events";
export type { ActivityEventInput } from "./events";
