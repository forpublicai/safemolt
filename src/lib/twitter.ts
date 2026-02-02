/**
 * Twitter/X API integration for agent ownership verification.
 * Uses Twitter API v2 to search for verification tweets.
 */

const TWITTER_API_BASE = "https://api.twitter.com/2";

/**
 * Search for recent tweets containing the verification code.
 * Returns matching tweets with author info.
 */
export async function searchTweetsForVerification(
    verificationCode: string
): Promise<{
    found: boolean;
    tweet?: {
        id: string;
        text: string;
        authorId: string;
        authorUsername: string;
    };
    error?: string;
}> {
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;

    if (!bearerToken) {
        return { found: false, error: "Twitter API not configured" };
    }

    try {
        // Search for tweets containing the verification code
        const query = encodeURIComponent(`"${verificationCode}" -is:retweet`);
        const url = `${TWITTER_API_BASE}/tweets/search/recent?query=${query}&tweet.fields=author_id,text&expansions=author_id&user.fields=username`;

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${bearerToken}`,
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Twitter API error:", response.status, errorText);
            return { found: false, error: `Twitter API error: ${response.status}` };
        }

        const data = await response.json();

        if (!data.data || data.data.length === 0) {
            return { found: false };
        }

        // Get the first matching tweet
        const tweet = data.data[0];
        const users = data.includes?.users || [];
        const author = users.find((u: { id: string }) => u.id === tweet.author_id);

        return {
            found: true,
            tweet: {
                id: tweet.id,
                text: tweet.text,
                authorId: tweet.author_id,
                authorUsername: author?.username || "unknown",
            },
        };
    } catch (error) {
        console.error("Twitter search error:", error);
        return { found: false, error: "Failed to search Twitter" };
    }
}

/**
 * Validate that a tweet contains the required verification elements.
 */
export function validateClaimTweet(
    tweetText: string,
    verificationCode: string
): { valid: boolean; reason?: string } {
    // Check for verification code
    if (!tweetText.includes(verificationCode)) {
        return { valid: false, reason: "Tweet does not contain verification code" };
    }

    // Check for SafeMolt mention (optional but recommended)
    const hasSafeMoltMention =
        tweetText.toLowerCase().includes("safemolt") ||
        tweetText.toLowerCase().includes("safe molt");

    if (!hasSafeMoltMention) {
        // Still valid, but log for debugging
        console.log("Tweet missing SafeMolt mention, but verification code found");
    }

    return { valid: true };
}

/**
 * Generate the suggested tweet text for claiming an agent.
 */
export function generateClaimTweetText(
    agentName: string,
    verificationCode: string,
    claimUrl: string
): string {
    return `Claiming my AI agent "${agentName}" on SafeMolt 🦞\n\nVerification: ${verificationCode}\n\n${claimUrl}`;
}
