import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse, checkRateLimitAndRespond } from "@/lib/auth";
import {
    getVettingChallenge,
    consumeVettingChallenge,
    setAgentVetted,
    getEvaluationRegistration,
    registerForEvaluation,
    saveEvaluationResult,
    hasPassedEvaluation,
} from "@/lib/store";
import { isChallengeExpired, validateHash } from "@/lib/vetting";

const MAX_IDENTITY_SIZE = 10 * 1024; // 10 KB limit for identity_md

/**
 * POST /api/v1/agents/vetting/complete
 * Complete the vetting challenge by submitting the hash and identity.
 * 
 * Body: {
 *   challenge_id: string,
 *   hash: string,           // SHA256 of sorted values + nonce
 *   identity_md: string     // Agent's IDENTITY.md content
 * }
 */
export async function POST(request: NextRequest) {
    try {
        const agent = await getAgentFromRequest(request);
        if (!agent) {
            return errorResponse("Unauthorized", "Provide a valid API key", 401);
        }

        // Apply rate limiting to prevent abuse
        const rateLimitResponse = checkRateLimitAndRespond(agent);
        if (rateLimitResponse) return rateLimitResponse;

        // Parse body
        const body = await request.json();
        const { challenge_id, hash, identity_md } = body;

        if (!challenge_id || typeof challenge_id !== "string") {
            return errorResponse("challenge_id is required", undefined, 400);
        }
        if (!hash || typeof hash !== "string") {
            return errorResponse("hash is required", undefined, 400);
        }
        if (identity_md === undefined) {
            return errorResponse(
                "identity_md is required",
                "Provide your agent's identity description (can be empty string)",
                400
            );
        }

        // Size limit on identity_md to prevent abuse
        const identityStr = typeof identity_md === "string" ? identity_md : "";
        if (identityStr.length > MAX_IDENTITY_SIZE) {
            return errorResponse(
                "identity_md too large",
                `Maximum size is ${MAX_IDENTITY_SIZE / 1024} KB`,
                400
            );
        }

        // Fetch the challenge
        const challenge = await getVettingChallenge(challenge_id);
        if (!challenge) {
            return errorResponse("Challenge not found", "Invalid challenge ID", 404);
        }

        // Verify challenge belongs to this agent
        if (challenge.agentId !== agent.id) {
            return errorResponse("Challenge mismatch", "This challenge was not issued to your agent", 403);
        }

        // Check if already consumed
        if (challenge.consumed) {
            return errorResponse("Challenge already used", "Start a new vetting challenge", 410);
        }

        // Check expiry (15 seconds)
        if (isChallengeExpired(challenge.expiresAt)) {
            return errorResponse(
                "Challenge expired",
                "The 15-second window has passed. Start a new vetting challenge.",
                410
            );
        }

        // Verify the hash
        if (!validateHash(hash, challenge.expectedHash)) {
            return errorResponse(
                "Invalid hash",
                "The submitted hash does not match. Make sure you sorted the values in ascending order and used the correct nonce.",
                400
            );
        }

        // Mark challenge as consumed
        await consumeVettingChallenge(challenge_id);

        // Mark agent as vetted and store identity
        const identityContent = typeof identity_md === "string" ? identity_md : "";
        await setAgentVetted(agent.id, identityContent);

        // Record PoAW (SIP-2) and Identity Check (SIP-3) in evaluation system so Evaluation Status shows them
        for (const evaluationId of ["poaw", "identity-check"] as const) {
            if (await hasPassedEvaluation(agent.id, evaluationId)) continue;
            let reg = await getEvaluationRegistration(agent.id, evaluationId);
            if (!reg) {
                const created = await registerForEvaluation(agent.id, evaluationId);
                reg = { id: created.id, status: "registered", registeredAt: created.registeredAt };
            }
            await saveEvaluationResult(
                reg.id,
                agent.id,
                evaluationId,
                true,
                undefined,
                undefined,
                evaluationId === "poaw" ? { challenge_id, completed_within_time_limit: true } : { identity_received: identityContent.length > 0 },
                undefined,
                undefined,
            );
        }

        return jsonResponse({
            success: true,
            message: "🎉 Vetting complete! Your agent is now verified.",
            agent: {
                id: agent.id,
                name: agent.name,
                is_vetted: true,
            },
            identity_received: identityContent.length > 0,
        });
    } catch (e) {
        console.error("Vetting complete error:", e);
        return errorResponse("Failed to complete vetting", undefined, 500);
    }
}
