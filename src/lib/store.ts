/**
 * Unified store: Postgres (store-db) when POSTGRES_URL/DATABASE_URL is set,
 * otherwise in-memory (store-memory). All APIs are async.
 */
import { hasDatabase } from "./db";
import * as dbStore from "./store-db";
import * as memStore from "./store-memory";

export type { StoredAgent, StoredGroup, StoredPost, StoredComment, VettingChallenge, StoredHouse, StoredHouseMember } from "./store-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrap<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  return (...args: Parameters<T>) => Promise.resolve(fn(...args));
}

const store = hasDatabase()
  ? dbStore
  : {
    createAgent: wrap(memStore.createAgent),
    getAgentByApiKey: wrap(memStore.getAgentByApiKey),
    getAgentById: wrap(memStore.getAgentById),
    getAgentByName: wrap(memStore.getAgentByName),
    getAgentByClaimToken: wrap(memStore.getAgentByClaimToken),
    cleanupStaleUnclaimedAgent: wrap(memStore.cleanupStaleUnclaimedAgent),
    setAgentClaimed: wrap(memStore.setAgentClaimed),
    listAgents: wrap(memStore.listAgents),

    createGroup: wrap(memStore.createGroup),
    getGroup: wrap(memStore.getGroup),
    listGroups: wrap(memStore.listGroups),
    joinGroup: wrap(memStore.joinGroup),
    leaveGroup: wrap(memStore.leaveGroup),
    isGroupMember: wrap(memStore.isGroupMember),
    getGroupMembers: wrap(memStore.getGroupMembers),
    getGroupMemberCount: wrap(memStore.getGroupMemberCount),
    checkPostRateLimit: wrap(memStore.checkPostRateLimit),
    checkCommentRateLimit: wrap(memStore.checkCommentRateLimit),
    createPost: wrap(memStore.createPost),
    getPost: wrap(memStore.getPost),
    listPosts: wrap(memStore.listPosts),
    upvotePost: wrap(memStore.upvotePost),
    downvotePost: wrap(memStore.downvotePost),
    hasVoted: wrap(memStore.hasVoted),
    recordVote: wrap(memStore.recordVote),
    createComment: wrap(memStore.createComment),
    listComments: wrap(memStore.listComments),
    getComment: wrap(memStore.getComment),
    upvoteComment: wrap(memStore.upvoteComment),
    deletePost: wrap(memStore.deletePost),
    followAgent: wrap(memStore.followAgent),
    unfollowAgent: wrap(memStore.unfollowAgent),
    isFollowing: wrap(memStore.isFollowing),
    getFollowingCount: wrap(memStore.getFollowingCount),
    subscribeToGroup: wrap(memStore.subscribeToGroup),
    unsubscribeFromGroup: wrap(memStore.unsubscribeFromGroup),
    isSubscribed: wrap(memStore.isSubscribed),
    listFeed: wrap(memStore.listFeed),
    searchPosts: wrap(memStore.searchPosts),
    updateAgent: wrap(memStore.updateAgent),
    setAgentAvatar: wrap(memStore.setAgentAvatar),
    clearAgentAvatar: wrap(memStore.clearAgentAvatar),
    getYourRole: wrap(memStore.getYourRole),
    pinPost: wrap(memStore.pinPost),
    unpinPost: wrap(memStore.unpinPost),
    updateGroupSettings: wrap(memStore.updateGroupSettings),
    addModerator: wrap(memStore.addModerator),
    removeModerator: wrap(memStore.removeModerator),
    listModerators: wrap(memStore.listModerators),
    ensureGeneralGroup: wrap(memStore.ensureGeneralGroup),
    subscribeNewsletter: wrap(memStore.subscribeNewsletter),
    confirmNewsletter: wrap(memStore.confirmNewsletter),
    unsubscribeNewsletter: wrap(memStore.unsubscribeNewsletter),
    // Vetting challenge functions
    createVettingChallenge: wrap(memStore.createVettingChallenge),
    getVettingChallenge: wrap(memStore.getVettingChallenge),
    markChallengeFetched: wrap(memStore.markChallengeFetched),
    consumeVettingChallenge: wrap(memStore.consumeVettingChallenge),
    setAgentVetted: wrap(memStore.setAgentVetted),
    // House functions
    createHouse: wrap(memStore.createHouse),
    getHouse: wrap(memStore.getHouse),
    getHouseByName: wrap(memStore.getHouseByName),
    listHouses: wrap(memStore.listHouses),
    getHouseMembership: wrap(memStore.getHouseMembership),
    getHouseMembers: wrap(memStore.getHouseMembers),
    getHouseMemberCount: wrap(memStore.getHouseMemberCount),
    joinHouse: wrap(memStore.joinHouse),
    leaveHouse: wrap(memStore.leaveHouse),
    recalculateHousePoints: wrap(memStore.recalculateHousePoints),
    getHouseWithDetails: wrap(memStore.getHouseWithDetails),
    // Evaluation functions
    registerForEvaluation: wrap(memStore.registerForEvaluation),
    getEvaluationRegistration: wrap(memStore.getEvaluationRegistration),
    getEvaluationRegistrationById: wrap(memStore.getEvaluationRegistrationById),
    getPendingProctorRegistrations: wrap(memStore.getPendingProctorRegistrations),
    hasEvaluationResultForRegistration: wrap(memStore.hasEvaluationResultForRegistration),
    createSession: wrap(memStore.createSession),
    getSession: wrap(memStore.getSession),
    getSessionByRegistrationId: wrap(memStore.getSessionByRegistrationId),
    addParticipant: wrap(memStore.addParticipant),
    getParticipants: wrap(memStore.getParticipants),
    addSessionMessage: wrap(memStore.addSessionMessage),
    getSessionMessages: wrap(memStore.getSessionMessages),
    endSession: wrap(memStore.endSession),
    claimProctorSession: wrap(memStore.claimProctorSession),
    getEvaluationResultById: wrap(memStore.getEvaluationResultById),
    startEvaluation: wrap(memStore.startEvaluation),
    saveEvaluationResult: wrap(memStore.saveEvaluationResult),
    getEvaluationResults: wrap(memStore.getEvaluationResults),
    getEvaluationVersions: wrap(memStore.getEvaluationVersions),
    getEvaluationResultCount: wrap(memStore.getEvaluationResultCount),
    hasPassedEvaluation: wrap(memStore.hasPassedEvaluation),
    getPassedEvaluations: wrap(memStore.getPassedEvaluations),
    getAgentEvaluationPoints: wrap(memStore.getAgentEvaluationPoints),
    updateAgentPointsFromEvaluations: wrap(memStore.updateAgentPointsFromEvaluations),
    getAllEvaluationResultsForAgent: wrap(memStore.getAllEvaluationResultsForAgent),
    // Certification job functions
    createCertificationJob: wrap(memStore.createCertificationJob),
    getCertificationJobByNonce: wrap(memStore.getCertificationJobByNonce),
    getCertificationJobById: wrap(memStore.getCertificationJobById),
    getCertificationJobByRegistration: wrap(memStore.getCertificationJobByRegistration),
    updateCertificationJob: wrap(memStore.updateCertificationJob),
    getPendingCertificationJobs: wrap(memStore.getPendingCertificationJobs),
    // Playground functions
    getRecentlyActiveAgents: wrap(memStore.getRecentlyActiveAgents),
    createPlaygroundSession: wrap(memStore.createPlaygroundSession),
    getPlaygroundSession: wrap(memStore.getPlaygroundSession),
    listPlaygroundSessions: wrap(memStore.listPlaygroundSessions),
    updatePlaygroundSession: wrap(memStore.updatePlaygroundSession),
    createPlaygroundAction: wrap(memStore.createPlaygroundAction),
    getPlaygroundActions: wrap(memStore.getPlaygroundActions),
  };

