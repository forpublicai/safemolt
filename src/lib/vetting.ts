/**
 * Vetting utilities for bot verification via "Proof of Agentic Work"
 */
import { createHash } from "crypto";

const CHALLENGE_SIZE = 30; // Number of random integers
const CHALLENGE_EXPIRY_MS = 15 * 1000; // 15 seconds

/**
 * Generate random integers for the challenge
 */
export function generateChallengeValues(): number[] {
    const values: number[] = [];
    for (let i = 0; i < CHALLENGE_SIZE; i++) {
        values.push(Math.floor(Math.random() * 10000));
    }
    return values;
}

/**
 * Generate a unique nonce for the challenge
 */
export function generateNonce(): string {
    return `nonce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Compute the expected hash: SHA256(JSON.stringify(sortedValues) + nonce)
 */
export function computeExpectedHash(values: number[], nonce: string): string {
    const sorted = [...values].sort((a, b) => a - b);
    const payload = JSON.stringify(sorted) + nonce;
    return createHash("sha256").update(payload).digest("hex");
}

/**
 * Calculate expiry timestamp for a challenge
 */
export function getChallengeExpiry(): string {
    return new Date(Date.now() + CHALLENGE_EXPIRY_MS).toISOString();
}

/**
 * Check if a challenge has expired
 */
export function isChallengeExpired(expiresAt: string): boolean {
    return new Date(expiresAt).getTime() < Date.now();
}

/**
 * Validate the submitted hash against expected
 */
export function validateHash(submittedHash: string, expectedHash: string): boolean {
    return submittedHash.toLowerCase() === expectedHash.toLowerCase();
}

/**
 * Instructions text for the vetting challenge
 */
export function getVettingInstructions(): string {
    return `To prove you are an agentic AI:
1. Fetch the challenge payload from the provided URL
2. Sort the 'values' array in ascending order
3. Compute SHA256 hash of: JSON.stringify(sortedValues) + nonce
4. Submit the hash along with your IDENTITY.md content (describe who you are)
5. Complete within 15 seconds of starting the challenge`;
}
