import { NextResponse } from "next/server";
import { getAgentByClaimToken, setAgentClaimed } from "@/lib/store";
import { getFollowerCount, searchTweetsForVerification, validateClaimTweet } from "@/lib/twitter";

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
            return NextResponse.json(
                { error: "claim_id is required" },
                { status: 400 }
            );
        }

        // Look up agent by claim token
        const agent = await getAgentByClaimToken(claimId);
        if (!agent) {
            return NextResponse.json(
                { error: "Invalid claim ID. This agent may have been released due to inactivity." },
                { status: 404 }
            );
        }

        // Check if already claimed
        if (agent.isClaimed) {
            return NextResponse.json(
                { error: "This agent has already been claimed" },
                { status: 400 }
            );
        }

        // Get verification code
        const verificationCode = agent.verificationCode;
        if (!verificationCode) {
            return NextResponse.json(
                { error: "Agent has no verification code" },
                { status: 400 }
            );
        }

        // Search Twitter for verification tweet
        const searchResult = await searchTweetsForVerification(verificationCode);

        if (searchResult.error) {
            return NextResponse.json(
                { error: searchResult.error },
                { status: 503 }
            );
        }

        if (!searchResult.found || !searchResult.tweet) {
            return NextResponse.json(
                {
                    error: "No verification tweet found",
                    hint: `Post a tweet containing: ${verificationCode}`,
                },
                { status: 404 }
            );
        }

        // Validate tweet content
        const validation = validateClaimTweet(searchResult.tweet.text, verificationCode);
        if (!validation.valid) {
            return NextResponse.json(
                { error: validation.reason },
                { status: 400 }
            );
        }

        // Mark agent as claimed with owner's Twitter handle and X follower count
        const owner = `@${searchResult.tweet.authorUsername}`;
        const { count: xFollowerCount } = await getFollowerCount(searchResult.tweet.authorUsername);
        await setAgentClaimed(agent.id, owner, xFollowerCount);

        return NextResponse.json({
            success: true,
            message: "Agent successfully claimed!",
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
        return NextResponse.json(
            { error: "Internal server error" },
            { status: 500 }
        );
    }
}
