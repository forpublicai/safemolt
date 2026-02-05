/**
 * Nonce utilities for agent certification
 * 
 * Generates and validates signed nonces to ensure:
 * 1. Agents process the specific test instance issued to them
 * 2. Transcripts cannot be replayed or tampered with
 * 3. Submissions are time-bound (default 30 min expiry)
 */

import crypto from 'crypto';

const NONCE_SECRET = process.env.NONCE_SECRET || 'dev-secret-change-in-prod';
const DEFAULT_VALIDITY_MINUTES = 30;

export interface NoncePayload {
    evaluationId: string;
    agentId: string;
    timestamp: number;
    random: string;
}

/**
 * Generate a signed nonce for a certification attempt
 */
export function generateNonce(evaluationId: string, agentId: string): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(16).toString('hex');
    const payload = `${evaluationId}:${agentId}:${timestamp}:${random}`;
    const signature = crypto.createHmac('sha256', NONCE_SECRET).update(payload).digest('hex');
    return Buffer.from(`${payload}:${signature}`).toString('base64');
}

/**
 * Validate a nonce signature and check it matches the expected evaluation/agent
 */
export function validateNonce(
    nonce: string,
    evaluationId: string,
    agentId: string
): { valid: boolean; error?: string; payload?: NoncePayload } {
    try {
        const decoded = Buffer.from(nonce, 'base64').toString('utf-8');
        const parts = decoded.split(':');
        if (parts.length !== 5) {
            return { valid: false, error: 'Invalid nonce format' };
        }

        const [evalId, agtId, timestampStr, random, signature] = parts;

        // Verify signature
        const payload = `${evalId}:${agtId}:${timestampStr}:${random}`;
        const expectedSig = crypto.createHmac('sha256', NONCE_SECRET).update(payload).digest('hex');
        if (signature !== expectedSig) {
            return { valid: false, error: 'Invalid nonce signature' };
        }

        // Verify evaluation and agent match
        if (evalId !== evaluationId) {
            return { valid: false, error: 'Nonce evaluation mismatch' };
        }
        if (agtId !== agentId) {
            return { valid: false, error: 'Nonce agent mismatch' };
        }

        const timestamp = parseInt(timestampStr, 10);
        return {
            valid: true,
            payload: { evaluationId: evalId, agentId: agtId, timestamp, random },
        };
    } catch {
        return { valid: false, error: 'Nonce decode failed' };
    }
}

/**
 * Calculate nonce expiration time
 */
export function getNonceExpiresAt(validityMinutes: number = DEFAULT_VALIDITY_MINUTES): Date {
    return new Date(Date.now() + validityMinutes * 60 * 1000);
}

/**
 * Check if a nonce has expired based on stored expiration time
 */
export function isNonceExpired(nonceExpiresAt: Date | string): boolean {
    const expiresAt = typeof nonceExpiresAt === 'string' ? new Date(nonceExpiresAt) : nonceExpiresAt;
    return Date.now() > expiresAt.getTime();
}
