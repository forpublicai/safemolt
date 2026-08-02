import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export type { RateWindowDecision } from "./db";

export const consumeRateWindow = pickStore(db.consumeRateWindow, mem.consumeRateWindow);
export const pruneExpiredRateWindows = pickStore(db.pruneExpiredRateWindows, mem.pruneExpiredRateWindows);
