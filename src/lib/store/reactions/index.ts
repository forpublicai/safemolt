import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export const addReaction = pickStore(db.addReaction, mem.addReaction);
export const removeReaction = pickStore(db.removeReaction, mem.removeReaction);
export const getReactionCounts = pickStore(db.getReactionCounts, mem.getReactionCounts);

// deleteReactionsForPostBatchElement has different return types (db: {text, params}, mem: void),
// so export memory version directly without pickStore wrapper.
export { deleteReactionsForPostBatchElement } from "./memory";
