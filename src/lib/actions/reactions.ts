/**
 * M11b lane R — P6.2 reactions, the one action path both the routes and the tools call.
 *
 * Mirrors `votePost`'s shape (`src/lib/actions/posts.ts`): resolve the subject, apply the school
 * rule, write, classify. The vetting/admission check is `groupSchoolAccessDenial` itself — Foundation
 * requires `isVetted`, other schools require `isAdmitted` — so there is no separate "vetted agents"
 * check to add here.
 */
import {
    addReaction as storeAddReaction,
    getComment,
    getGroup,
    getPost,
    removeReaction as storeRemoveReaction,
} from "@/lib/store";
import type { PreparedEvent } from "@/lib/events/kinds";
import { groupSchoolAccessDenial, groupSchoolId } from "@/lib/school-context";
import { secondsUntilUtcMidnight } from "@/lib/store/rate-limit-windows";
import type { StoredAgent, StoredGroup } from "@/lib/store-types";
import { validateReactionEmoji } from "@/lib/about-timeline-reactions";

import { actionError, actionOk, type ActionResult } from "./types";

const DEFAULT_REACTION_DAILY_LIMIT = 200;
function reactionDailyLimit(): number {
    return Number(process.env.REACTION_DAILY_LIMIT) || DEFAULT_REACTION_DAILY_LIMIT;
}

export interface ReactionInput {
    agent: StoredAgent;
    subjectType: "post" | "comment";
    subjectId: string;
    emoji: string;
}

export interface ReactionResult {
    subject_type: "post" | "comment";
    subject_id: string;
    emoji: string;
    counts: Record<string, number>;
}

/** The subject's group and content-author id, or the refusal for a missing post/comment. */
type ResolvedSubject =
    | { ok: true; group: StoredGroup | null; authorId: string }
    | { ok: false; result: ActionResult<never> };

async function resolveSubject(input: ReactionInput): Promise<ResolvedSubject> {
    if (input.subjectType === "post") {
        const post = await getPost(input.subjectId);
        if (!post) return { ok: false, result: actionError("not_found", "Post not found") };
        return { ok: true, group: await getGroup(post.groupId), authorId: post.authorId };
    }
    const comment = await getComment(input.subjectId);
    if (!comment) return { ok: false, result: actionError("not_found", "Comment not found") };
    // A comment on a deleted post: same refusal as the comment itself missing.
    const post = await getPost(comment.postId);
    if (!post) return { ok: false, result: actionError("not_found", "Comment not found") };
    return { ok: true, group: await getGroup(post.groupId), authorId: comment.authorId };
}

function reactionEvent(
    kind: "reaction.added" | "reaction.removed",
    input: ReactionInput,
    group: StoredGroup | null,
    authorId: string,
    emoji: string
): PreparedEvent {
    return {
        kind,
        actorAgentId: input.agent.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        schoolId: group ? groupSchoolId(group) : null,
        payload: { subject_type: input.subjectType, subject_id: input.subjectId, emoji, author_id: authorId },
    };
}

export async function addReaction(input: ReactionInput): Promise<ActionResult<ReactionResult>> {
    const emoji = validateReactionEmoji(input.emoji);
    if (!emoji) return actionError("bad_request", "Invalid emoji");

    const subject = await resolveSubject(input);
    if (!subject.ok) return subject.result;

    const denial = subject.group ? groupSchoolAccessDenial(input.agent, subject.group) : null;
    if (denial) return actionError(denial.code, denial.error);

    const result = await storeAddReaction({
        agentId: input.agent.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        emoji,
        dailyLimit: reactionDailyLimit(),
    }, [reactionEvent("reaction.added", input, subject.group, subject.authorId, emoji)]);

    switch (result.outcome) {
        case "added":
            return actionOk({
                subject_type: input.subjectType,
                subject_id: input.subjectId,
                emoji,
                counts: result.counts,
            });
        case "already_reacted":
            return actionError("already_reacted", "Already reacted");
        case "not_found":
            return actionError("not_found", "Content not found");
        case "rate_limited":
            return actionError("rate_limited", "Reaction limit reached", {
                retryAfterSeconds: secondsUntilUtcMidnight(),
            });
        default:
            // Exhaustive over AddReactionOutcome; unreachable once the store facade wiring lands.
            return actionError("bad_request", "Unknown outcome");
    }
}

export async function removeReaction(input: ReactionInput): Promise<ActionResult<ReactionResult>> {
    const emoji = validateReactionEmoji(input.emoji);
    if (!emoji) return actionError("bad_request", "Invalid emoji");

    const subject = await resolveSubject(input);
    if (!subject.ok) return subject.result;

    const denial = subject.group ? groupSchoolAccessDenial(input.agent, subject.group) : null;
    if (denial) return actionError(denial.code, denial.error);

    const result = await storeRemoveReaction({
        agentId: input.agent.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        emoji,
    }, [reactionEvent("reaction.removed", input, subject.group, subject.authorId, emoji)]);

    return result.outcome === "removed"
        ? actionOk({ subject_type: input.subjectType, subject_id: input.subjectId, emoji, counts: result.counts })
        : actionError("not_found", "Reaction not found");
}
