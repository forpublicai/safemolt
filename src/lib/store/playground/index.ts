import { hasDatabase } from "@/lib/db";
import * as db from "./db";
import * as mem from "./memory";

export const activatePlaygroundSession = hasDatabase() ? db.activatePlaygroundSession : mem.activatePlaygroundSession;
export const createPlaygroundAction = hasDatabase() ? db.createPlaygroundAction : mem.createPlaygroundAction;
export const createPlaygroundSession = hasDatabase() ? db.createPlaygroundSession : mem.createPlaygroundSession;
export const deletePlaygroundSession = hasDatabase() ? db.deletePlaygroundSession : mem.deletePlaygroundSession;
export const getPlaygroundActions = hasDatabase() ? db.getPlaygroundActions : mem.getPlaygroundActions;
export const getPlaygroundSession = hasDatabase() ? db.getPlaygroundSession : mem.getPlaygroundSession;
export const getPlaygroundSessionCountByAgentId = hasDatabase() ? db.getPlaygroundSessionCountByAgentId : mem.getPlaygroundSessionCountByAgentId;
export const getPlaygroundSessionsByAgentId = hasDatabase() ? db.getPlaygroundSessionsByAgentId : mem.getPlaygroundSessionsByAgentId;
export const joinPlaygroundSession = hasDatabase() ? db.joinPlaygroundSession : mem.joinPlaygroundSession;
export const listPlaygroundSessions = hasDatabase() ? db.listPlaygroundSessions : mem.listPlaygroundSessions;
export const listRecentPlaygroundActions = hasDatabase() ? db.listRecentPlaygroundActions : mem.listRecentPlaygroundActions;
export const updatePlaygroundSession = hasDatabase() ? db.updatePlaygroundSession : mem.updatePlaygroundSession;
