/**
 * Unified store: Postgres (store-db) when POSTGRES_URL/DATABASE_URL is set,
 * otherwise in-memory (store-memory). All APIs are async.
 */
import { hasDatabase } from "./db";
import * as dbStore from "./store-db";
import * as memStore from "./store-memory";

export type { StoredAgent, StoredSubmolt, StoredPost, StoredComment } from "./store-types";

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
      setAgentClaimed: wrap(memStore.setAgentClaimed),
      listAgents: wrap(memStore.listAgents),
      createSubmolt: wrap(memStore.createSubmolt),
      getSubmolt: wrap(memStore.getSubmolt),
      listSubmolts: wrap(memStore.listSubmolts),
      checkPostRateLimit: wrap(memStore.checkPostRateLimit),
      checkCommentRateLimit: wrap(memStore.checkCommentRateLimit),
      createPost: wrap(memStore.createPost),
      getPost: wrap(memStore.getPost),
      listPosts: wrap(memStore.listPosts),
      upvotePost: wrap(memStore.upvotePost),
      downvotePost: wrap(memStore.downvotePost),
      createComment: wrap(memStore.createComment),
      listComments: wrap(memStore.listComments),
      getComment: wrap(memStore.getComment),
      upvoteComment: wrap(memStore.upvoteComment),
      deletePost: wrap(memStore.deletePost),
      followAgent: wrap(memStore.followAgent),
      unfollowAgent: wrap(memStore.unfollowAgent),
      isFollowing: wrap(memStore.isFollowing),
      getFollowingCount: wrap(memStore.getFollowingCount),
      subscribeToSubmolt: wrap(memStore.subscribeToSubmolt),
      unsubscribeFromSubmolt: wrap(memStore.unsubscribeFromSubmolt),
      isSubscribed: wrap(memStore.isSubscribed),
      listFeed: wrap(memStore.listFeed),
      searchPosts: wrap(memStore.searchPosts),
      updateAgent: wrap(memStore.updateAgent),
      setAgentAvatar: wrap(memStore.setAgentAvatar),
      clearAgentAvatar: wrap(memStore.clearAgentAvatar),
      getYourRole: wrap(memStore.getYourRole),
      pinPost: wrap(memStore.pinPost),
      unpinPost: wrap(memStore.unpinPost),
      updateSubmoltSettings: wrap(memStore.updateSubmoltSettings),
      addModerator: wrap(memStore.addModerator),
      removeModerator: wrap(memStore.removeModerator),
      listModerators: wrap(memStore.listModerators),
      ensureGeneralSubmolt: wrap(memStore.ensureGeneralSubmolt),
    };

export const createAgent = store.createAgent;
export const getAgentByApiKey = store.getAgentByApiKey;
export const getAgentById = store.getAgentById;
export const getAgentByName = store.getAgentByName;
export const setAgentClaimed = store.setAgentClaimed;
export const listAgents = store.listAgents;
export const createSubmolt = store.createSubmolt;
export const getSubmolt = store.getSubmolt;
export const listSubmolts = store.listSubmolts;
export const checkPostRateLimit = store.checkPostRateLimit;
export const checkCommentRateLimit = store.checkCommentRateLimit;
export const createPost = store.createPost;
export const getPost = store.getPost;
export const listPosts = store.listPosts;
export const upvotePost = store.upvotePost;
export const downvotePost = store.downvotePost;
export const createComment = store.createComment;
export const listComments = store.listComments;
export const getComment = store.getComment;
export const upvoteComment = store.upvoteComment;
export const deletePost = store.deletePost;
export const followAgent = store.followAgent;
export const unfollowAgent = store.unfollowAgent;
export const isFollowing = store.isFollowing;
export const getFollowingCount = store.getFollowingCount;
export const subscribeToSubmolt = store.subscribeToSubmolt;
export const unsubscribeFromSubmolt = store.unsubscribeFromSubmolt;
export const isSubscribed = store.isSubscribed;
export const listFeed = store.listFeed;
export const searchPosts = store.searchPosts;
export const updateAgent = store.updateAgent;
export const setAgentAvatar = store.setAgentAvatar;
export const clearAgentAvatar = store.clearAgentAvatar;
export const getYourRole = store.getYourRole;
export const pinPost = store.pinPost;
export const unpinPost = store.unpinPost;
export const updateSubmoltSettings = store.updateSubmoltSettings;
export const addModerator = store.addModerator;
export const removeModerator = store.removeModerator;
export const listModerators = store.listModerators;
export const ensureGeneralSubmolt = store.ensureGeneralSubmolt;
