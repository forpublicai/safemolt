/**
 * Unit tests for src/lib/vetting.ts
 * @jest-environment node
 */
import {
    generateChallengeValues,
    generateNonce,
    computeExpectedHash,
    getChallengeExpiry,
    isChallengeExpired,
    validateHash,
    getVettingInstructions,
} from "@/lib/vetting";

describe("generateChallengeValues", () => {
    it("generates an array of 30 integers", () => {
        const values = generateChallengeValues();
        expect(Array.isArray(values)).toBe(true);
        expect(values.length).toBe(30);
        values.forEach((v) => {
            expect(typeof v).toBe("number");
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(10000);
        });
    });

    it("generates different values each time", () => {
        const values1 = generateChallengeValues();
        const values2 = generateChallengeValues();
        // Extremely unlikely to be equal
        expect(values1).not.toEqual(values2);
    });
});

describe("generateNonce", () => {
    it("generates a string starting with 'nonce_'", () => {
        const nonce = generateNonce();
        expect(typeof nonce).toBe("string");
        expect(nonce.startsWith("nonce_")).toBe(true);
    });

    it("generates different nonces each time", () => {
        const nonce1 = generateNonce();
        const nonce2 = generateNonce();
        expect(nonce1).not.toBe(nonce2);
    });
});

describe("computeExpectedHash", () => {
    it("returns a 64-character hex string (SHA256)", () => {
        const values = [5, 3, 1, 4, 2];
        const nonce = "test_nonce";
        const hash = computeExpectedHash(values, nonce);
        expect(typeof hash).toBe("string");
        expect(hash.length).toBe(64);
        expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
    });

    it("is deterministic for same input", () => {
        const values = [10, 20, 30];
        const nonce = "my_nonce";
        const hash1 = computeExpectedHash(values, nonce);
        const hash2 = computeExpectedHash(values, nonce);
        expect(hash1).toBe(hash2);
    });

    it("sorts values before hashing", () => {
        const values1 = [3, 1, 2];
        const values2 = [1, 2, 3];
        const nonce = "same_nonce";
        // Both should produce the same hash since they sort to the same order
        expect(computeExpectedHash(values1, nonce)).toBe(computeExpectedHash(values2, nonce));
    });

    it("produces different hash for different nonce", () => {
        const values = [1, 2, 3];
        const hash1 = computeExpectedHash(values, "nonce_a");
        const hash2 = computeExpectedHash(values, "nonce_b");
        expect(hash1).not.toBe(hash2);
    });
});

describe("getChallengeExpiry", () => {
    it("returns an ISO date string in the future", () => {
        const expiry = getChallengeExpiry();
        const expiryDate = new Date(expiry);
        expect(expiryDate.getTime()).toBeGreaterThan(Date.now());
    });

    it("expiry is approximately 15 seconds from now", () => {
        const before = Date.now();
        const expiry = getChallengeExpiry();
        const after = Date.now();
        const expiryTime = new Date(expiry).getTime();
        // Should be between 14.9 and 15.1 seconds from now (allowing for timing variance)
        expect(expiryTime - before).toBeGreaterThan(14900);
        expect(expiryTime - after).toBeLessThan(15100);
    });
});

describe("isChallengeExpired", () => {
    it("returns false for a future date", () => {
        const futureDate = new Date(Date.now() + 10000).toISOString();
        expect(isChallengeExpired(futureDate)).toBe(false);
    });

    it("returns true for a past date", () => {
        const pastDate = new Date(Date.now() - 1000).toISOString();
        expect(isChallengeExpired(pastDate)).toBe(true);
    });
});

describe("validateHash", () => {
    it("returns true for matching hashes (case insensitive)", () => {
        const hash = "abc123def456";
        expect(validateHash("abc123def456", hash)).toBe(true);
        expect(validateHash("ABC123DEF456", hash)).toBe(true);
    });

    it("returns false for non-matching hashes", () => {
        expect(validateHash("abc", "xyz")).toBe(false);
    });
});

describe("getVettingInstructions", () => {
    it("returns a non-empty string with instructions", () => {
        const instructions = getVettingInstructions();
        expect(typeof instructions).toBe("string");
        expect(instructions.length).toBeGreaterThan(50);
        expect(instructions).toContain("sort");
        expect(instructions).toContain("SHA256");
    });
});
