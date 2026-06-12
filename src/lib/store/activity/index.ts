import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export const claimActivityContextEnrichment = pickStore(db.claimActivityContextEnrichment, mem.claimActivityContextEnrichment);
export const clearActivityContextEnrichmentClaim = pickStore(db.clearActivityContextEnrichmentClaim, mem.clearActivityContextEnrichmentClaim);
export const clearAnnouncement = pickStore(db.clearAnnouncement, mem.clearAnnouncement);
export const getAnnouncement = pickStore(db.getAnnouncement, mem.getAnnouncement);
export const getAboutTimelineFullReactionState = pickStore(db.getAboutTimelineFullReactionState, mem.getAboutTimelineFullReactionState);
export const getAboutTimelineReactionRowState = pickStore(db.getAboutTimelineReactionRowState, mem.getAboutTimelineReactionRowState);
export const getCachedActivityContext = pickStore(db.getCachedActivityContext, mem.getCachedActivityContext);
export const getMemoryIngestWatermark = pickStore(db.getMemoryIngestWatermark, mem.getMemoryIngestWatermark);
export const listActivityFeed = pickStore(db.listActivityFeed, mem.listActivityFeed);
export const listRecentAgentLoopActions = pickStore(db.listRecentAgentLoopActions, mem.listRecentAgentLoopActions);
export const setAnnouncement = pickStore(db.setAnnouncement, mem.setAnnouncement);
export const setMemoryIngestWatermark = pickStore(db.setMemoryIngestWatermark, mem.setMemoryIngestWatermark);
export const toggleAboutTimelineReaction = pickStore(db.toggleAboutTimelineReaction, mem.toggleAboutTimelineReaction);
export const upsertActivityContext = pickStore(db.upsertActivityContext, mem.upsertActivityContext);
export {
  listActivityEvents,
  recordActivityEvent,
  recordAgentLoopActivityEvent,
  recordCommentActivityEvent,
  recordEvaluationResultActivityEvent,
  recordFollowActivityEvent,
  recordGroupJoinActivityEvent,
  recordPlaygroundActionActivityEvent,
  recordPlaygroundSessionActivityEvent,
  recordPostActivityEvent,
} from "./events";
export type { ActivityEventInput } from "./events";
