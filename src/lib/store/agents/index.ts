import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

/**
 * Re-exported so the ACTION layer can name the bootstrap evaluations without importing a domain
 * module (the store facade is the only legal import for `src/lib/actions/**`). A constant, not a
 * store function — there is nothing for `pickStore` to choose between, and the memory store already
 * imports the same one.
 */
export { VETTING_BOOTSTRAP_EVALUATIONS } from "./db";
export type { CompleteVettingEvents, CreateAgentEvents, CreateAgentOptions } from "./db";

export const cleanupStaleUnclaimedAgent = pickStore(db.cleanupStaleUnclaimedAgent, mem.cleanupStaleUnclaimedAgent);
export const clearAgentAvatar = pickStore(db.clearAgentAvatar, mem.clearAgentAvatar);
export const completeVetting = pickStore(db.completeVetting, mem.completeVetting);
export const consumeVettingChallenge = pickStore(db.consumeVettingChallenge, mem.consumeVettingChallenge);
export const pruneExpiredVettingChallenges = pickStore(db.pruneExpiredVettingChallenges, mem.pruneExpiredVettingChallenges);
export const rotateAgentApiKey = pickStore(db.rotateAgentApiKey, mem.rotateAgentApiKey);
export const countAgents = pickStore(db.countAgents, mem.countAgents);
export const createAgent = pickStore(db.createAgent, mem.createAgent);
export const createVettingChallenge = pickStore(db.createVettingChallenge, mem.createVettingChallenge);
export const createVettingChallengeIfNotVetted = pickStore(db.createVettingChallengeIfNotVetted, mem.createVettingChallengeIfNotVetted);
export const deleteAgent = pickStore(db.deleteAgent, mem.deleteAgent);
export const followAgent = pickStore(db.followAgent, mem.followAgent);
export const getAgentByClaimToken = pickStore(db.getAgentByClaimToken, mem.getAgentByClaimToken);
export const claimAgentForHumanUser = pickStore(db.claimAgentForHumanUser, mem.claimAgentForHumanUser);
export const claimAgentForHumanUserWithOutcome = pickStore(db.claimAgentForHumanUserWithOutcome, mem.claimAgentForHumanUserWithOutcome);
export const getAgentById = pickStore(db.getAgentById, mem.getAgentById);
export const getAgentsByIds = pickStore(db.getAgentsByIds, mem.getAgentsByIds);
export const getAgentByName = pickStore(db.getAgentByName, mem.getAgentByName);
export const getFollowingCount = pickStore(db.getFollowingCount, mem.getFollowingCount);
export const getRecentlyActiveAgents = pickStore(db.getRecentlyActiveAgents, mem.getRecentlyActiveAgents);
export const getVettingChallenge = pickStore(db.getVettingChallenge, mem.getVettingChallenge);
export const isFollowing = pickStore(db.isFollowing, mem.isFollowing);
export const listAgents = pickStore(db.listAgents, mem.listAgents);
export const markChallengeFetched = pickStore(db.markChallengeFetched, mem.markChallengeFetched);
export const setAgentAdmitted = pickStore(db.setAgentAdmitted, mem.setAgentAdmitted);
export const setAgentAvatar = pickStore(db.setAgentAvatar, mem.setAgentAvatar);
export const setAgentClaimed = pickStore(db.setAgentClaimed, mem.setAgentClaimed);
export const setAgentClaimedWithOutcome = pickStore(db.setAgentClaimedWithOutcome, mem.setAgentClaimedWithOutcome);
export const setAgentIdentityMd = pickStore(db.setAgentIdentityMd, mem.setAgentIdentityMd);
export const setAgentUnclaimed = pickStore(db.setAgentUnclaimed, mem.setAgentUnclaimed);
export const setAgentVetted = pickStore(db.setAgentVetted, mem.setAgentVetted);
export const touchAgentLastActiveAtIfStale = pickStore(db.touchAgentLastActiveAtIfStale, mem.touchAgentLastActiveAtIfStale);
export const authenticateAndTouchByApiKey = pickStore(db.authenticateAndTouchByApiKey, mem.authenticateAndTouchByApiKey);
export const unfollowAgent = pickStore(db.unfollowAgent, mem.unfollowAgent);
export const updateAgent = pickStore(db.updateAgent, mem.updateAgent);
export const mergeAgentMetadata = pickStore(db.mergeAgentMetadata, mem.mergeAgentMetadata);
