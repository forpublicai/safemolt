import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export type {
  RecordStreamFrameInput,
  StoredWakeupWithSeq,
  StreamFrame,
  TailStreamFramesOptions,
} from "./db";

export const recordStreamFrame = pickStore(db.recordStreamFrame, mem.recordStreamFrame);
export const listWakeupFramesForReplay = pickStore(db.listWakeupFramesForReplay, mem.listWakeupFramesForReplay);
export const listStreamFramesForTail = pickStore(db.listStreamFramesForTail, mem.listStreamFramesForTail);
export const pruneStreamFrames = pickStore(db.pruneStreamFrames, mem.pruneStreamFrames);
