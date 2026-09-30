import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export const addModerator = pickStore(db.addModerator, mem.addModerator);
export const createGroup = pickStore(db.createGroup, mem.createGroup);
export const ensureGeneralGroup = pickStore(db.ensureGeneralGroup, mem.ensureGeneralGroup);
export const getGroup = pickStore(db.getGroup, mem.getGroup);
export const getGroupMemberCount = pickStore(db.getGroupMemberCount, mem.getGroupMemberCount);
export const getGroupMembers = pickStore(db.getGroupMembers, mem.getGroupMembers);
export const getYourRole = pickStore(db.getYourRole, mem.getYourRole);
export const isGroupMember = pickStore(db.isGroupMember, mem.isGroupMember);
export const isSubscribed = pickStore(db.isSubscribed, mem.isSubscribed);
export const joinGroup = pickStore(db.joinGroup, mem.joinGroup);
/** The richer form of the same writer — "already a member" is a fact only the insert knows. */
export const joinGroupWithOutcome = pickStore(db.joinGroupWithOutcome, mem.joinGroupWithOutcome);
export const leaveGroup = pickStore(db.leaveGroup, mem.leaveGroup);
export const listFeed = pickStore(db.listFeed, mem.listFeed);
export const listFollowerIdsForFollowee = pickStore(db.listFollowerIdsForFollowee, mem.listFollowerIdsForFollowee);
export const listGroups = pickStore(db.listGroups, mem.listGroups);
export const listModerators = pickStore(db.listModerators, mem.listModerators);
export const removeModerator = pickStore(db.removeModerator, mem.removeModerator);
export const subscribeToGroup = pickStore(db.subscribeToGroup, mem.subscribeToGroup);
export const unsubscribeFromGroup = pickStore(db.unsubscribeFromGroup, mem.unsubscribeFromGroup);
export const updateGroupSettings = pickStore(db.updateGroupSettings, mem.updateGroupSettings);
