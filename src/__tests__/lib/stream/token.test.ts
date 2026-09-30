/**
 * P5.2 stream token: mint/verify round-trip, expiry, tamper rejection, secret-unset degradation,
 * and rotation (a token minted under one secret must fail under a different one).
 */
import { mintStreamToken, verifyStreamToken } from "@/lib/stream/token";

const SAVED_SECRET = process.env.STREAM_TOKEN_SECRET;

afterEach(() => {
  if (SAVED_SECRET === undefined) delete process.env.STREAM_TOKEN_SECRET;
  else process.env.STREAM_TOKEN_SECRET = SAVED_SECRET;
});

describe("mintStreamToken", () => {
  it("throws when STREAM_TOKEN_SECRET is unset (caller must gate before minting)", () => {
    delete process.env.STREAM_TOKEN_SECRET;
    expect(() => mintStreamToken("agent_1")).toThrow();
  });

  it("returns a 600s TTL", () => {
    process.env.STREAM_TOKEN_SECRET = "s3cret";
    const { expiresInSeconds } = mintStreamToken("agent_1");
    expect(expiresInSeconds).toBe(600);
  });
});

describe("verifyStreamToken", () => {
  it("round-trips a freshly minted token", () => {
    process.env.STREAM_TOKEN_SECRET = "s3cret";
    const now = Date.now();
    const { token } = mintStreamToken("agent_1", now);

    const result = verifyStreamToken(token, now + 1000);
    expect(result).toEqual({ ok: true, agentId: "agent_1" });
  });

  it("rejects an expired token with reason 'expired'", () => {
    process.env.STREAM_TOKEN_SECRET = "s3cret";
    const now = Date.now();
    const { token } = mintStreamToken("agent_1", now);

    const result = verifyStreamToken(token, now + 601 * 1000);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered payload with reason 'invalid'", () => {
    process.env.STREAM_TOKEN_SECRET = "s3cret";
    const now = Date.now();
    const { token } = mintStreamToken("agent_1", now);
    const [encodedPayload, signature] = token.split(".");
    const tamperedPayload = Buffer.from("agent_evil.9999999999", "utf8").toString("base64url");
    const tampered = `${tamperedPayload}.${signature}`;

    const result = verifyStreamToken(tampered, now);
    expect(result).toEqual({ ok: false, reason: "invalid" });
    // sanity: the untampered token from the same mint is unaffected
    expect(encodedPayload).not.toBe(tamperedPayload);
  });

  it("rejects a tampered signature with reason 'invalid'", () => {
    process.env.STREAM_TOKEN_SECRET = "s3cret";
    const now = Date.now();
    const { token } = mintStreamToken("agent_1", now);
    const [encodedPayload] = token.split(".");
    const tampered = `${encodedPayload}.${"0".repeat(64)}`;

    const result = verifyStreamToken(tampered, now);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns 'not_enabled' rather than throwing when the secret is unset", () => {
    process.env.STREAM_TOKEN_SECRET = "s3cret";
    const { token } = mintStreamToken("agent_1");
    delete process.env.STREAM_TOKEN_SECRET;

    const result = verifyStreamToken(token);
    expect(result).toEqual({ ok: false, reason: "not_enabled" });
  });

  it("rotation: a token minted under one secret fails verification after the secret changes", () => {
    process.env.STREAM_TOKEN_SECRET = "old-secret";
    const { token } = mintStreamToken("agent_1");

    process.env.STREAM_TOKEN_SECRET = "new-secret";
    const result = verifyStreamToken(token);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});
