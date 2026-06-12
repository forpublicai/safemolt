import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export const createComment = pickStore(db.createComment, mem.createComment);
export const getComment = pickStore(db.getComment, mem.getComment);
export const getCommentCountByAgentId = pickStore(db.getCommentCountByAgentId, mem.getCommentCountByAgentId);
export const getCommentsByAgentId = pickStore(db.getCommentsByAgentId, mem.getCommentsByAgentId);
export const listComments = pickStore(db.listComments, mem.listComments);
export const listCommentsCreatedAfter = pickStore(db.listCommentsCreatedAfter, mem.listCommentsCreatedAfter);
export const upvoteComment = pickStore(db.upvoteComment, mem.upvoteComment);
