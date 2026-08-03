import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";
import * as memoriesDb from "./agent-memories-db";
import * as memoriesMem from "./agent-memories-memory";

// M11-1b D5: durable playground episodic memories (they lived in a process-local Map even in DB
// mode, so they vanished across instances and cold starts).
// There is deliberately no lease-fenced single-memory writer here: the round's memories are
// written by `applyPlaygroundResolution`, inside the terminal CAS (D5 atomic follow-up).
export const storePlaygroundMemory = pickStore(memoriesDb.storePlaygroundMemory, memoriesMem.storePlaygroundMemory);
export const getPlaygroundMemoryForAgent = pickStore(memoriesDb.getPlaygroundMemoryForAgent, memoriesMem.getPlaygroundMemoryForAgent);
export const listPlaygroundMemoriesForSession = pickStore(memoriesDb.listPlaygroundMemoriesForSession, memoriesMem.listPlaygroundMemoriesForSession);
export const clearPlaygroundMemoriesForSession = pickStore(memoriesDb.clearPlaygroundMemoriesForSession, memoriesMem.clearPlaygroundMemoriesForSession);
export const clearPlaygroundMemoriesForAgent = pickStore(memoriesDb.clearPlaygroundMemoriesForAgent, memoriesMem.clearPlaygroundMemoriesForAgent);

export const activatePlaygroundSession = pickStore(db.activatePlaygroundSession, mem.activatePlaygroundSession);
export const applyPlaygroundResolution = pickStore(db.applyPlaygroundResolution, mem.applyPlaygroundResolution);
export const cancelPlaygroundSession = pickStore(db.cancelPlaygroundSession, mem.cancelPlaygroundSession);
export const claimPlaygroundResolution = pickStore(db.claimPlaygroundResolution, mem.claimPlaygroundResolution);
export const expireStalePendingSessions = pickStore(db.expireStalePendingSessions, mem.expireStalePendingSessions);
export const createPlaygroundAction = pickStore(db.createPlaygroundAction, mem.createPlaygroundAction);
export const renewPlaygroundResolutionClaim = pickStore(db.renewPlaygroundResolutionClaim, mem.renewPlaygroundResolutionClaim);
export const submitPlaygroundActionGated = pickStore(db.submitPlaygroundActionGated, mem.submitPlaygroundActionGated);
export const createPlaygroundSession = pickStore(db.createPlaygroundSession, mem.createPlaygroundSession);
export const deletePlaygroundSession = pickStore(db.deletePlaygroundSession, mem.deletePlaygroundSession);
export const getPlaygroundActions = pickStore(db.getPlaygroundActions, mem.getPlaygroundActions);
export const getPlaygroundSession = pickStore(db.getPlaygroundSession, mem.getPlaygroundSession);
export const getPlaygroundSessionCountByAgentId = pickStore(db.getPlaygroundSessionCountByAgentId, mem.getPlaygroundSessionCountByAgentId);
export const getPlaygroundSessionsByAgentId = pickStore(db.getPlaygroundSessionsByAgentId, mem.getPlaygroundSessionsByAgentId);
export const joinPlaygroundSession = pickStore(db.joinPlaygroundSession, mem.joinPlaygroundSession);
export const listPlaygroundSessions = pickStore(db.listPlaygroundSessions, mem.listPlaygroundSessions);
export const listRecentPlaygroundActions = pickStore(db.listRecentPlaygroundActions, mem.listRecentPlaygroundActions);
export const mergePlaygroundParticipantAffiliationFields = pickStore(db.mergePlaygroundParticipantAffiliationFields, mem.mergePlaygroundParticipantAffiliationFields);
export const updatePlaygroundSession = pickStore(db.updatePlaygroundSession, mem.updatePlaygroundSession);
