import {
    checkGlobalRateLimit,
    recordRequest,
    rateLimitExceededResponse,
    addRateLimitHeaders,
    resetRateLimitForAgent,
} from "@/lib/rate-limit";

describe("rate-limit", () => {
    const testAgentId = "test-agent-rate-limit";

    beforeEach(() => {
        // Reset rate limit before each test
        resetRateLimitForAgent(testAgentId);
    });

    describe("checkGlobalRateLimit", () => {
        it("should allow requests under the limit", () => {
            const result = checkGlobalRateLimit(testAgentId);
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(100);
            expect(result.limit).toBe(100);
        });

        it("should decrement remaining after recording requests", () => {
            recordRequest(testAgentId);
            recordRequest(testAgentId);

            const result = checkGlobalRateLimit(testAgentId);
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(98);
        });

        it("should block requests when limit is exceeded", () => {
            // Record 100 requests
            for (let i = 0; i < 100; i++) {
                recordRequest(testAgentId);
            }

            const result = checkGlobalRateLimit(testAgentId);
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
            expect(result.retryAfterSeconds).toBeGreaterThan(0);
            expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
        });

        it("should track different agents separately", () => {
            const agent1 = "agent-1-rate";
            const agent2 = "agent-2-rate";

            resetRateLimitForAgent(agent1);
            resetRateLimitForAgent(agent2);

            // Record 50 requests for agent1
            for (let i = 0; i < 50; i++) {
                recordRequest(agent1);
            }

            const result1 = checkGlobalRateLimit(agent1);
            const result2 = checkGlobalRateLimit(agent2);

            expect(result1.remaining).toBe(50);
            expect(result2.remaining).toBe(100);
        });
    });

    describe("rateLimitExceededResponse", () => {
        it("should return a 429 response with correct headers", async () => {
            const response = rateLimitExceededResponse(30);

            expect(response.status).toBe(429);
            expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
            expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
            expect(response.headers.get("Retry-After")).toBe("30");

            const body = await response.json();
            expect(body.success).toBe(false);
            expect(body.error).toBe("Rate limit exceeded");
        });
    });

    describe("addRateLimitHeaders", () => {
        it("should add rate limit headers to a response", () => {
            const originalResponse = new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });

            const newResponse = addRateLimitHeaders(originalResponse, 75, 100);

            expect(newResponse.headers.get("X-RateLimit-Limit")).toBe("100");
            expect(newResponse.headers.get("X-RateLimit-Remaining")).toBe("75");
        });
    });
});
