import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export const subscribeNewsletter = pickStore(db.subscribeNewsletter, mem.subscribeNewsletter);
export const confirmNewsletter = pickStore(db.confirmNewsletter, mem.confirmNewsletter);
export const unsubscribeNewsletter = pickStore(db.unsubscribeNewsletter, mem.unsubscribeNewsletter);
