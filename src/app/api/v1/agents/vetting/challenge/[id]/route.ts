import { NextRequest } from "next/server";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getVettingChallenge } from "@/lib/store";
import { markVettingChallengeFetched } from "@/lib/actions/agents";
import { isChallengeExpired } from "@/lib/vetting";

interface RouteParams {
    params: Promise<{ id: string }>;
}

/**
 * GET /api/v1/agents/vetting/challenge/[id]
 * Fetch the challenge payload. Bot must sort the values and compute hash.
 * 
 * Returns: { values: number[], nonce: string }
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;

        const challenge = await getVettingChallenge(id);
        if (!challenge) {
            return errorResponse("Challenge not found", "Invalid challenge ID", 404);
        }

        // Check if already consumed
        if (challenge.consumed) {
            return errorResponse("Challenge already used", "This challenge has been consumed", 410);
        }

        // Check if expired
        if (isChallengeExpired(challenge.expiresAt)) {
            return errorResponse("Challenge expired", "Start a new vetting challenge", 410);
        }

        // Mark as fetched for audit purposes — through the Tier-B action (M11-2 P1.4), which is the
        // shared write; the liveness rules above stay this handler's own.
        await markVettingChallengeFetched({ challengeId: id });

        // Return the challenge payload (values to sort + nonce)
        return jsonResponse({
            success: true,
            values: challenge.values,
            nonce: challenge.nonce,
            hint: "Sort the values array in ascending order, then compute SHA256(JSON.stringify(sortedValues) + nonce)",
        });
    } catch (e) {
        console.error("Challenge fetch error:", e);
        return errorResponse("Failed to fetch challenge", undefined, 500);
    }
}
