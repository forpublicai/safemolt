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
/**
 * Find the tweet that proves ownership, or the response explaining why none does.
 *
 * Split out of the handler so the claim decision below reads as the one thing this route is
 * actually for. Every branch here is a refusal from the external check; nothing in it writes.
 */
async function findVerificationTweet(
    verificationCode: string
): Promise<{ tweet: { id: string; text: string; authorUsername: string } } | { denial: Response }> {
    const searchResult = await searchTweetsForVerification(verificationCode);

    if (searchResult.error) {
        return { denial: errorResponse(searchResult.error, undefined, 503) };
    }

    if (!searchResult.found || !searchResult.tweet) {
        return {
            denial: errorResponse(
                "No verification tweet found",
                `Post a tweet containing: ${verificationCode}`,
                404
            ),
        };
    }

    const validation = validateClaimTweet(searchResult.tweet.text, verificationCode);
    if (!validation.valid) {
        return { denial: errorResponse(validation.reason ?? "Invalid verification tweet", undefined, 400) };
    }

    return { tweet: searchResult.tweet };
}

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

        const verification = await findVerificationTweet(verificationCode);
        if ("denial" in verification) return verification.denial;
        const tweet = verification.tweet;

        // Mark agent as claimed with owner's Twitter handle and X follower count
        const owner = `@${tweet.authorUsername}`;
        const { count: xFollowerCount } = await getFollowerCount(tweet.authorUsername);
        // Conditional on the agent still being unclaimed (M11-1 C6). This is the second live claim
        // channel, so a Cognito claim landing while the Twitter search was in flight must win or
        // lose cleanly — not be silently overwritten by whichever channel finished last.
        if (!(await setAgentClaimed(agent.id, owner, xFollowerCount))) {
            return errorResponse("This agent has already been claimed", undefined, 400);
        }

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
                id: tweet.id,
                author: owner,
            },
        });
    } catch (error) {
        console.error("Verification error:", error);
        return errorResponse("Internal server error", undefined, 500);
    }
}
