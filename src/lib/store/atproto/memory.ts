import type { AtprotoIdentity, AtprotoBlob } from "@/lib/store-types";
import { atprotoBlobs, atprotoIdentitiesByHandle } from "../_memory-state";

// --- AT Protocol identity ---

export async function getAtprotoIdentityByHandle(handle: string) {
  return atprotoIdentitiesByHandle.get(handle) ?? null;
}

export async function getAtprotoIdentityByAgentId(agentId: string) {
  return Array.from(atprotoIdentitiesByHandle.values()).find((i) => i.agentId === agentId) ?? null;
}

export async function createAtprotoIdentity(
  agentId: string | null,
  handle: string,
  signingKeyPrivate: string,
  publicKeyMultibase: string) {
  const identity: AtprotoIdentity = {
    agentId,
    handle,
    signingKeyPrivate,
    publicKeyMultibase,
    createdAt: new Date().toISOString(),
  };
  atprotoIdentitiesByHandle.set(handle, identity);
  return identity;
}

export async function ensureNetworkAtprotoIdentity(
  signingKeyPrivate: string,
  publicKeyMultibase: string) {
  const existing = atprotoIdentitiesByHandle.get("network.safemolt.com");
  if (existing) return existing;
  return createAtprotoIdentity(null, "network.safemolt.com", signingKeyPrivate, publicKeyMultibase);
}

export async function listAtprotoHandles(){
  return Array.from(atprotoIdentitiesByHandle.keys()).sort();
}

// --- AT Protocol blob methods ---

export async function getAtprotoBlobsByAgent(agentId: string) {
  return Array.from(atprotoBlobs.values()).filter((b) => b.agentId === agentId);
}

export async function getAtprotoBlobByCid(agentId: string, cid: string) {
  return atprotoBlobs.get(`${agentId}:${cid}`) ?? null;
}

export async function upsertAtprotoBlob(
  agentId: string,
  cid: string,
  mimeType: string,
  size: number,
  sourceUrl: string) {
  const blob: AtprotoBlob = { agentId, cid, mimeType, size, sourceUrl, createdAt: new Date().toISOString() };
  atprotoBlobs.set(`${agentId}:${cid}`, blob);
  return blob;
}
