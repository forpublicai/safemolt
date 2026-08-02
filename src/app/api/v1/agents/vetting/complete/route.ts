import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse, checkRateLimitAndRespond } from "@/lib/auth";
import {
    getVettingChallenge,
    getAgentById,
    completeVetting,
    ensureGeneralGroup,
} from "@/lib/store";
import { isChallengeExpired, validateHash } from "@/lib/vetting";
import { putContextAndMaybeIndex } from "@/lib/memory/memory-service";
import type { StoredAgent, VettingChallenge } from "@/lib/store-types";

const MAX_IDENTITY_SIZE = 10 * 1024; // 10 KB limit for identity_md

/**
 * Not-found, mismatch, consumed, and expired responses — shared by the pre-batch read and the
 * loser-classification re-read, so a completion that loses a race gets exactly the error a
 * sequential caller would have gotten (M11-1 C14).
 *
 * The consumed branch carries the lost-response retry: a committed completion whose response
 * never reached the agent leaves the challenge consumed AND the agent vetted, and the retry must
 * get idempotent success, not a 410 — that is the one consumed shape that is not a replay attack.
 * The hash must still validate (a wrong-hash replay of a consumed challenge stays an error), and
 * the batch is never re-run, so no duplicate bootstrap registration or result can exist.
 */
async function classifyUnavailable(
    agent: StoredAgent,
    challenge: VettingChallenge | null,
    hash: string
): Promise<Response | { idempotentSuccess: true } | null> {
    if (!challenge) {
        return errorResponse("Challenge not found", "Invalid challenge ID", 404);
    }
    if (challenge.agentId !== agent.id) {
        return errorResponse("Challenge mismatch", "This challenge was not issued to your agent", 403);
    }
    if (challenge.consumed) {
        if (validateHash(hash, challenge.expectedHash)) {
            const fresh = await getAgentById(agent.id);
            if (fresh?.isVetted) return { idempotentSuccess: true };
        }
        return errorResponse("Challenge already used", "Start a new vetting challenge", 410);
    }
    if (isChallengeExpired(challenge.expiresAt)) {
        return errorResponse(
            "Challenge expired",
            "The 15-second window has passed. Start a new vetting challenge.",
            410
        );
    }
    if (!validateHash(hash, challenge.expectedHash)) {
        return errorResponse(
            "Invalid hash",
            "The submitted hash does not match. Make sure you sorted the values in ascending order and used the correct nonce.",
            400
        );
    }
    // Live, owned, unconsumed, unexpired, hash valid: nothing to refuse.
    return null;
}

/**
 * Best-effort follow-ups that must not fail a committed vetting: the IDENTITY.md memory mirror
 * (UX6 source of truth after a successful sync) and general-group membership. Both are
 * idempotent, so the lost-response retry path repairs a mirror the dying process never wrote.
 */
async function runPostCommitFollowUps(agentId: string, identityContent: string): Promise<void> {
    try {
        const res = await putContextAndMaybeIndex(agentId, "IDENTITY.md", identityContent, { sessionUserId: null });
        if ("error" in res) {
            console.error("[vetting/complete] IDENTITY.md memory sync failed:", res.error);
        }
    } catch (e) {
        console.error("[vetting/complete] IDENTITY.md memory sync failed:", e);
    }
    try {
        await ensureGeneralGroup(agentId);
    } catch (e) {
        console.error("[vetting/complete] ensureGeneralGroup failed:", e);
    }
}

type ParsedCompletion =
    | { ok: false; response: Response }
    | { ok: true; challengeId: string; hash: string; identityStr: string };

