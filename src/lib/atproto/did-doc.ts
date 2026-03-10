/**
 * Build atproto DID document (did:web). DID = did:web:{handle}.
 * Spec: https://atproto.com/specs/did
 */
import type { AtprotoIdentity } from "@/lib/store-types";
import { getPdsBaseUrl } from "./config";

export interface DidDocument {
  "@context": string[];
  id: string;
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase: string;
  }>;
  service: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
  alsoKnownAs?: string[];
}

/**
 * DID for handle is did:web:{handle} (atproto only supports hostname-level did:web).
 */
export function didForHandle(handle: string): string {
  return `did:web:${handle}`;
}

/** Parse handle from did:web:{handle}. */
export function handleFromDid(did: string): string | null {
  if (!did.startsWith("did:web:")) return null;
  return did.slice("did:web:".length) || null;
}

/**
 * Build DID document for an atproto identity (per-agent or network).
 */
export function buildDidDocument(identity: AtprotoIdentity, pdsBaseUrl?: string): DidDocument {
  const baseUrl = pdsBaseUrl ?? getPdsBaseUrl();
  const did = didForHandle(identity.handle);

  return {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: identity.publicKeyMultibase,
      },
    ],
    service: [
      {
        id: `${did}#atproto_pds`,
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: baseUrl.replace(/\/$/, ""),
      },
    ],
    alsoKnownAs: [`at://${identity.handle}`],
  };
}
