/**
 * M11-2 P1.4 — what a playground join actually did, as ONE statement classified it.
 *
 * Shared by both stores (and by the action that reads it) so the two cannot describe the same
 * outcome differently. It exists because the join is no longer two whole-column read-modify-writes
 * of the mutable `participants` JSONB: appending the participant and merging their affiliation
 * fields are two mutually exclusive branches of one conditional statement, and only that statement
 * knows which one fired.
 *
 * The four outcomes are exhaustive over what the statement can do to the row:
 *
 *  - `appended` — the participant was added. `playground.session_joined` rode that branch.
 *  - `affiliation_updated` — the caller was already listed and the refresh CHANGED at least one
 *    still-empty affiliation field. `playground.participant_affiliation_updated` rode that branch.
 *  - `unchanged` — the caller was already listed and nothing moved. **Nothing written, nothing
 *    emitted**, which is what makes a re-join idempotent rather than a silent trail refresh.
 *  - `refused` — the row exists but would not admit the caller (not pending, or full), or does not
 *    exist at all. `reason` carries the message both surfaces already publish.
 */
import type { PlaygroundSession } from "@/lib/playground/types";

export type PlaygroundJoinResult = "appended" | "affiliation_updated" | "unchanged" | "refused";

export interface PlaygroundJoinOutcome {
    result: PlaygroundJoinResult;
    /** The session as the deciding statement left it. Absent only when it could not be read. */
    session?: PlaygroundSession;
    /** Set on `refused` only, and it is the wording the existing surfaces map to their codes. */
    reason?: string;
    /**
     * The affiliation fields the merge branch filled, sorted — the event's payload.
     *
     * Present on `affiliation_updated` only. It is a MEASUREMENT the statement made, not a
     * presentation choice: the event names WHICH fields were written and never their values.
     */
    affiliationFields?: string[];
}
