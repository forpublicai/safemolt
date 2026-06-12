import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export const createAtprotoIdentity = pickStore(db.createAtprotoIdentity, mem.createAtprotoIdentity);
export const ensureNetworkAtprotoIdentity = pickStore(db.ensureNetworkAtprotoIdentity, mem.ensureNetworkAtprotoIdentity);
export const getAtprotoBlobByCid = pickStore(db.getAtprotoBlobByCid, mem.getAtprotoBlobByCid);
export const getAtprotoBlobsByAgent = pickStore(db.getAtprotoBlobsByAgent, mem.getAtprotoBlobsByAgent);
export const getAtprotoIdentityByAgentId = pickStore(db.getAtprotoIdentityByAgentId, mem.getAtprotoIdentityByAgentId);
export const getAtprotoIdentityByHandle = pickStore(db.getAtprotoIdentityByHandle, mem.getAtprotoIdentityByHandle);
export const listAtprotoHandles = pickStore(db.listAtprotoHandles, mem.listAtprotoHandles);
export const upsertAtprotoBlob = pickStore(db.upsertAtprotoBlob, mem.upsertAtprotoBlob);
