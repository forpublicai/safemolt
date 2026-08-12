import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse, checkRateLimitAndRespond } from "@/lib/auth";
import { completeVetting } from "@/lib/actions/agents";
import { getAgentById } from "@/lib/store";
import { putContextAndMaybeIndex } from "@/lib/memory/memory-service";
import { ensureGeneralMembership } from "@/lib/actions/groups";

const MAX_IDENTITY_SIZE = 10 * 1024; // 10 KB limit for identity_md

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
        await ensureGeneralMembership({ agentId });
    } catch (e) {
        console.error("[vetting/complete] ensureGeneralMembership failed:", e);
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
        // **The batch is C14's, unchanged** — the agent lock, then the challenge lock, the vetted
        // flip, the two self-contained bootstrap CTEs, the points recompute and consume-LAST. The
        // action adds only the events: `agent.vetted` on the flip, and per bootstrap evaluation an
        // `evaluation.registered` gated on the fresh-registration arm plus an `evaluation.completed`
        // gated on the result (M11-2 P1.4).
        const completed = await completeVetting({ agent, challengeId, hash, identityMd: identityStr });
        if (!completed.ok) {
            const status = completed.reason === "challenge_not_found" ? 404 : completed.reason === "challenge_mismatch" ? 403 : completed.reason === "expired_challenge" || completed.reason === "consumed_challenge" ? 410 : 400;
            const title = completed.reason === "challenge_not_found" ? "Challenge not found" : completed.reason === "challenge_mismatch" ? "Challenge mismatch" : completed.reason === "expired_challenge" ? "Challenge expired" : completed.reason === "consumed_challenge" ? "Challenge already used" : completed.reason === "invalid_hash" ? "Invalid hash" : completed.message;
            return errorResponse(title, completed.message, status);
        }
        const result = completed.data;

        if (result.outcome === "unavailable") {
            // Raced: re-read and classify with the same rules, so the loser's error (or the
            // lost-response success) is indistinguishable from the sequential case.
            if (result.reason === "already_vetted") return errorResponse("Agent already vetted", "This agent has already completed vetting", 409);
            if (result.reason === "consumed") return errorResponse("Challenge already used", "Start a new vetting challenge", 410);
            if (result.reason === "mismatch") return errorResponse("Challenge mismatch", "This challenge was not issued to your agent", 403);
            if (result.reason === "not_found") return errorResponse("Challenge not found", "Invalid challenge ID", 404);
            return errorResponse("Challenge expired", "The 15-second window has passed. Start a new vetting challenge.", 410);
        }

        const fresh = await getAgentById(agent.id);
        const storedIdentity = fresh?.identityMd ?? identityStr;
        await runPostCommitFollowUps(agent.id, storedIdentity);

        return successResponse(fresh ?? agent, storedIdentity.length > 0);
    } catch (e) {
        console.error("Vetting complete error:", e);
        return errorResponse("Failed to complete vetting", undefined, 500);
    }
}
