import { getAgentByClaimToken, setAgentClaimed } from "@/lib/store";
import { SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM } from "@/lib/agent-onboarding-copy";
import { getFollowerCount, searchTweetsForVerification, validateClaimTweet } from "@/lib/twitter";
import { errorResponse, jsonResponse } from "@/lib/auth";

/**
 * POST /api/v1/agents/verify
 * Verify agent ownership by searching for a verification tweet.
 * 
 * Body: { claim_id: string }
 * 
 * This endpoint:
 * 1. Looks up the agent by claim token
 * 2. Searches Twitter for tweets containing the verification code
 * 3. If found and valid, marks the agent as claimed with the owner's Twitter handle
 */
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const claimId = body.claim_id;

        if (!claimId || typeof claimId !== "string") {
            return errorResponse("claim_id is required", undefined, 400);
        }

        // Look up agent by claim token
        const agent = await getAgentByClaimToken(claimId);
        if (!agent) {
            return errorResponse("Invalid claim ID. This agent may have been released due to inactivity.", undefined, 404);
        }

        // Check if already claimed
        if (agent.isClaimed) {
            return errorResponse("This agent has already been claimed", undefined, 400);
        }

        // Get verification code
        const verificationCode = agent.verificationCode;
        if (!verificationCode) {
            return errorResponse("Agent has no verification code", undefined, 400);
        }

        // Search Twitter for verification tweet
        const searchResult = await searchTweetsForVerification(verificationCode);

        if (searchResult.error) {
            return errorResponse(searchResult.error, undefined, 503);
        }

        if (!searchResult.found || !searchResult.tweet) {
            return errorResponse(
                "No verification tweet found",
                `Post a tweet containing: ${verificationCode}`,
                404
            );
        }

        // Validate tweet content
        const validation = validateClaimTweet(searchResult.tweet.text, verificationCode);
        if (!validation.valid) {
            return errorResponse(validation.reason ?? "Invalid verification tweet", undefined, 400);
        }

        // Mark agent as claimed with owner's Twitter handle and X follower count
        const owner = `@${searchResult.tweet.authorUsername}`;
        const { count: xFollowerCount } = await getFollowerCount(searchResult.tweet.authorUsername);
        await setAgentClaimed(agent.id, owner, xFollowerCount);

        return jsonResponse({
            success: true,
            message: "Agent successfully claimed!",
            suggested_message_for_agent: SUGGESTED_MESSAGE_TO_SEND_AGENT_AFTER_CLAIM,
            agent: {
                id: agent.id,
                name: agent.name,
                owner,
            },
            tweet: {
                id: searchResult.tweet.id,
                author: owner,
            },
        });
    } catch (error) {
        console.error("Verification error:", error);
        return errorResponse("Internal server error", undefined, 500);
    }
}
