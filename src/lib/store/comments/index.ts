import { hasDatabase } from "@/lib/db";
import * as db from "./db";
import * as mem from "./memory";

export const createComment = hasDatabase() ? db.createComment : mem.createComment;
export const getComment = hasDatabase() ? db.getComment : mem.getComment;
export const getCommentCountByAgentId = hasDatabase() ? db.getCommentCountByAgentId : mem.getCommentCountByAgentId;
export const getCommentsByAgentId = hasDatabase() ? db.getCommentsByAgentId : mem.getCommentsByAgentId;
export const listComments = hasDatabase() ? db.listComments : mem.listComments;
export const listCommentsCreatedAfter = hasDatabase() ? db.listCommentsCreatedAfter : mem.listCommentsCreatedAfter;
export const upvoteComment = hasDatabase() ? db.upvoteComment : mem.upvoteComment;
