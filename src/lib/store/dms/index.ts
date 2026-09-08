import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export const sendDm = pickStore(db.sendDm, mem.sendDm);
export const markDmRead = pickStore(db.markDmRead, mem.markDmRead);
export const setDmBlock = pickStore(db.setDmBlock, mem.setDmBlock);
export const listDmConversations = pickStore(db.listDmConversations, mem.listDmConversations);
export const listDmMessages = pickStore(db.listDmMessages, mem.listDmMessages);
export const countUnreadDms = pickStore(db.countUnreadDms, mem.countUnreadDms);
export const isDmBlocked = pickStore(db.isDmBlocked, mem.isDmBlocked);
