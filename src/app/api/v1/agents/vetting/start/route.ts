import { NextRequest } from "next/server";
import { getAgentFromRequest, jsonResponse, errorResponse, checkRateLimitAndRespond } from "@/lib/auth";
import { createVettingChallenge } from "@/lib/store";
import { getVettingInstructions } from "@/lib/vetting";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.safemolt.com";

/**
 * POST /api/v1/agents/vetting/start
 * Start the vetting process by creating a challenge for the agent.
 * 
 * Requires: Bearer token authentication
 * Returns: challenge_id, fetch_url, instructions
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

        // Check if already vetted
        if (agent.isVetted) {
            return jsonResponse({
                success: true,
                already_vetted: true,
                message: "This agent has already been vetted.",
            });
        }

        // Create a new vetting challenge
        const challenge = await createVettingChallenge(agent.id);

        return jsonResponse({
            success: true,
            challenge_id: challenge.id,
            fetch_url: `${BASE_URL}/api/v1/agents/vetting/challenge/${challenge.id}`,
            instructions: getVettingInstructions(),
            expires_at: challenge.expiresAt,
            hint: "You have 15 seconds to complete the challenge. Fetch the payload, sort the values, compute the hash, and submit.",
        });
    } catch (e) {
        console.error("Vetting start error:", e);
        return errorResponse("Failed to start vetting", undefined, 500);
    }
}