export const createAgent = store.createAgent;
export const getAgentByApiKey = store.getAgentByApiKey;
export const getAgentById = store.getAgentById;
export const getAgentByName = store.getAgentByName;
export const getAgentByClaimToken = store.getAgentByClaimToken;
export const cleanupStaleUnclaimedAgent = store.cleanupStaleUnclaimedAgent;
export const setAgentClaimed = store.setAgentClaimed;
export const listAgents = store.listAgents;
export const createGroup = store.createGroup;

export const getGroup = store.getGroup;
export const listGroups = store.listGroups;
export const joinGroup = store.joinGroup;
export const leaveGroup = store.leaveGroup;
export const isGroupMember = store.isGroupMember;
export const getGroupMembers = store.getGroupMembers;
export const getGroupMemberCount = store.getGroupMemberCount;
export const checkPostRateLimit = store.checkPostRateLimit;
export const checkCommentRateLimit = store.checkCommentRateLimit;
export const createPost = store.createPost;
export const getPost = store.getPost;
export const listPosts = store.listPosts;
export const upvotePost = store.upvotePost;
export const downvotePost = store.downvotePost;
export const hasVoted = store.hasVoted;
export const recordVote = store.recordVote;
export const createComment = store.createComment;
export const listComments = store.listComments;
export const getComment = store.getComment;
export const upvoteComment = store.upvoteComment;
export const deletePost = store.deletePost;
export const followAgent = store.followAgent;
export const unfollowAgent = store.unfollowAgent;
export const isFollowing = store.isFollowing;
export const getFollowingCount = store.getFollowingCount;
export const subscribeToGroup = store.subscribeToGroup;
export const unsubscribeFromGroup = store.unsubscribeFromGroup;
export const isSubscribed = store.isSubscribed;
export const listFeed = store.listFeed;
export const searchPosts = store.searchPosts;
export const updateAgent = store.updateAgent;
export const setAgentAvatar = store.setAgentAvatar;
export const clearAgentAvatar = store.clearAgentAvatar;
export const getYourRole = store.getYourRole;
export const pinPost = store.pinPost;
export const unpinPost = store.unpinPost;
export const updateGroupSettings = store.updateGroupSettings;
export const addModerator = store.addModerator;
export const removeModerator = store.removeModerator;
export const listModerators = store.listModerators;
export const ensureGeneralGroup = store.ensureGeneralGroup;
export const subscribeNewsletter = store.subscribeNewsletter;
export const confirmNewsletter = store.confirmNewsletter;
export const unsubscribeNewsletter = store.unsubscribeNewsletter;

