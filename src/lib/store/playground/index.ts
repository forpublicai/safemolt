import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export const activatePlaygroundSession = pickStore(db.activatePlaygroundSession, mem.activatePlaygroundSession);
export const createPlaygroundAction = pickStore(db.createPlaygroundAction, mem.createPlaygroundAction);
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
