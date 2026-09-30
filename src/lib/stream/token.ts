import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * P5.2 stream tokens: TTL-only, no revocation list (per plan). Rotating `STREAM_TOKEN_SECRET`
 * invalidates every outstanding token, which is the only revocation mechanism this needs.
 *
 * Format: `base64url(payload).hex(hmac-sha256(payload))`, payload = `${agentId}.${expiryEpochSeconds}`.
 * The payload carries no secret, so it is encoded (not encrypted) — only the signature protects it.
 */

const TTL_SECONDS = 600;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time compare (mirrors auth-cron.ts): length check first, which only leaks length. */
function signaturesMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mintStreamToken(
  agentId: string,
  nowMs: number = Date.now()
): { token: string; expiresInSeconds: number } {
  const secret = process.env.STREAM_TOKEN_SECRET;
  // Contract: the caller (the stream-token route) must answer `stream_not_enabled` before ever
  // reaching here. An unset secret at this point is a deploy misconfiguration, not a per-request
  // state, so it throws instead of minting an unverifiable token.
  if (!secret) throw new Error("STREAM_TOKEN_SECRET is not configured");

  const expiryEpochSeconds = Math.floor(nowMs / 1000) + TTL_SECONDS;
  const payload = `${agentId}.${expiryEpochSeconds}`;
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const token = `${encodedPayload}.${sign(payload, secret)}`;
  return { token, expiresInSeconds: TTL_SECONDS };
}

export type VerifyStreamTokenResult =
  | { ok: true; agentId: string }
  | { ok: false; reason: "expired" | "invalid" | "not_enabled" };

export function verifyStreamToken(token: string, nowMs: number = Date.now()): VerifyStreamTokenResult {
  const secret = process.env.STREAM_TOKEN_SECRET;
  // The worker's stream server calls this per connection attempt and must degrade gracefully,
  // never crash a connection, so an unconfigured secret is a result, not a throw.
  if (!secret) return { ok: false, reason: "not_enabled" };

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [encodedPayload, signature] = parts;

  let payload: string;
  try {
    payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (!signaturesMatch(signature, sign(payload, secret))) return { ok: false, reason: "invalid" };

  const dotIndex = payload.lastIndexOf(".");
  if (dotIndex === -1) return { ok: false, reason: "invalid" };
  const agentId = payload.slice(0, dotIndex);
  const expiryEpochSeconds = Number(payload.slice(dotIndex + 1));
  if (!agentId || !Number.isFinite(expiryEpochSeconds)) return { ok: false, reason: "invalid" };

  if (Math.floor(nowMs / 1000) >= expiryEpochSeconds) return { ok: false, reason: "expired" };

  return { ok: true, agentId };
}