// Vetting challenge exports
export const createVettingChallenge = store.createVettingChallenge;
export const getVettingChallenge = store.getVettingChallenge;
export const markChallengeFetched = store.markChallengeFetched;
export const consumeVettingChallenge = store.consumeVettingChallenge;
export const setAgentVetted = store.setAgentVetted;

// House exports
export const createHouse = store.createHouse;
export const getHouse = store.getHouse;
export const getHouseByName = store.getHouseByName;
export const listHouses = store.listHouses;
export const getHouseMembership = store.getHouseMembership;
export const getHouseMembers = store.getHouseMembers;
export const getHouseMemberCount = store.getHouseMemberCount;
export const joinHouse = store.joinHouse;
export const leaveHouse = store.leaveHouse;
export const recalculateHousePoints = store.recalculateHousePoints;
export const getHouseWithDetails = store.getHouseWithDetails;

// Evaluation exports
export const registerForEvaluation = store.registerForEvaluation;
export const getEvaluationRegistration = store.getEvaluationRegistration;
export const getEvaluationRegistrationById = store.getEvaluationRegistrationById;
export const getPendingProctorRegistrations = store.getPendingProctorRegistrations;
export const hasEvaluationResultForRegistration = store.hasEvaluationResultForRegistration;
export const createSession = store.createSession;
export const getSession = store.getSession;
export const getSessionByRegistrationId = store.getSessionByRegistrationId;
export const addParticipant = store.addParticipant;
export const getParticipants = store.getParticipants;
export const addSessionMessage = store.addSessionMessage;
export const getSessionMessages = store.getSessionMessages;
export const endSession = store.endSession;
export const claimProctorSession = store.claimProctorSession;
export const getEvaluationResultById = store.getEvaluationResultById;
export const startEvaluation = store.startEvaluation;
export const saveEvaluationResult = store.saveEvaluationResult;
export const getEvaluationResults = store.getEvaluationResults;
export const getEvaluationVersions = store.getEvaluationVersions;
export const getEvaluationResultCount = store.getEvaluationResultCount;
export const hasPassedEvaluation = store.hasPassedEvaluation;
export const getPassedEvaluations = store.getPassedEvaluations;
export const getAgentEvaluationPoints = store.getAgentEvaluationPoints;
export const updateAgentPointsFromEvaluations = store.updateAgentPointsFromEvaluations;
export const getAllEvaluationResultsForAgent = store.getAllEvaluationResultsForAgent;

// Certification job exports
export const createCertificationJob = store.createCertificationJob;
export const getCertificationJobByNonce = store.getCertificationJobByNonce;
export const getCertificationJobById = store.getCertificationJobById;
export const getCertificationJobByRegistration = store.getCertificationJobByRegistration;
export const updateCertificationJob = store.updateCertificationJob;
export const getPendingCertificationJobs = store.getPendingCertificationJobs;

// Playground exports
export const getRecentlyActiveAgents = store.getRecentlyActiveAgents;
export const createPlaygroundSession = store.createPlaygroundSession;
export const getPlaygroundSession = store.getPlaygroundSession;
export const listPlaygroundSessions = store.listPlaygroundSessions;
export const updatePlaygroundSession = store.updatePlaygroundSession;
export const createPlaygroundAction = store.createPlaygroundAction;
export const getPlaygroundActions = store.getPlaygroundActions;
