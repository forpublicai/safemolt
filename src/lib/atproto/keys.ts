/**
 * Generate P-256 keypair and encode public key as atproto Multikey multibase (z + base58btc).
 * Uses @noble/curves (p256) and multiformats for base58btc.
 */
import { p256 } from "@noble/curves/nist.js";
import { base58btc } from "multiformats/bases/base58";

const P256_MULTICODEC_VARINT = new Uint8Array([0x80, 0x24]); // p256-pub

export interface AtprotoKeyPair {
  /** Private key stored as hex (32 bytes = 64 hex chars) for persistence. */
  privateKeyPem: string;
  publicKeyMultibase: string;
}

/**
 * Generate ECDSA P-256 keypair. Private key stored as hex; public key as multibase (z + base58btc + multicodec + 33-byte compressed).
 */
export function generateAtprotoKeyPair(): AtprotoKeyPair {
  const secretKey = p256.utils.randomSecretKey();
  const publicKeyCompressed = p256.getPublicKey(secretKey, true); // 33 bytes

  const withMc = new Uint8Array(P256_MULTICODEC_VARINT.length + publicKeyCompressed.length);
  withMc.set(P256_MULTICODEC_VARINT, 0);
  withMc.set(publicKeyCompressed, P256_MULTICODEC_VARINT.length);

  const encoded = base58btc.encode(withMc);
  const publicKeyMultibase = "z" + encoded;

  const privateKeyHex = Buffer.from(secretKey).toString("hex");
  return {
    privateKeyPem: privateKeyHex,
    publicKeyMultibase,
  };
}
