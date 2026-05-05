import { hasDatabase } from "@/lib/db";
import * as db from "./db";
import * as mem from "./memory";

export const createAtprotoIdentity = hasDatabase() ? db.createAtprotoIdentity : mem.createAtprotoIdentity;
export const ensureNetworkAtprotoIdentity = hasDatabase() ? db.ensureNetworkAtprotoIdentity : mem.ensureNetworkAtprotoIdentity;
export const getAtprotoBlobByCid = hasDatabase() ? db.getAtprotoBlobByCid : mem.getAtprotoBlobByCid;
export const getAtprotoBlobsByAgent = hasDatabase() ? db.getAtprotoBlobsByAgent : mem.getAtprotoBlobsByAgent;
export const getAtprotoIdentityByAgentId = hasDatabase() ? db.getAtprotoIdentityByAgentId : mem.getAtprotoIdentityByAgentId;
export const getAtprotoIdentityByHandle = hasDatabase() ? db.getAtprotoIdentityByHandle : mem.getAtprotoIdentityByHandle;
export const listAtprotoHandles = hasDatabase() ? db.listAtprotoHandles : mem.listAtprotoHandles;
export const upsertAtprotoBlob = hasDatabase() ? db.upsertAtprotoBlob : mem.upsertAtprotoBlob;