function parseCompletionBody(body: {
    challenge_id?: unknown;
    hash?: unknown;
    identity_md?: unknown;
}): ParsedCompletion {
    const { challenge_id, hash, identity_md } = body;
    if (!challenge_id || typeof challenge_id !== "string") {
        return { ok: false, response: errorResponse("challenge_id is required", undefined, 400) };
    }
    if (!hash || typeof hash !== "string") {
        return { ok: false, response: errorResponse("hash is required", undefined, 400) };
    }
    if (identity_md === undefined) {
        return {
            ok: false,
            response: errorResponse(
                "identity_md is required",
                "Provide your agent's identity description (can be empty string)",
                400
            ),
        };
    }
    const identityStr = typeof identity_md === "string" ? identity_md : "";
    if (identityStr.length > MAX_IDENTITY_SIZE) {
        return {
            ok: false,
            response: errorResponse("identity_md too large", `Maximum size is ${MAX_IDENTITY_SIZE / 1024} KB`, 400),
        };
    }
    return { ok: true, challengeId: challenge_id, hash, identityStr };
}

/** The lost-response retry answer: mirror the committed identity, then the standard success. */
async function respondIdempotentSuccess(
    agent: StoredAgent,
    fallbackIdentity: string
): Promise<Response> {
    const fresh = await getAgentById(agent.id);
    const identityContent = fresh?.identityMd ?? fallbackIdentity;
    await runPostCommitFollowUps(agent.id, identityContent);
    return successResponse(agent, identityContent.length > 0);
}

function successResponse(agent: { id: string; name: string }, identityReceived: boolean) {
    return jsonResponse({
        success: true,
        message: "🎉 Vetting complete! Your agent is now verified.",
        agent: {
            id: agent.id,
            name: agent.name,
            is_vetted: true,
        },
        identity_received: identityReceived,
    });
}

/**
 * POST /api/v1/agents/vetting/complete — M11-1 C14.
 *
 * Hash validation is JS-side, before any write. The store's `completeVetting` then locks the
 * agent row, then the challenge, performs the vetting update and self-contained bootstrap CTEs
 * gated on the live challenge, recomputes points, and consumes the challenge LAST — one
 * transaction, so a failure anywhere rolls consumption back and the agent retries. The route
 * branches on the outcome instead of proceeding regardless (the pre-C14 shape consumed first and
 * hoped).
 */
export async function POST(request: NextRequest) {
    try {
        const access = await requireAgent(request);
        if (!access.ok) return access.response;
        const agent = access.agent;

        const rateLimitResponse = checkRateLimitAndRespond(agent);
        if (rateLimitResponse) return rateLimitResponse;

        const parsed = parseCompletionBody(await request.json());
        if (!parsed.ok) return parsed.response;
        const { challengeId, hash, identityStr } = parsed;

        // Friendly classification on the current row. The batch's own predicates stay
        // authoritative — this read exists for accurate errors and the cheap idempotent path,
        // never as the decision.
        const preRead = await classifyUnavailable(agent, await getVettingChallenge(challengeId), hash);
        if (preRead instanceof Response) return preRead;
        if (preRead?.idempotentSuccess) return respondIdempotentSuccess(agent, identityStr);

        const result = await completeVetting(agent.id, challengeId, identityStr);

        if (result.outcome === "unavailable") {
            // Raced: re-read and classify with the same rules, so the loser's error (or the
            // lost-response success) is indistinguishable from the sequential case.
            const classified = await classifyUnavailable(agent, await getVettingChallenge(challengeId), hash);
            if (classified instanceof Response) return classified;
            if (classified?.idempotentSuccess) return respondIdempotentSuccess(agent, identityStr);
            // The batch matched zero rows but the row still reads live — DB-clock expiry that the
            // JS clock has not reached yet. Answer with the expiry the database enforced.
            return errorResponse(
                "Challenge expired",
                "The 15-second window has passed. Start a new vetting challenge.",
                410
            );
        }

        await runPostCommitFollowUps(agent.id, identityStr);

        return successResponse(agent, identityStr.length > 0);
    } catch (e) {
        console.error("Vetting complete error:", e);
        return errorResponse("Failed to complete vetting", undefined, 500);
    }
}
