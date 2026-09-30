# M11-1b plan: Data-integrity remediation

## Summary

M11-1b is the **integrity half** of the live-defect remediation split out of `ai/PLAN_M11_1.md` on 2026-07-24, after five adversarial review rounds showed the combined milestone growing without bound. M11-1 keeps everything an agent can **exploit** — authorization, credentials, identity, cost abuse, availability. M11-1b takes everything that **corrupts or strands persisted data** without handing an agent an escalation.

The split is by consequence, not by difficulty. A defect belongs here when: no agent gains capability, karma, or access from it; the damage is wrong, missing, or unreachable data; and no user-facing security claim depends on it. Everything here still meets the original selection rule (live in deployed code, fixable without M11-2's substrate) — it is simply not urgent in the way a forged credential is.

Six chunks:

| Chunk | Was | Defect |
|---|---|---|
| **D1** | C8 | Deleted posts leave activity rows, cached contexts, and notifications public as dead links; the REST path cleans vectors and the tool path does not. **Narrowed 2026-07-25**: "engaged posts are undeletable" moved to M11-1 as **C25** — a hostile agent commenting once permanently vetoes the author's deletion, which is a cross-agent capability, not stranded data. D1 now operates on **tombstones** (`deleted_at`), not live rows |
| **D2** | C9 | `pinPost`/`unpinPost` are unlocked read-modify-writes that lose concurrent pins and can resurrect deleted post ids |
| **D3** | C10 | `createComment` accepts a `parent_id` from a different post — wrong-thread nesting, and the row class that breaks `deletePost` |
| **D4** | C11 | `saveEvaluationResult` is four auto-committed statements; proctored completion strands active sessions; non-Foundation evaluations are silently recorded as Foundation, and one school's definition can cease to exist in the database. **Narrowed 2026-07-25**: the duplicate-result and duplicate-certification-job slices moved to M11-1 as C21/C22 (they mint points and spend money — criterion 4), so D4 inherits their constraints and covers the remainder |
| **D5** | D5 | Playground episodic memories live in a process-local map even in DB mode — they vanish across instances and cold starts. **Gained 2026-07-25**: the actor-less ingest chunk id and the post-CAS reordering of playground derived writes, both moved out of M11-1's C12 |
| **D6** | D6 | Admissions offer/decline/accept transitions are non-atomic; the cycle cap is raceable; acceptance is not idempotent |

## Relationship to M11-1, M11-2, and M10

- **M11-1 ships first, and after round 7 nothing here is a prerequisite of anything there.** Two dependencies pointed the wrong way in earlier drafts and both are gone: M11-1's C14 referencing D4's restructured completion path (resolved by making C14's bootstrap CTEs self-contained, which they had to be anyway since Neon batches do not nest), and M11-1's C12 requiring D5's durable memories before reordering derived writes (resolved by *not* reordering them in M11-1 — see below). An ordering claim in either plan that points from M11-1 at a D-chunk is a bug in that document.
- **Two D4 slices moved to M11-1 (2026-07-25) because they failed criterion 4, not because they were urgent.** Duplicate completion mints points (`SUM(points_earned)` over a non-uniquely-indexed `registration_id`) and duplicate certification `start` spends real money. They ship as **M11-1 C21 and C22**, which land the unique `evaluation_results(registration_id)` index, the conditional transition-plus-insert CTE, the serialized points recompute, the partial unique live-job index (including `pending`), idempotent job creation, the `submitted → judging` CAS lease, token-fenced completion, and the reclaim dispatcher. **D4 does not re-specify any of that** — it inherits those constraints and covers what remains: proctored session-end atomicity, batchable activity dependencies, school-as-identity (the composite definition key and its expand/backfill/drain/contract rollout), the `startEvaluation` CAS, the per-element re-gating, PoAW challenge consumption, and the C0 report 6–12 remediations.
- **PoAW challenge consumption moves here with D4.** It folds into D4's completion batch (the executor becomes validation-only and threads its validated challenge id in). Until D4 lands, the executor-before-save burn window stays open and is a documented residual of M11-1.
- **D1 is blocked on OQ-1** (the karma model) — see D1. That decision is carried over from M11-1's open questions and is the reason D1 cannot simply be scheduled first.
- **D5 owns the reordering of playground derived writes, and now owns the actor-keyed ingest chunk id too.** M11-1's C12 leaves both out — the reordering because it needs D5's durable memories to couple the memory upsert to the winning CAS's `RETURNING` (reordering without that coupling trades a duplicate-write bug for a lost-write bug), and the chunk id because colliding ids corrupt derived vector data without paying any agent anything. Until D5 lands, a lease-expired resolver can still overwrite episodic memory and same-round actions still collide on one chunk id: both are documented residuals of M11-1's release gate 7.
- **M11-1's C3 no longer deletes playground sessions** (user decision 2026-07-25: cancellation became an attributed transition to a `cancelled` status carrying actor, reason, and timestamp). D5's cancellation fixture must therefore assert that memories are cleaned up on a *status transition*, not on a row disappearance — and the cancellation half of the deletion-cleanup family that this plan expected to inherit from C3 **does not exist**: nothing is deleted, so no projection is stranded.
- **M11-2** is the agentic-core rebuild; its extraction map records what both M11-1 and M11-1b satisfy. Where its problem statements describe pre-remediation code, they are historical context.
- **M9 invariants hold throughout**: `pickStore` dispatch, dual db/memory implementations, real `async function`s in memory stores, `sql.transaction` batches, append-only migrations registered in `scripts/migrate.js`.

## Locked decisions

These are inherited verbatim from M11-1 and are restated so this plan stands alone.

1. **Statement shapes.** Atomicity on the Neon HTTP driver is single-statement or batch, never interactive: (a) data-modifying CTEs; (b) `sql.transaction([...])` batches — a fixed array whose later elements **cannot** read an earlier element's `RETURNING`, and which do **not** nest; (c) `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` claims. Sibling CTEs share one snapshot. Millisecond env knobs never add directly to timestamps — use `make_interval`.
2. **No new public routes and no response-shape changes.** Fixes may reject what was previously (wrongly) accepted — each such rejection is enumerated in a gate — but never change a success shape. New tables only where a live defect cannot be closed without one; **D5's `playground_agent_memories` is the only one here**.
3. **Authorization derives from server-side rows, never from caller-supplied ids**, and runs before any side-effecting or expensive work.
4. **Both stores, every fix**, with every named gate running in both modes unless the gate is inherently DB-only (lock blocking, constraint races, migration behavior). Memory-mode discipline: throwing work before the mutation; and note that `await` inside a memory-store function is **not** atomic — concurrent promises interleave.
5. **Migrations fail loudly and are written fully idempotent.** M11-1's M11-1 C1 already hardened the runner (no recording on error, missing/empty files fatal, no swallow filter); this plan depends on that being in place and does not re-implement it.
6. **Deploy order is a correctness constraint.** D1 is destructive while old instances still run the buggy producers, so its barrier is mandatory.

## Prerequisites from M11-1

This plan assumes M11-1 has shipped, and specifically depends on:

- **M11-1 C0's integration harness** (`npm run test:integration`, disposable Neon branch with out-of-band disposability proof, both `pg` and Neon HTTP drivers, and a concurrency helper that can genuinely hold a lock — advisory-lock based, with a self-test, because a JS barrier around auto-committing Neon HTTP calls produces falsely green race tests). Gates marked `[integration]` below are unrunnable without it, and a mocked substitute does not satisfy them.
- **M11-1 C0's baseline reports.** Reports 2, 6–9, 11–13 feed chunks here; their exact queries, repair owners, and acceptance criteria live in M11-1 C0 and are not restated. (Reports 1, 10, and 14 moved to M11-1's own release gates with C21/C22/C23.)
- **C1's hardened migration runner.**
- **M11-1 C21's unique `evaluation_results(registration_id)` index and conditional completion CTE**, and **C22's certification job lifecycle** (partial unique live-job index, idempotent creation, judging CAS lease, reclaim dispatcher). D4 builds on these rather than re-specifying them.
- **M11-1 C20's single vetting/admission gate** — every route this plan touches obtains its agent through `requireAgent`, not `getAgentFromRequest`.
- **M11-1 C12's leased per-round playground resolution claim** (D5 couples its memory upsert to that claim's winning CAS).
- **M11-1 C3's cancellation transition** (D5's cancellation fixture; note it transitions rather than deletes).
- **M11-1 C25's post tombstones.** D1 no longer starts from a live row that cannot be deleted; it starts from a row already flagged `deleted_at` and invisible to readers. That changes D1's shape in three ways worth stating before it is written: the **anti-veto urgency is gone** (authors can already delete, in the sense users mean), so D1 is free to sequence the projection cleanup carefully; the **FK problem is no longer blocking** but still must be solved for hard deletion, and D1 may legitimately decide tombstones are the permanent answer and hard deletion unnecessary; and **OQ-1 still blocks the vote-reversal half only** — with tombstones live, D1 can ship projection cleanup before the karma model is decided, which it could not before.

## HOW TO EXECUTE A MILESTONE

[Please include what follows verbatim when you write a PLAN_M{n}.md file. It will be used to guide anyone who executes on your plan.]

If the user asks you to execute on a plan, these are the steps to take.

1. Implement the plan
   - You should check your work with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of user interaction, preferably none at all.
   - Once it is complete, fill in the "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
   - You might have discovered better engineering
2. Perform your testing and validation
   - Update the "AI VALIDATION RESULTS" section of your PLAN_M{n}.md file
3. Review your own code. Also, ask Claude to review your work
   - You will need to provide it contect: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Claude found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan no successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. If any information there is just restating information from other files then delete it. If it would belong better elsewhere, move it. Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
   - You will have several Claude review tasks to do, below. You must launch all the following Claude review tasks in parallel, since they each take some time: prepare all their inputs, then execute them all in parallel. You should start addressing the first findings as soon as you get them, rather than waiting for all to be consolidated. You can be doing your own review while you wait for Claude.
   - (1) Review the code for correctness. Also ask Claude to evaluate this.
   - (2) Validate whether work obeys the codebase style guidelines in AGENTS.md. Also ask Claude to evaluate this. The user is INSISTENT that they must be obeyed.
   - (3) Validate whether the work obeys each learning you gathered in LEARNINGS.md. Also ask Claude to evaluate this. (A separate instance of Claude; it can't do too much in one go).
   - (4) Validate whether the work has satisfied the milestone's goals. Also ask Claude to evaluate this.
   - (5) Check if there is KISS, or consolidation, or refactoring that would improve quality of codebase. Also ask Claude the same question.
   - If you make changes, they'll need a pass of static checking (formatting, eslint, typechecking), and again to make sure it's clean.
   - You might decide to do better engineering yourself. If not, write notes about whats needed in the "BETTER ENGINEERING INSIGHTS" section of the plan.
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for

## PLAN

Findings verified against source across five adversarial review rounds (2026-07-24). Line numbers drift; re-anchor with `rg` before editing.

### D1 (was C8) — `deletePost`: dependency chain, projection cleanup, reconciliation

- Problem: `comments.post_id`, `post_votes.post_id`, and `comment_votes.comment_id` are FKs with **no** `ON DELETE CASCADE` (`scripts/schema.sql`), so today's bare `DELETE FROM posts` (`posts/db.ts`) fails on any post with comments or votes — engaged posts are undeletable via both surfaces. Legacy cross-post replies (see D3) additionally break the comment cleanup via the `comments.parent_id` self-FK. Posts that do get deleted leave activity rows, cached contexts, search text, and notifications public with dead links (`activity_events` has no FK to posts). The REST path runs `cleanupPostVectorsForAudience` pre-delete; the tool path silently skips it — live drift.
- Remedy: one shared domain helper (`src/lib/post-deletion.ts`) that both the route and the tool call — it computes the audience pre-delete, runs the store's batched delete, then the existing best-effort vector cleanup (M11-2's P1.1 turns this helper into the `deletePost` action). The store delete is a `sql.transaction` batch that **locks first, cleans second**: statement 1 authorizes and `FOR UPDATE`-locks the post row; statement 2 locks the post's existing comments; then the cleanups, then the post delete. Lock order is load-bearing: cleanup-before-lock would let a concurrent vote/comment slip in after its cleanup statement ran but before the post lock, orphaning a row or aborting the batch on FK.
  **Per-statement authorization anchors are target-specific — the generic `WHERE post_id IN (…)` template does not compile for half of them** and is spelled out here so an executor does not have to invent it. Batch elements cannot read one another's `RETURNING`, so every element re-derives authorization from the post row: comments and post votes anchor directly (`WHERE post_id IN (SELECT id FROM posts WHERE id = $post AND author_id = $agent)`); **comment votes** have no `post_id` (`schema.sql:133`) and anchor through the authorized post's comments (`WHERE comment_id IN (SELECT c.id FROM comments c WHERE c.post_id IN (<authorized post subquery>))`); the **cross-post reply detach** deliberately matches rows with `post_id <> $post`, so it anchors on the *parent* side instead (`WHERE parent_id IN (SELECT c.id FROM comments c WHERE c.post_id IN (<authorized post subquery>)) AND post_id <> $post`); **pins** anchor through the authorized post's group; **notifications** store references in JSON (`schema.sql:493`) and anchor on `metadata->>'post_id' = $post` **plus** an `EXISTS` against the authorized post subquery; **activity rows and cached contexts** anchor the same way (post kind by entity id, comment kind by `metadata->>'post_id'`).
  **Vector cleanup is improved, not completed — and the plan says which.** `cleanupPostVectorsForAudience` recomputes the *current post* audience (`platform-ingest.ts:142`), but ingestion recorded the audience **as it was at ingestion time** (`platform-ingest.ts:28`) and comment ingestion always includes the comment's author (`:40`) while commenting does not require group membership (`posts/[id]/comments/route.ts:46,81`). So the helper computes an **explicit recipient union** — the post audience plus every distinct comment author, uncapped — which closes the nonmember-commenter case. **Two residuals remain and are deferred under criterion 2, not claimed closed**: (a) agents who received the content and *later* left the group or unfollowed are absent from any recomputed audience, and (b) ingestion is fire-and-forget scheduled *after* the DB call returns (`posts/[id]/comments/route.ts:81`), so a late ingest can write vectors after deletion completes. Both need the **ingest recipient ledger** (who actually received each chunk) that M11-2 names as backlog and itself acknowledges as an open residual — M11-1's claim is therefore "parity plus the commenter gap", never "full cleanup".
  **Deleting an engaged post must not become a karma-farming primitive — and closing that hole is not possible against today's schema, which makes OQ-1 a hard precondition of D1.** Vote points are persisted to `agents.points` and house points at vote time (`posts/db.ts:159`, `:188`; comment votes award each *comment* author, `comments/db.ts:120`), and public attribution derives known components from *surviving* posts and comments (`agent-public.ts:50`). Today the FK accidentally prevents abuse: a voted post cannot be deleted at all. Once D1 makes it deletable, collaborators could upvote, the author could delete the evidence, and the points would become `legacy_unattributed` — repeatably.
  The obvious remedy — "reverse the deltas the deleted votes awarded" — **cannot be implemented correctly**, and the reason is worth stating so no executor tries: `post_votes` records only `vote_type`, never the delta actually awarded (`scripts/schema.sql:122-139`). A downvote cast while the author sat at zero awarded **0**, not −1, because the write floors at `GREATEST(0, points - 1)`; reversing that row would *add* a point, so repeated zero-floor downvotes plus deletion become a point-manufacturing primitive — a worse exploit than the one being closed. And because evaluation completion **overwrites** `agents.points` wholesale (`evaluations/db.ts:594`), subtracting an old upvote after an evaluation has landed removes *evaluation* points instead.
  **Therefore D1 is blocked on OQ-1.** Under the component model (OQ-1 option b) the reversal is well-defined — decrement `vote_points`, which no evaluation write touches — and D1 proceeds with per-author reversal covering post authors, every affected comment author, and house totals. Absent that decision, the only safe forms are (i) ship D1 without reversal **and accept the farming hole as a known regression**, or (ii) tombstone content while retaining attribution. Neither is acceptable silently, so **D1 does not ship until OQ-1 is answered**; the rest of the milestone is unaffected.
  Plus one **idempotent reconciliation sweep** (one-off script, sized by M11-1 C0's orphan report, documented in the runbook): deletes activity rows, cached contexts, and notifications whose subject no longer exists and strips nonexistent ids from every group's `pinned_post_ids`; re-runnable.
- **Rollout barrier (Locked decision 6):** D1's cleanup is destructive while old instances still run the unlocked pin (D2) and the unvalidated comment parent (D3). Deploy order is **D2 and D3 first, drain, then D1, then the reconciliation sweep** — otherwise an old pin can re-insert a deleted id after the sweep, and an old cross-post reply can be created after the detach. The sweep is re-runnable precisely so a post-barrier second pass closes the window.
- Gate (**both store modes** — the memory delete removes only the post today, `posts/memory.ts:209`, so the full fixture suite runs there too; `[integration]` for the lock races): delete tests for voted, commented, and pinned posts; legacy cross-post reply fixture — the delete succeeds and the external child survives with `parent_id` nulled; unauthorized-delete test — a non-author delete changes no dependent row and no pin; deleted post's and its comments' activity rows, cached contexts, and notifications are gone; **nonmember-commenter vector test** — a commenter who is not in the post's group has their vectors cleaned; **former-recipient fixture** — an agent who left the group before deletion is asserted to *still* retain vectors, pinning the documented residual so a future reader does not mistake it for a bug; **delete-vs-late-ingest race** — asserted and recorded as the second documented residual, not as a passing cleanup; **delete-after-vote test** — deleting an upvoted post reverses exactly the points it awarded, in both agent and house totals; **repeat-farming test** — vote → delete → repeat leaves the author's points unchanged across cycles; tool-path delete runs the vector cleanup with the same recipient set as the route (parity spy test); reconciliation test — seeded orphans are gone after the sweep and re-running it changes nothing.

### D2 (was C9) — `pinPost`/`unpinPost`: locked single-statement writes

- Problem: both are unlocked read-modify-writes of the group's `pinned_post_ids` JSONB that never lock the post (`posts/db.ts`) — a pin can read a live post, race past `deletePost`'s cleanup, and write the deleted id back; two concurrent pins lose one another's updates.
- Remedy, **asymmetric by design**. `pinPost` becomes one CTE statement taking `FOR KEY SHARE` on the live post (serializing against D1's `FOR UPDATE` — a pin blocked by an in-flight delete resolves `not_found` once it commits), with the group row's array mutated by a single conditional JSONB append-if-absent under the 3-pin cap. **`unpinPost` must not require a live post**: today it needs only group authorization (`posts/db.ts:409-415`), which is exactly what lets a moderator clear a stale id left behind by an older delete — adding a live-post lock would make orphaned pins unremovable except through D1's sweep, a regression this chunk would otherwise introduce. Unpin stays an authorized atomic array removal whether or not the post exists. **Authorization moves into the decisive statement for both**: `getYourRole` is a separate pre-check today (`posts/db.ts:395`, `:410`), so a moderator revoked between check and update can still act. The `UPDATE groups … RETURNING` carries the owner/moderator predicate against the group row — and, for pin only, references the locked-post CTE so it cannot be optimized away. Memory store mirrors semantics.
- Gate (both store modes; `[integration]` for the races): concurrent pin-vs-delete — no deleted post id survives in `pinned_post_ids` (the pin lands first and the delete's cleanup removes it, or it blocks and resolves `not_found`); two concurrent distinct pins both persist; **stale-id unpin test — a pinned id whose post no longer exists is still removable** (the behavior D2 must preserve); **revoke-vs-pin race** — a moderator revoked after the friendly pre-check cannot pin or unpin; cap enforced in-statement (a 4th pin rejected with the existing error).

### D3 (was C10) — `createComment`: same-post parent validation, inside the insert

- Problem: `createComment` inserts before it ever looks the parent up (`comments/db.ts:31` insert, `:50` parent lookup for the notification), so a reply can nest under a comment on a *different* post — wrong-thread nesting for readers, and the fixture class that breaks `deletePost` (D1's detach handles existing rows; this stops new ones).
- Remedy: **one `INSERT … SELECT` anchored on the target post and the same-post parent**, with the post taken `FOR KEY SHARE` so the validation cannot race a concurrent `deletePost` into a 23503/500 — a separate "validate then insert" pair would reintroduce exactly that window. Zero inserted rows classify as `not_found` (post gone) or the stable parent-validation error. **The lock must not be released at the insert**: on this driver each `sql\`\`` call auto-commits, so an insert-only statement frees the post before the comment counter, rate-limit state, activity row, and notification are written (`comments/db.ts:30-61`) — D1 could then delete and finish its cleanup in that gap, and the notification insert (which has no post FK, `notifications/db.ts:22`) would recreate a dead link. All **relational** comment effects therefore go in one `sql.transaction` batch beginning with the post lock, every later statement gated on the returned comment id and the authorized post. External vector scheduling stays outside the batch and inherits D1's documented late-ingest residual. Both stores.
- **Precedence, stated honestly.** Both callers check the rate limit *before* parsing `parent_id` (`posts/[id]/comments/route.ts:59` vs `:75`; `agent-tools/definitions/comments.ts:70`), so a rate-limited caller with an invalid parent gets the rate-limit shape today. Rather than promise a precedence the code does not have, D3 **moves syntactic and parent validation ahead of the rate-limit check in both callers** — cheap, no state touched — and only then does the promise "invalid parent ⇒ validation error, never a rate-limit shape" hold. Both are enumerated behavior corrections per Locked decision 2.
- **Deploy order:** D3 ships **before** D1's reconciliation sweep, so the corrupt-producer class is frozen before the cleanup runs.
- Gate (both store modes; `[integration]` for the races): cross-post parent rejected with the validation error via route and tool; **rate-limited caller with an invalid parent gets the validation error**, not the 429; **parent-deleted-mid-insert race** resolves as a clean validation error with no 23503 leak; **delete-vs-comment-effects race** — a post deleted immediately after the insert leaves no orphaned notification, activity row, or counter delta (the batch, not just the insert, is protected); same-post replies unchanged; no new cross-post rows creatable.

### D4 (was C11) — Evaluation completion atomicity + duplicate-result index (depends on M11-1 C1)

- Problem: `saveEvaluationResult`'s sequence (result insert, registration update, points recompute, activity — `evaluations/db.ts`) auto-commits each step: a crash between them leaves inconsistent domain state. The unconditional insert-then-update can be raced by route vs tool, writing **two results for one registration** (`evaluation_results.registration_id` carries only a non-unique index). Proctored completion calls `saveEvaluationResult` then `endSession` (`proctor/submit/route.ts:111`, end call at `:125`) — a failure between them strands a completed registration with an active session. Certification reads `submitted`, unconditionally marks `judging`, runs inference, marks `completed`, and *only then* saves the result (`judge.ts:186,212,227,235`) — so a failed save leaves a terminal job with no result, and **two judges can both pass the pre-read and run inference**, with a delayed loser overwriting a completed job back to `judging`/`failed`.
  **A fourth, separate live corruption: school scope is silently lost.** The submit routes load a school-scoped definition (`submit/route.ts:31`, `proctor/submit/route.ts:29`) but omit `schoolId` and version when saving (`:155`, `:111`); result-field derivation reloads the **Foundation** definition (`result-fields.ts:24`) and the save defaults the result's school to Foundation (`evaluations/db.ts:353`); registration creation omits the existing `school_id` column entirely (`evaluations/db.ts:76`, column at `scripts/migrate-schools.sql:43`). A live non-Foundation evaluation — e.g. the 15-point finance assessment (`schools/finance/evaluations/SIP-F1.md:3,8`) — is therefore recorded as Foundation and can score zero.
- Remedy, in four parts:
  1. **Atomic completion.** `saveEvaluationResult` becomes one `sql.transaction` batch whose decisive mutation is a conditional registration transition — `UPDATE evaluation_registrations SET status = … WHERE id = $reg AND status IN ('registered','in_progress') RETURNING id` (allowlist form; `NOT IN` would admit `cancelled`) — with the result insert gated on that transition in the same CTE element. **A zero-row transition is a loser and must surface as a stable error**, never a fabricated success id. Proctored completion's session-end joins the batch.
  2. **Points, serialized on the agent row.** The recompute is a total `SUM` over `evaluation_results` followed by an agent update (`evaluations/db.ts:581,594`). Making it a later batch statement fixes only self-visibility; **two concurrent completions for the same agent on different registrations each sum a snapshot excluding the other and the last writer wins**, losing points permanently. The batch therefore takes `FOR UPDATE` on the agent row as its first statement, before the result insert and recompute, so same-agent completions serialize.
  3. **Batchable dependencies.** The current helpers cannot be dropped into a fixed Neon transaction array: the activity upsert and its cache invalidation are two separate calls (`activity/events.ts:151,167`) and evaluation-activity errors are swallowed (`:427`). Expose them as **prepared query objects** the batch can carry as elements. Certification gets a **CAS on `submitted → judging` before inference** (not an unconditional mark), and its final job transition is conditioned on the winning result.
  4. **School becomes part of evaluation identity — starting with the definition row itself.** Threading `school_id` through registrations and results is necessary but insufficient, because the corruption starts upstream: `evaluation_definitions.id` is a **global primary key** (`schema.sql:175`) and the sync upserts on `id` while overwriting `school_id` (`evaluations/sync.ts:49,62`), so when two schools ship the same evaluation id — and they do: both Foundation and Humanities ship the persisted `evaluation_id` **`twitter-verification`** (`schools/foundation/evaluations/SIP-4.md:2`, `schools/humanities/evaluations/SIP-4.md:2` — "SIP-4" is the human file label, not the id that collides in the database) — **whichever school syncs last wins and the other school's definition ceases to exist in the database**. A test built on the filesystem loader would pass while the DB is corrupt. So this chunk gives definitions a **composite `(school_id, id)` primary key — chosen here, not left as an either/or**, because AO already queries definitions by both (`store/ao/db.ts:323`) and a surrogate key would require rewriting every dependent FK for no added benefit. **The rollout is expand/backfill/drain/contract, because migrations run before the new build** (`package.json:7`) and old instances keep doing `ON CONFLICT (id)` with unscoped prerequisite deletes (`evaluations/sync.ts:49-90`) — dropping global `id` uniqueness in the same deploy would break them instantly. Deploy 1 adds the composite key **alongside** the existing global unique constraint and backfills; deploy 2 ships school-aware dual reads/writes; old instances drain; deploy 3 replaces **every** dependent FK and only then drops or promotes the old primary key. **The dependent inventory must include the two the earlier draft missed**: `evaluation_sessions`, which persists an unscoped `evaluation_id` and whose authorization compares only that string (`scripts/migrate-multi-agent-sessions.sql:4`, `evaluations/[id]/sessions/[sessionId]/route.ts:20`) — sessions derive identity through their registration or gain their own `school_id` — and `ao_company_evaluations`, which carries a real FK to the global definition id (`scripts/migrate-ao-stanford.sql:55`). Alongside those: definitions, prerequisites, registrations, results, participants, certification jobs. **The expand step adds a composite UNIQUE constraint after backfill and `NOT NULL`, not a second primary key** — `evaluation_definitions.id` is already `TEXT PRIMARY KEY` (`scripts/schema.sql:175`) and a table cannot carry two, at which point same-id cross-school rows become possible. A maintenance window is the documented alternative. Then thread trusted school through every registration/result/job lookup, **changes the active-registration index to include school** (`schema.sql:212` is `(agent_id, evaluation_id)` today, so one agent cannot hold active registrations in two schools), returns and filters result school (`evaluations/db.ts:442`, `results/route.ts:25`), and makes certification load its rubric **from the registration** before inference (`judge.ts:201` loads Foundation before it has even fetched the registration). No caller-supplied school is trusted (Locked decision 3).
  5. **Lifecycle writers that can undo the decisive transition.** `startEvaluation` reads `registered` then updates unconditionally (`start/route.ts:32`, `evaluations/db.ts:322`), so a concurrent submit can complete first and a stale start drags the registration back to `in_progress` — it becomes a CAS. **The certification-job half of this item shipped in M11-1 C22** (partial unique live-job index including `pending`, idempotent creation, `submitted → judging` CAS lease with `claim_token`/`claim_expires_at`, token-fenced completion, and the fail-closed reclaim-and-dispatch entry point on C13's cron path). D4 does not re-specify it; D4's completion batch simply must not violate it.
  6. **Every later batch element gates on the winning result.** Fixed Neon batch elements execute even when the decisive element returned zero rows, so a *losing* completion could still end the proctor session — `endSession` is an unconditional update by session id today (`evaluations/db.ts:302`). Each subsequent write therefore carries `EXISTS (SELECT 1 FROM <the app-generated result id>)`, the same per-element re-gating D1 uses.
  **The unique index on `evaluation_results(registration_id)` shipped in M11-1 C21** (with the `SHARE` lock held to commit, the loud preflight, and the postcondition block), together with the conditional transition-plus-insert CTE and the serialized points recompute. D4 inherits the constraint: its batch must satisfy it, and the C0 report 1 remediation is already done. **No house-points write is added** — `recalculateHousePoints` is a read-only legacy shim. Memory store mirrors the transition gate, the agent-row serialization (trivially, single-threaded), and the school persistence.
  **Lock order compatibility.** This batch already locks the agent row before the result insert (part 2 above). M11-1 C14's vetting completion uses the **same global order — agent row first, then challenge row** — so the two can never deadlock against each other when a PoAW submission and a vetting completion race for one agent.

  **PoAW challenge consumption is part of this batch** (one instruction, stated here; M11-1 C14 points at it rather than restating it): the executor becomes validation-only and threads the validated challenge id into this batch, which consumes it token-fenced alongside the winning result. Today it consumes before the route saves (`evaluations/executors/poaw.ts:73-82`, `evaluations/[id]/submit/route.ts:142`), so a crash between them burns a valid challenge.
- **Data remediation is part of this chunk, not an afterthought.** C0 reports **6–9, 11, and 12** cover every inconsistent state this chunk's problem statement implies already exists. (Reports **1** — duplicate results — and **10** — multiple live certification jobs — moved to M11-1 with C21/C22 and are already repaired by the time this chunk runs, including the points recomputation report 1's acceptance criterion requires; D4 must not repeat either repair.) Each remaining report has a documented idempotent repair: status reconciliation for the stranded pairs, and — where consolidation still applies — **deletion of the discarded results' activity rows and cached contexts** (evaluation activity keys on the result id, `activity/events.ts:407`, with no FK, so consolidation alone would leave dead links).
  **School repair is only partly automatable, and the plan says so rather than promising a clean sweep.** The schools migration defaulted *both* registration and result to Foundation (`scripts/migrate-schools.sql:39`), so for an evaluation id that exists in exactly one school the true school is recoverable and repaired automatically; for an id that exists in **several** schools (SIP-4 does) the historical row is genuinely ambiguous and **no derivation can recover it**. Those rows go into an explicit report for a human decision — never auto-assigned. Repairs run before the unique-index migration and are re-runnable.
- Gate `[integration]` for every race and migration item: concurrent route-vs-tool completion ⇒ exactly one result and a stable loser error (no fabricated id); **concurrent completions for one agent on two different registrations ⇒ both results' points present** (agent-row serialization); **concurrent judges ⇒ one inference-to-completion path, and a delayed loser cannot move a completed job back to `judging`/`failed`**; proctored-completion failure injection — no committable state has a completed registration with a still-active proctor session; certification failure injection — a failed result save leaves the job un-completed and retryable; **activity-query failure injection — a failing activity element fails the batch rather than being swallowed**; first-evaluation points test; **non-Foundation school-persistence test at the store level** — a non-Foundation evaluation records its own school and its real points, not Foundation's zero fallback. **Deliberately store-level, not end-to-end through the route**: the active Finance evaluation names handler `default` (`schools/finance/evaluations/SIP-F1.md:7,10`) and no `default` handler exists in the registry (`evaluations/executor-registry.ts:13`), so the route returns 500 — that evaluation is already user-visibly broken. The missing generic rubric executor is **deferred under criterion 3** (it is a product gap, not a defect this milestone introduced) and recorded in the deferral table; the end-to-end variant of this gate uses an AO certification with a mocked judge instead; completion from `cancelled`/`completed`/`failed` source states rejected with no result; **start-vs-submit race** — a stale `startEvaluation` cannot move a completed registration back to `in_progress`; **regression gates for the constraints inherited from M11-1** (not re-implementations of C21/C22's gates — these assert D4's new batch does not violate them): D4's completion batch writes exactly one result per registration under the C21 index, and its certification path creates no second live job under C22's partial index; **cross-school identity tests** — a **sync test proving two same-id definitions from different schools coexist in the database** (the upstream corruption, not just the downstream threading), one agent holding simultaneous active registrations for that id in both schools, and each school's results list returning only its own; **completion-loser test** — a losing completion changes neither the proctor session nor any job or activity state; each remediation script is idempotent (re-run changes nothing), leaves no dead activity row, and **auto-repairs only uniquely attributable schools**, reporting ambiguous ids for manual decision.

### D5 (was C15) — Durable playground episodic memories

- Problem: the same failure model as M11-1 C14's vetting challenges, in a second place. `src/lib/playground/memory.ts:13` keeps per-agent episodic memories in a **process-local map even in DB mode**; round resolution writes them (`session-manager.ts:909`), the engine reads them for retrieval, and the public session response **advertises whether they are available** (`playground/sessions/[id]/route.ts:94`). A later request served by another instance, or after a cold start, sees them silently vanish — so the plan's claim that exactly one process-local map qualified as a live defect was wrong.
- **Two items moved here from M11-1's C12 (2026-07-25), both of which need this chunk's table to be fixable:**
  1. **Actor-keyed ingest chunk ids.** The hash is `sha256(sessionId|round|kind|chunkIndex)` with **no actor** (`platform-ingest.ts:121`), so same-round actions by different agents collide on one chunk id and overwrite each other in every recipient's vector store. The fix derives the id from the stable `playground_actions` row id — `submitAction` captures the `SessionAction` id it currently discards and threads it into the ingest call. C12's delegation work (the tool now goes through `submitAction`) is the precondition, and it ships in M11-1. Vectors already stored under the collision-prone keys stay in place; per-recipient cleanup needs the ingest recipient ledger, a named M11-2 backlog item.
  2. **Post-CAS placement of derived writes.** Today resolution schedules vector ingestion and persists participant memories *before* advancing (`session-manager.ts:602-640`, memory writes with embeddings at `:909-937`), so a resolver whose lease expired still overwrites per-agent memory and writes vectors even though its CAS fails. Moving those writes after the winning CAS is only safe once the memory upsert can be **gated directly on that CAS's `RETURNING` in one data-modifying CTE** — which requires the durable table this chunk adds. Without the coupling, a crash immediately after a post-CAS advance would permanently lose that round's episodic memory, since the retry sees an advanced round and never re-enters: a lost-write bug traded for a duplicate-write bug. Idempotency keys carry session, round, and the **winning** token, which is what makes the loser inert. External vector ingestion cannot join the transaction and stays an **explicit best-effort residual**.
- Remedy: lift **M11-2's P7.2 design verbatim** (it is already written and reviewed, and requires no events, action layer, consumer, or worker): `playground_agent_memories(id TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, agent_name TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES playground_sessions(id) ON DELETE CASCADE, content TEXT NOT NULL, importance TEXT NOT NULL, round_created INT, embedding JSONB, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (agent_id, session_id))` behind `pickStore`, memory impl = today's map. **Semantics preserved exactly**: one record per (agent, session) overwritten each round, `importance` storing the existing `low | medium | high | critical` label verbatim, every field round-tripping. The module's function surface becomes async store calls; the vector ingest path (`platform-ingest.ts`) is untouched — the two memory systems keep their existing separation. M11-2's P7.2 is then marked satisfied.
- Gate `[integration]` for persistence: session memory survives a simulated restart (fresh module registry, db mode) and is readable from a second store handle; overwrite-per-round semantics preserved (round N replaces round N−1); **session cancellation and agent deletion leave no orphaned memory rows in both modes** — note that after M11-1 C3, cancellation is a *status transition*, not a delete, so the db-mode cascade no longer fires on it and memory cleanup must be driven explicitly by the transition in **both** stores (agent deletion still cascades in db mode; memory mode needs the already-existing-but-uncalled `clearSessionMemories`, `lib/playground/memory.ts:173-178`, plus a new `clearAgentMemories`, wired into `store/playground/memory.ts:112-114`); **multi-participant same-round ingest fixture — every action produces a distinct chunk id on both the route and the tool surface**, and GM/summary (non-action) chunk derivation is unchanged; **lease-expired-loser test** — a resolver whose CAS fails writes **no** memory and schedules **no** ingestion, which is the defect the reordering closes and which cannot be observed before this chunk's table exists; engine behavior tests green.

### D6 (was C18) — Admissions state-machine transitions are non-atomic

- Problem: the admissions flow commits every transition as several independent statements, on live agent- and staff-facing routes.
  1. **Staff offer creation** checks the cycle cap, inserts the offer, updates the application, and writes audit separately (`admissions/store-db.ts:296-338`), with **no unique pending-offer constraint** (`scripts/migrate-admissions.sql:41-58`). Concurrent staff requests can exceed the cycle cap or leave one application holding several pending offers; a crash splits offer/application/audit.
  2. **Declines** — both the agent route (`api/v1/admissions/decline/route.ts:29-41`) and the dashboard route (`api/dashboard/admissions/decline/route.ts:28-43`) — run three independent commits (`store-db.ts:479-513`), with no condition that the offer is still pending or that the actor owns it.
  3. **Acceptance is not idempotent** while awaiting human approval: each repeated call rewrites `accepted_at_agent` and appends another audit row (`store-db.ts:426-446`).
- Remedy — **one data-modifying CTE per transition, never a fixed batch array whose later elements observe final row state.** That distinction is the whole fix: acceptance already runs as a Neon transaction array today, and its audit element checks only whether the timestamp is non-null (`store-db.ts:431`), which stays true on retry — so another audit row appends. A later fixed element cannot tell whether *this* invocation won. Instead the conditional update's `RETURNING` drives the application update and the audit insert **in the same statement**; zero returned rows is the loser/no-op.
  - **Offer creation locks the cycle row — mandatorily, not "cycle or application".** An application lock cannot serialize a cycle-wide cap across *different* applications. Lock the cycle, then the application, in that fixed order. **Atomically expire stale pending offers before counting**, because the cap counts every `status='pending'` row as live (`store-db.ts:278`) while creation never refreshes expired ones (`admissions/index.ts:89`).
  - The structural backstop is a **partial unique index on `agent_id WHERE status='pending'`** — matching today's actual invariant (the code prohibits any pending offer for an agent, `store-db.ts:305`). A per-application index would silently *weaken* that across cycles, which is a product change and not this chunk's to make.
  - **Declines: correcting my own problem statement** — ownership and status *are* checked today (`store-db.ts:479`, `:495`); the defect is that the decisive updates are unconditional and separately committed (`:482`). So the checks move **inside** the decisive predicate and the three writes become one gated statement.
- **C0 gains report 13** (pending-offer collisions and stale-pending rows per agent) — existing duplicates would otherwise fail the index migration — and this chunk needs an **old-instance drain barrier**, since old code ignores the new cycle lock.
- Gate (`[integration]` for the races): concurrent staff offers cannot exceed the cycle cap and cannot create two pending offers for one agent; expired pending rows do not consume cap; failure injection leaves no offer/application/audit split; a decline by a non-owner or against a non-pending offer changes nothing; **repeated acceptance writes one timestamp and exactly one audit row**; existing admissions tests green.
- **Memory-mode gate, honestly scoped:** memory admissions state has no audit representation at all (`admissions/store-memory.ts:13`) and acceptance writes none (`:336`), so "exactly one audit row in both modes" is unwritable as stated. This chunk adds an in-memory audit projection with a test accessor; and because memory offer creation `await`s the cap count before mutating (`:278`), concurrent promises interleave — "single-threaded" is not atomic across `await` — so preflight and mutation go in one synchronous non-awaiting section (or behind a keyed mutex), with an interleaving gate.


### Recommended execution order

1. **D3**, **D2**, **D5** in parallel — all are producer-side or additive, none destructive.
2. **D4** (migrations; after its C0 reports are clean) and **D6** (after its C0 report 13 is clean). Both need an old-instance drain barrier of their own — D4 because its school-identity change is expand/backfill/drain/contract, D6 because old code ignores the new cycle lock.
3. **Barrier** — old instances drain. D2's locked pin and D3's parent validation only hold once every instance runs them.
4. **D1** — blocked on OQ-1 (see D1). When unblocked: the destructive delete + cleanup, then D1's reconciliation sweep, then the **global cross-post reply repair** (D3 must already be deployed so the producer is frozen), then a **second sweep pass** to close the mixed-version window.

D1 is deliberately last: it is the only chunk that deletes data, and both D2 and D3 must be frozen first or its cleanup races them.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

Per-chunk gates (every chunk): lint (complexity warnings not increased), `tsc --noEmit`, `npm test -- --runInBand`, `npm run test:integration` against the guarded disposable branch for every `[integration]` gate, `npm run build` against that same branch for store-touching chunks — plus the chunk's named tests in **both** store modes.

Release gates:

1. **Atomicity**: no committable partial state in D1 (delete), D4 (completion), or D6 (admissions transitions) under failure injection; every concurrency gate green, including the two-connection ones (D2 pin races, D4 same-agent completions and concurrent judges, D6 concurrent staff offers).
2. **Data remediation**: every C0 report this plan owns has a documented idempotent repair that has been run and re-run with no second-pass change, leaves no dead activity row or cached context, and **auto-repairs only uniquely attributable rows** — ambiguous ones (notably the `twitter-verification` school collision) are reported for manual decision, never assigned.
3. **Migrations**: every schema-bearing chunk — D4 (**composite definition identity**; result uniqueness and the partial live-job index shipped in M11-1 C21/C22), D5 (`playground_agent_memories`), D6 (partial pending-offer index) — passes through the real hardened runner on clean **and** relevant partial fixtures, with explicit postconditions asserting tables, columns, indexes, FKs, and defaults.
4. **Rollout**: D4's expand/backfill/drain/contract sequence and D6's drain barrier were observed; D1's sweep ran only after its producers were deployed and drained, and the post-barrier second pass is recorded as having changed nothing (or its deltas are explained).
5. **No regressions**: full suite green; response shapes unchanged except the enumerated corrections (D3 cross-post parent + validation-before-rate-limit); `npm run build` green.

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

### D3 — `createComment` same-post parent validation ✅ *(landed 2026-07-31)*

**The store** (`comments/db.ts`): `createComment` became one `sql.transaction` batch whose first
element takes the post lock (`FOR SHARE`) and **holds it to commit** — the pre-D3 shape freed the
post the moment the insert auto-committed, so a concurrent delete could finish its cleanup before
the counter and the notification landed (notifications carry no post FK), recreating dead links.
The decisive statement answers four questions at once via CTEs: post live (C25's tombstone lock),
**parent is a comment ON THIS POST** (`parent_ok` — the new D3 gate, a `UNION ALL` of "no parent"
and "parent joined to the live post"), the C16 quota claim (gated on `parent_ok` so an invalid
parent costs no allowance), and the insert. Every later element (counter, `last_active_at`, the
recipient-derived notification) re-gates on `EXISTS (SELECT 1 FROM comments WHERE id = $id)`. A
23503 from a parent hard-deleted between the snapshot read and the FK check is caught and returned
as the same clean refusal, not a 500. Memory mirrors it: parent validated before the quota claim,
one synchronous section. The comment **activity** event stays a post-commit follow-up (its writer
is an upsert + cache-invalidation pair behind one helper; making it a batch element is D4's
"batchable dependencies", not D3's — a dead activity row from an adjacent delete is D1's sweep's).

**Both callers** (route + tool) now validate the parent **before** the rate-limit check — the pre-D3
order gave a rate-limited caller with an invalid parent the rate-limit shape, promising a
precedence the code did not have. Stable code `invalid_parent`; both are enumerated behavior
corrections (Locked decision 2).

**Gates.** Memory (4 green in `d3-parent-validation.test.ts`): cross-post parent rejected with no
quota burned and nothing written; nonexistent parent rejected; same-post reply unchanged;
**rate-limited-caller-with-invalid-parent gets `invalid_parent`, never the 429** via the tool;
cross-post via the tool with the same code. Integration (4 green in `d3-comment-parent.test.ts`):
cross-post parent writes nothing / costs no quota / fabricates no notification; a same-post reply
lands with its counter, quota claim, and reply notification **in one commit**; **parent
hard-deleted mid-insert resolves as a clean refusal, not a 23503 leak**; **delete-vs-comment race
— a post soft-deleted mid-flight admits nothing** (no comment, no counter, no notification), the
batch (not just the insert) protected, observed via `pg_blocking_pids` on the batch's opening post
lock. The C16 and C25 suites' comment-race markers were re-pointed to the batch's `d3:comment-post-lock`
marker (the block now happens at the batch's first statement). Suite-wide: unit 117/765,
integration 20/176, `tsc` clean, lint 93 (two D3 extractions paid: `writeComment` in the route,
`notifyCommentTarget` in the memory store).

**Amended after review round 10 (2026-07-31):** the comment **activity row is now a batch
element**, not a post-commit follow-up. The first draft deferred it to D4's "batchable
dependencies" work; the reviewer refused that reading of D3's own gate ("comment counter,
rate-limit state, activity row, and notification" in one transaction) and was right — a
post-commit upsert can land after a concurrent delete released the post lock and project a dead
`/post/...` event. `buildCommentActivityUpsert` in `store/activity/events.ts` exposes the writer
as a **prepared query** (the D4 technique, borrowed early rather than forking the SQL) with a
`requireCommitted` join gating it on the comment row and `p.deleted_at IS NULL` on the post join;
only the cache invalidation stays post-commit, because invalidating for a rolled-back transaction
would be wrong. Memory mode re-checks the post before each projection. Three added gates: the row
is present immediately after the call, a quota-refused comment writes none, and the delete race
leaves none.

**Deploy order** (D3 before D1's sweep) is a runbook constraint, not code — recorded for step-4
of the M11-1b execution order.

### D2 — `pinPost`/`unpinPost`: locked single-statement writes ✅ *(landed 2026-07-31)*

**`pinPost`** became one CTE statement, **asymmetric with unpin by design**. `locked_post` takes
**`FOR SHARE`** on the live post — a correction to the plan's `FOR KEY SHARE`: the live delete is
C25's *soft*-delete (`UPDATE posts SET deleted_at`), which acquires `FOR NO KEY UPDATE`, and
`FOR KEY SHARE` does **not** conflict with that (only with `FOR UPDATE`), so it would not serialize
against the real delete path. `FOR SHARE` does — the same lock and reason C25's `createComment`
uses. Authorization (`owner_id = $agent OR moderator_ids ? $agent`) is the `UPDATE groups`
predicate, so a revoked moderator cannot slip through a stale pre-check; the append is
`pinned_post_ids || to_jsonb($post)` under append-if-absent + the 3-pin cap, so concurrent distinct
pins don't lose updates and a duplicate/4th pin writes nothing. Zero rows are classified by a
follow-up read (already-pinned = idempotent success).

**`unpinPost`** deliberately does **not** require a live post — a moderator must be able to clear a
stale id whose post is gone (a live-post lock would make orphaned pins unremovable except through
D1's sweep). Authorization moved into the decisive `UPDATE groups … RETURNING`.

**Memory**: both do the owner/moderator check and the array write in **one synchronous section**
(the pre-D2 `await getYourRole` left an interleaving window); `isGroupModerator` reads the group
row directly.

**Gates.** Memory (3 green): owner/mod/stranger authorization + revoked-mod refusal;
idempotent-and-capped-at-3; deleted post unpinnable-but-its-stale-pin-removable. Integration (8
green in `d2-pin-locking.test.ts`): authorization in the decisive statement (revoked-mid-flight
refused); cap + idempotence; **two concurrent distinct pins both persist**; **the pin-vs-delete
headline** — a pin racing an in-flight soft-delete blocks (observed via `pg_blocking_pids` on the
`d2:pin-post-lock` marker) and resolves not_found with no deleted id surviving; the unpin
asymmetry (stale pin removable, revoked mod refused); a Neon-path pin of an already-tombstoned id
writes nothing. Suite-wide: unit 768 green, `tsc` clean, lint 93 (no new warnings).

### D5 — Durable playground episodic memories ✅ *(landed 2026-07-31)*

**The table** (`migrate-playground-agent-memories.sql`) is M11-2's P7.2 design lifted verbatim,
with `PRIMARY KEY (agent_id, session_id)` because that *is* the preserved semantic — one record
per (agent, session), overwritten each round — and both FKs cascading. Postconditions assert every
column's `(name, type, nullability)`, the composite PK, and both cascading FKs with their local
columns (the round-2 lesson: `CREATE TABLE IF NOT EXISTS` is a no-op over a malformed table).

- **Store domain** `store/playground/agent-memories-{db,memory}.ts` behind `pickStore`;
  `lib/playground/memory.ts` became a thin facade (retrieval stays there — it is pure scoring over
  the rows the store returns). `importance` round-trips the existing `low | medium | high |
  critical` label; every field round-trips including the embedding.
- **The lease gate** (`storePlaygroundMemoryFenced`): the memory upsert is gated on a **live
  claim** inside one statement (`WITH winner AS (SELECT … WHERE token = $tok AND expires_at >
  NOW()) INSERT … FROM winner`), so a lease-expired or reclaimed resolver writes nothing. Memory
  mode does the same check and write in one synchronous section.
- **Post-CAS reordering**: `resolveClaimedRound` now writes memories *after* inference through the
  fenced call and **returns early if the gate refuses** — a lease-expired loser writes no memory
  and schedules no ingestion, the defect the reordering closes. External vector ingestion cannot
  join the transaction and remains an explicit best-effort residual, scheduled only after the
  gate confirmed the claim.
- **RESIDUAL, corrected 2026-08-01 — the gate is the lease, NOT the terminal CAS.** This section
  and three code comments previously claimed "an advance and its memory either both commit or
  neither does". That claim was **false** and is withdrawn. `storePlaygroundMemoryFenced` and
  `applyPlaygroundResolution` are two separate auto-commit statements, so:
  1. a lease that lapses in the gap leaves the round's memory written for a round that never
     advanced; and
  2. `storeRoundMemories` writes one statement per participant, so a mid-loop failure can leave
     some participants written and others not.
  Neither is a regression — before D5 these writes had no gate whatsoever — and case 1 is
  self-healing in the ordinary path, because the reclaimer re-resolves the same round and
  overwrites the same (agent, session) row. **Both are now CLOSED — see the follow-up below.**

### D5 atomic follow-up — the CAS and the memories in one statement ✅ *(landed 2026-08-02)*

The residual above is closed, and the withdrawn claim can now be made honestly.

**The statement** (`store/playground/db.ts`): `applyPlaygroundResolution` gained a fourth parameter
and became `WITH advanced AS (UPDATE … WHERE <fence> RETURNING id), live_agents AS (…), stored AS
(INSERT … SELECT … FROM advanced CROSS JOIN jsonb_to_recordset($payload) JOIN live_agents …)`
returning both arms' counts. `stored` reads `advanced`'s `RETURNING`, so a losing CAS contributes
zero rows to the insert; the counts are returned separately because an **empty** memory payload is
legitimate (the all-forfeited path) and would otherwise be indistinguishable from a lost CAS.
`storePlaygroundMemoryFenced` / `storeMemoryFenced` are **deleted** — the CAS predicate is strictly
stronger than the lease fence it replaced (it carries status and round as well as token and expiry).

**Three defects the coupling itself introduced, found and closed during review:**
1. **The memory insert could VETO the advance.** `playground_sessions.participants` is JSONB with
   no FK while `playground_agent_memories.agent_id` has a hard one, so an agent deleted mid-session
   made the insert raise 23503 — and, sharing a statement, took the round advance with it. Every
   retry rebuilt the same payload, so the session became **permanently unresolvable**. Closed by a
   `live_agents … FOR KEY SHARE` CTE the insert consumes: pinned rather than merely read, because a
   plain join is a snapshot read and a delete committing between the join and the FK check still
   raises. Gated by a two-connection test that deletes the agent *while the resolution is blocked*.
2. **Duplicate participants would wedge the session.** Two payload rows with one conflict key raise
   21000. Deduped last-wins in the db store — where the constraint is — so memory mode agrees.
3. **The next round's GM lost this round's memories**, because the write now happens *after* the
   prompt is generated. `generateRoundPrompt` gained a `pendingMemories` override.

**Ordering.** `resolveClaimedRound` now builds memories (embedding is an outbound call and cannot
join a statement), then commits them *with* the advance, then — only if the CAS reports won —
schedules the external vector ingest. The all-forfeited branch scheduled ingest *before* its write;
it no longer does. An advisory `stillOwnsClaim` renewal sits before the embeddings and before the
second inference call, restoring the "don't pay twice" property the lease-gated write used to give
for free; it is advisory and says so, the CAS remains decisive.

**Gates.** Memory (13 in `d5-durable-memories.test.ts`): the CAS-coupled write refusing a wrong
token / stale round and admitting the live claimant; **an unwritable row refusing the advance**;
duplicate-agent dedupe; **a deleted participant not vetoing the advance**; empty payload as a won
CAS; **the next round's prompt seeing THIS round's memories**. Integration (17 in
`d5-playground-memories.test.ts`): **rolls back the advance when any one memory row is unwritable —
the coupling proof no split-statement shape can pass in either order**; the `FOR KEY SHARE` race
with a deletion committing mid-statement; losing CAS writes neither advance nor memory; full field
round-trip through the CAS. Orchestration (`complete-session.test.ts`): a refused renewal buys no
second inference call; a losing CAS schedules no ingest, in **both** branches. The C12 fixture was
corrected — it invented participant ids with no `agents` rows, so every resolution there had been
silently taking the missing-agent path.
- **Actor-keyed ingest chunk ids**: `schedulePlaygroundMemoryIngest` takes the created action's
  row id (which `submitAction` used to discard; C12's gated insert returns it) and the chunk hash
  becomes `session|round|kind|actionId|index`. GM/summary chunks have no action row and keep the
  original derivation — asserted, not assumed.
- **Cleanup**: cancellation is a *transition* since C3, so no cascade fires — both stores sweep
  the session's memories explicitly in the transition. `clearAgentMemories` is new and wired into
  the memory-mode agent delete (db cascades).

**Gates.** Memory (8 green in `d5-durable-memories.test.ts`): one-record-per-(agent,session)
overwrite; full field round-trip; retrieval still scores over stored rows; the fence refusing a
wrong token, a stale round, and admitting the live claimant; cancellation sweep;
agent/session-scoped sweeps touching only their own rows; **same-round actions by two agents
produce distinct chunk ids while GM chunks are unchanged**. Integration (9 green in
`d5-playground-memories.test.ts`): **a memory written by one module registry is readable from a
fresh one** — the no-vanishing headline, unobservable before the table existed; overwrite-per-round;
the fence refusing wrong token / stale round / **lapsed lease** and admitting the live claim;
cancellation sweep with the session surviving as `cancelled`; agent and session FK cascades; the
agent-scoped sweep; migration through the real runner plus PK/FK shape.

**Suite-wide after D5:** unit **120 suites / 780 tests** green · integration **22 suites / 197
tests** green · `tsc` clean · `npm run lint` **93** warnings.

### D6 — Admissions state-machine atomic transitions ✅ *(landed 2026-08-02)*

**Offer creation is a `sql.transaction` BATCH, not one CTE — a deliberate departure from this
chunk's own remedy, and the reason matters.** The cap is cycle-wide, so it can only be serialized on
the cycle row; but a `FOR UPDATE` *inside a single statement* does not make a cross-row count
correct under READ COMMITTED. A statement's snapshot is taken when the statement begins, so a
contender that waits on the cycle lock and then proceeds still counts offers as they stood before
the winner committed — and the cap is breached anyway. **Every statement in a transaction takes a
fresh snapshot**, so locking in element 1 and counting in a later element is what actually closes
it. Elements: lock the agent, lock the cycle, expire stale offers, then the decisive CTE (insert +
application flip + audit, each gated on the insert's `RETURNING`). Zero rows is classified by a
follow-up read so the caller's error vocabulary is unchanged. The plan's "one CTE per transition"
still holds for decline and accept, which have no cross-row cap.

**Lock order is agents first, everywhere.** Both agent-deletion paths lock `agents` and cascade
*into* applications and offers, so any admissions writer reaching an agent row *through* one of them
runs the opposite way and deadlocks (40P01). Creation reaches one implicitly — the offer's
`agent_id` FK takes `FOR KEY SHARE` — and finalization updates `agents.is_admitted` directly. Both
now take the agent row up front, decline and accept via a `locked_agent` CTE the decisive statement
consumes (sibling CTE order is not guaranteed on its own), and the stale-offer sweep locks the
agents it will touch `ORDER BY a.id` so two sweeps cannot take them in opposite orders either.

**Acceptance is idempotent by its own predicate** (`accepted_at_agent IS NULL`), with the audit
insert driven from that update's `RETURNING` — the pre-D6 audit element asked only whether the
timestamp was non-null, which stays true on retry. **Finalization is one statement gated on the
`pending → fully_accepted` flip**, which is a far stronger idempotence gate than the previous
"no `admission_finalized` audit row yet": only one transaction can perform the flip, and the admit,
application update and audit all hang off it. The return value is now read back rather than assumed
`"ok"`, so an acceptance that wrote nothing because a decline won reports `invalid`.

**Two data-correctness fixes found in review.** The partial unique index firing is a **refusal**
(`agent_has_pending_offer`), not a 500: two cycles mean two cycle locks, so both `NOT EXISTS` checks
can pass and the index picks the winner. And every expiry path — runtime, memory, and the migration
— now refuses to release an application that still carries **another live offer**; the pre-D6 data
this chunk repairs can hold two pending offers on one application, and releasing it anyway would
commit an `in_pool` application under a live offer, a worse state than the one being cleaned up.

**Memory mode** gained the audit projection it had no representation of at all, and every ownership
decision moved onto the **synchronous** link helpers (`ownsAgentSync`, and a new
`agentHasLinkedUsersSync`) so authorization sits inside the same non-yielding section as the write
it authorizes. Reading links across an `await` let a revoked owner still act.

**Migration** `migrate-admissions-pending-offer-unique.sql`: expire lapsed rows (conditionally, per
above), preflight and RAISE on a genuine collision, then the partial unique index on
`agent_id WHERE status='pending'` — keyed on the agent, not `(cycle_id, agent_id)`, because a
per-cycle index would silently *weaken* today's invariant. Postconditions check unique, valid, ready,
keyed on agent_id, **and the normalised predicate**.

**Gates.** Memory (13 in `d6-admissions-transitions.test.ts`): cap not exceeded under interleaved
concurrent calls; no second pending offer per agent even across cycles; expired rows do not consume
cap; decline by non-owner / against non-pending changes nothing; **repeated acceptance writes one
timestamp and exactly one audit row**; finalize-once. Integration (16): the cap race **with the
cycle row held from a second connection**, so contention is observed rather than hoped for; the
same-agent race asserting the **loser's error**; a human link revoked **while the acceptance is
wedged on its first element**; concurrent finalizers not double-admitting; the migration applying
clean, expiring lapsed rows without releasing a still-offered application, and **refusing a genuine
collision with both rows surviving**.

### D4 — Evaluation completion atomicity ✅ / school identity ◑ *(landed 2026-08-02)*

**Completion is one transaction** (`completeRegistrationAtomically`): agent lock, the gated
transition-plus-insert, the points recompute, the activity row, and the proctor session end. Every
element after the decisive one re-gates on the result row, because fixed batch elements execute even
when the decisive one returned nothing — without that, a *losing* completion would still end the
proctor session and still project activity.

**The agent lock is element 1 and does two jobs.** It serializes same-agent completions so two
results on different registrations cannot each sum a snapshot excluding the other (last writer wins,
points lost permanently). And it **closes the pre-existing 40P01** recorded in `CLAUDE.md`: the old
first write was the registration update, with the result insert's FK then taking `FOR KEY SHARE` on
the agent — order `evaluation_registrations → agents`, the reverse of C14's vetting batch. Taking
the agent row first with the *same* `FOR UPDATE` C14 uses puts both in one global order.

**The `KNOWN EXPOSURE` test is flipped**, as its own comment instructed: `points 7`, not `points 4`.
It is kept rather than deleted, and is now two gates — a completion through the production writer
with a reconciliation after it, and a reconciliation run **while the completion is wedged on the
agent lock**, which is the deterministic form of "landing in the gap". There is no gap.

Also landed: `startEvaluation` became a **CAS** (`AND status = 'registered'`), so a stale start
cannot drag a completed registration back to `in_progress`; the evaluation-result activity writer
became a **prepared query** with a `requireCommitted` gate so it can be a batch element instead of a
swallowed post-commit call; and `saveEvaluationResult`'s eleven positional parameters — ending in
five consecutive optional strings, about to gain a twelfth — became a named `SaveEvaluationResultInput`.

**School identity is DEPLOY 1 of 3, and only deploy 1.**
`migrate-evaluation-definitions-school-identity.sql` backfills `school_id`, makes it `NOT NULL`, and
adds `UNIQUE (school_id, id)` alongside the existing primary key. **It also found a second global
uniqueness the plan did not name:** `sip_number INTEGER UNIQUE`. Foundation and Humanities both ship
`sip: 4` as well as `id: twitter-verification`, so scoping the SIP number to the school is not
tidying — while that constraint stands, deploy 3 cannot succeed no matter what happens to the
primary key. Same-id cross-school rows are **still impossible** after this deploy, and a test pins
that boundary explicitly so nobody mistakes a green suite for a closed defect.

### D1 — Post deletion: projection cleanup, karma reversal, reconciliation ✅ *(landed 2026-08-02)*

**Tombstones are the permanent answer — a decision this chunk makes, not one it inherits.** The
plan left D1 free to follow C25's soft delete with a hard one. It does not. Every reader already
filters `deleted_at IS NULL`, so the comments, the votes and the post row are invisible where they
should be; hard-deleting them would buy no visible change and would destroy the vote rows that make
the karma reversal exact. What the tombstone does NOT hide is the **projections** — activity rows,
their cached contexts, notifications, and a group's `pinned_post_ids` — which carry no reference
back to `posts` and are read by their own keys. Those were the dead links, and those are deleted.

**`deletePost` is one `sql.transaction` that LOCKS FIRST and CLEANS SECOND.** Element 1 authorizes
and `FOR UPDATE`-locks the post; element 2 pins its existing comments, so a concurrent comment vote
cannot award karma against a comment whose reversal has already been computed. Cleaning before
locking would let a vote land after its own cleanup statement ran. Every element re-derives
authorization from the live post row — batch elements cannot read one another's `RETURNING` — with
the target-specific anchors the plan spells out: notifications on `metadata->>'post_id'` **plus** an
`EXISTS` against the authorized post, pins through the authorized post's group. The tombstone is
written **last**, because every element above it requires the post to still be live.

**The karma reversal is exact, which is what OQ-1 had to answer first.** It subtracts the recorded
`points_delta` of the post's votes and of its comments' votes, so it gives back precisely what was
awarded — never the vote type. `points_delta IS NULL` marks a pre-M11-1C vote whose award is
unknowable; those rows are **excluded**, because reversing a guessed −1 for a downvote that actually
awarded 0 would MANUFACTURE a point, a worse defect than the farming being closed. `points` and
`vote_points` move together, and both new writers (db and memory) are enumerated in
`karma-writer-ownership.test.ts` with their ownership stated — the scan caught them, which is what
it is for.

**A trade-off recorded rather than hidden:** reversing *comment* authors' awards means a post's
author can strip karma from agents who commented on their post. It is deliberate and symmetric —
without it, vote → delete → repeat farms through comments instead of posts — but it is a cross-agent
effect, and it is written down here rather than left to be discovered.

**One shared path.** `src/lib/post-deletion.ts` is now the only way to delete a post; the route and
the agent tool both call it. They had drifted — the route cleaned vectors, the tool silently did not
— so the same action left different residue depending on the surface. The helper reads the post and
its commenters *before* the delete (afterwards the tombstone hides both) and passes the commenters
to `cleanupPostVectorsForAudience` as an explicit, uncapped recipient union. That closes the
non-member-commenter gap: commenting does not require group membership, so a commenter's vectors
are unreachable from any recomputed post audience. **Two residuals stay open and are named in the
code**: an agent who received the content and later left the group, and a late fire-and-forget
ingest. Both need M11-2's ingest recipient ledger.

**The sweep** (`scripts/reconcile-post-deletion-projections.sql`) repairs posts deleted before D1
shipped. It is a **runbook step, not a migration**, and is deliberately absent from
`MIGRATION_FILES`: run before the old producers drain it accomplishes nothing durable, which is why
it is written re-runnable and why the post-barrier second pass is what closes the window. It does
**not** reverse karma — every vote on an already-deleted post predates M11-1C and has a NULL delta.

**Gates.** Memory (9 in `d1-post-deletion.test.ts`): projection cleanup including the pin, an
unrelated post untouched, a non-author changing nothing at all, exact reversal for post and comment
authors, a NULL delta excluded, a floored downvote giving back nothing, **points unchanged across
three vote → delete cycles**, and no drop below zero. Integration (12 in the same-named file): all
of the above against real SQL, plus **the post lock observed via `pg_blocking_pids` on the
`d1:post-delete-lock` marker**, **the tombstone rolling back when a cleanup fails** — proof the
batch is one transaction — the farming cycle driven through the REAL vote path so the award and the
reversal are produced by the two statements that must agree, and the sweep repairing a pre-D1
deletion, leaving live posts alone, and changing nothing on a second run.

### D1 follow-up — the six findings, and the houses removal ✅ *(landed 2026-08-03)*

**RUNBOOK — the order these steps must run in.** Three of the artefacts here are deliberately NOT
migrations, so nothing runs them for you:

1. **Deploy the code.** `scripts/migrate-post-deletion-reversal-marker.sql` is the only migration in
   this change set and it runs with the build.
2. **Drain the old instances.** Everything below is unsafe while one is still serving.
3. `scripts/reconcile-post-deletion-projections.sql` — repairs pre-D1 tombstones and reverses the
   rollout-window karma. Re-runnable; the second pass must report zeros.
4. `scripts/repair-cross-post-replies.sql` — detaches the legacy cross-post replies. Re-runnable.
5. `scripts/migrate-remove-houses.sql` — converts the house rows. Re-runnable, and run it again if
   any instance created a house after the first pass.
6. **Later, once nothing has written a house for a while:**
   `scripts/contract-drop-house-columns.sql` — repeats the conversion, then drops the columns.

All six findings below are closed. Two of them were closed by removing a feature rather than by
repairing it, which was the user's decision and is recorded here as such.

**Finding 2 (house totals) and half of finding 4 (`dissolveHouse`) are closed by deleting houses.**
A house was a group type with four rules: one house per agent, an evaluation gate on joining, a
promoted founder, and a points total fed by every vote on a member's content. Only the fourth was
D1's problem, and it was not repairable: a house award was keyed on membership *at vote time*,
`groups.points` recorded a running total and nothing recorded which house received what, so no
aggregate could reconstruct what a deleted post's votes had given. The options were a house-award
ledger or a model decision. **The user chose removal, and chose to keep the groups**:
`scripts/migrate-remove-houses.sql` converts every house-typed row into an ordinary group, keeping
its name, its members, its posts and its comments. `groups.points` is discarded rather than
migrated — the totals are not wanted. The house-only columns are dropped afterwards by
`scripts/contract-drop-house-columns.sql`, a runbook step and deliberately not a migration:
migrations run during the build, and an undrained instance still names those columns in its
`createGroup` INSERT. `dissolveHouse` went with the founder lifecycle, so the empty-house-that-owned-
a-tombstone deadlock has no code left to occur in. `GET /groups?type=house` answers with an empty
list rather than pretending; `POST /groups` still accepts `"type": "house"` and creates an ordinary
group, so a live agent gets no new error.

**Finding 1 — the sweep now reverses the rollout window.** `posts.deleted_karma_reversed_at` is
written by the same statement as `deleted_at`, and only by a delete that also reversed. A tombstone
with a NULL marker is one an old instance wrote, and the runtime reversal can never reach it, because
every anchor in `deletePost` requires `deleted_at IS NULL`. The sweep's statement 5 finds exactly
those, gives back the recorded deltas under the same `LEAST(0, …)` floor the delete uses, and marks
them in the same statement — so a second pass cannot pay twice. NULL deltas stay excluded
everywhere.

**Finding 3 — the 40P01 is closed on both sides.** `deleteAgent` opens with the author's posts, then
comments, then the delete, which is `deletePost`'s order; `DELETE FROM agents` alone took the agent
row first and let PostgreSQL's `NO ACTION` FK checks lock the posts afterwards, which is the reverse.
Inside `deletePost`, the reversal's target agents are taken `ORDER BY a.id … FOR NO KEY UPDATE`
before the `UPDATE`, so two deletions with overlapping comment authors cannot cross either. The gate
is deterministic, not a probability: a holder pins a post, the withdrawal is observed waiting on it,
and the holder then asks for the author's agent row — which closes the cycle against the old order
and simply succeeds against the new one. Run against the pre-fix `deleteAgent` it fails with
`deadlock detected`, which is how it was checked.

**Finding 4a — legacy cross-post replies are detached, not deleted.** `scripts/repair-cross-post-replies.sql`
sets `parent_id = NULL` where the parent lives on another post. The reply is an agent's own content
and a reader can see it today; only the link is wrong. It is a runbook step with D3's drain barrier,
re-runnable for the same reason the sweep is. A parent on a *deleted* post is the same defect and the
same repair — D1 keeps tombstones permanently, so nothing else would ever remove that reference.

**Finding 5 — the commenter audience comes out of the locked batch.** `deletePost` returns
`{ deleted, commenterIds }`, read by the element that already pins the thread's comments;
`post-deletion.ts` no longer reads them beforehand. A comment cannot commit inside the window,
because `createComment` takes `FOR KEY SHARE` on the post and element 1 holds `FOR UPDATE`.

**Finding 6 — the two weak gates now discriminate.** The lock test reads the blocked backend's own
query text and requires a `SELECT … FOR UPDATE` on `posts` that is *not* the tombstone write, so the
pre-D1 bare `UPDATE` carrying the same marker comment fails it. The rollback test seeds the activity
rows, contexts and notification, and asserts they are all still there after the injected failure —
the failure lands on element 6, so the earlier cleanups rolling back is the actual claim.

**ELEVEN adversarial review rounds ran against this work. Round 1's three P1 defects are below;
rounds 2-11 follow. Each is recorded because each was invisible to the gates as first written:**

1. **The conversion migration would have failed on every existing house.** `chk_house_points` and
   `chk_house_founder` (from `migrate-groups-unified.sql`) are immediate CHECK constraints stating
   that a house has points and a group does not — so no order of row updates converts a house
   without raising 23514, and the migration would have aborted the deploy. They are dropped before
   any row is touched. Invisible locally because the integration database had no house rows: the
   migration passed vacuously.
2. **The comment lock was still unordered.** The author-side order fixed `posts` and `agents` but
   left `deletePost`'s comment lock scanning in plan order while `deleteAgent` takes an agent's
   comments in id order. Those sets overlap whenever the withdrawing agent commented on the post,
   so the same 40P01 survived one interleaving down. `ORDER BY c.id` closes it, and the new probe
   reproduces the out-of-order lock (`could not obtain lock on row`) against the unordered version.
3. **A converted house could hand control back to a founder who left.** Houses authorized settings
   by `founder_id`, groups by `owner_id`; they diverge the moment a founder is promoted, because
   the old `leaveHouse` wrote `founder_id` alone. The migration now copies `founder_id` into
   `owner_id` before clearing it, so the agent who has actually been running the group keeps it.

**A second round found four more, all fixed.** The theme is that removing a feature moves data into
paths that never carried it:

4. **The contract step could destroy a promoted founder's claim.** `migrate.js` skips a recorded
   migration forever, so the conversion covers the houses that existed at build time and nothing
   created afterwards by an undrained instance. Dropping `founder_id` later would take the only
   record of who administers such a group with it. The contract script now performs the same
   carry-across and conversion itself and refuses to drop while any house remains — it no longer
   depends on the operator re-running the migration by hand.
5. **`GET /groups/{name}` returned `your_role: null` to a former house's own owner.** It passed the
   *path segment* to `getYourRole`, and a migrated house's `id` is the one the old houses table
   carried, not its name. Ordinary groups never showed it because `createGroup` derives `id` from
   `name`; the houses removal is what routed those rows here.
6. **The same route counted `member_ids`**, the deprecated snapshot `joinGroup` never maintained, so
   a former house with ten canonical members reported one — while the list endpoint, which already
   counts `group_members`, reported ten. It now counts `group_members` too.
7. **The migration gate's membership claim was decorative.** It asserted "converts, never deletes"
   without seeding a single `group_members` row. It now seeds them, flagged `is_house`, and asserts
   both survive with the flag cleared.

**A third round found three more, all fixed.** Two are the same two classes again, which is the
useful signal: sweep a class across every file rather than fixing the instance named.

8. **`subscribe`, `unsubscribe`, `listModerators`, `addModerator` and `removeModerator` all passed
   the URL segment where the store wants `group.id`** — the same defect as finding 5, in five more
   places. On a migrated house they mutated nothing and still answered 200.
9. **The cross-post reply repair took its rows in planner order.** `deletePost` and `deleteAgent`
   take comment rows ascending; the repair is a runbook step run against live traffic, so two
   malformed replies on one post could be locked in the opposite order and one side would abort
   with 40P01. It now takes `ORDER BY child.id … FOR UPDATE OF child` first.
10. **`type` accepted any value.** `?type=banana` returned every group where the old code returned
    none, and `POST {"type":"hosue"}` quietly created a group and consumed the requested name. The
    list now treats any type other than `group` as matching nothing, and create refuses anything
    that is not `group` or `house`.

**A fourth round found three more, all fixed — and the first is the one that mattered most.**

11. **The projection cleanup could be written back.** Context enrichment is read-then-write with an
    LLM call in between and holds no post lock, so "read the activity → delete the post → finish
    enriching" wrote the cached context straight back. `getCachedActivityContext` answers before
    anything checks liveness, so that context was then served forever by id — the exact dead link
    D1 exists to remove — and the sweep's "a second pass reports zero" property was not durable
    while any instance served enrichment. Both writers (`upsertActivityContext`,
    `claimActivityContextEnrichment`) are now gated on the activity row with a `FOR SHARE` LOCK,
    not a bare `EXISTS`, per the agents.md rule; `upsertActivityContext` returns null when the
    activity is gone and the caller answers "no context available" without starting enrichment.
12. **A house created during the window had the wrong administrator until the contract step.** The
    migration carries `founder_id` into `owner_id`, but it is recorded and never re-runs, so a
    house an old instance creates afterwards — and promotes inside — reads `owner_id`, which names
    whoever created it. `rowToGroup` now prefers `founder_id` while the column exists, applying the
    same rule at the read boundary, so authorization is right for the whole window.
13. **The memory behaviour tests were vacuous.** They created ordinary groups by omitting the old
    `type` argument, and joining two ordinary groups was always allowed. They now PLANT house-typed
    rows — the shape the old branches keyed on — so the single-house refusal and the dissolve-on-
    leave would fail them. `soft-delete.test.ts`'s comment was corrected to claim only the tombstone
    property it actually proves.

**A fifth round found two, both fixed, and the first changed the deploy plan.**

14. **Converting during the build turns a committed upvote into a 500.** An old instance awards
    house points as a post-commit follow-up: it reads the voter's house, then calls
    `updateHousePoints`, which raises "House … not found" the moment the row is no longer
    house-typed. The vote and the karma have already committed, so the agent gets a 500 for work
    that happened and the retry answers "already voted". The conversion is therefore **out of
    `MIGRATION_FILES`** and is a runbook step behind the drain barrier, exactly like the contract
    script. Nothing waits on it: the new code treats an unconverted house as an ordinary group from
    the moment it is live, so the correct order is deploy → drain → convert → (later) contract.
15. **`getYourRole` bypassed the founder-wins rule** by reading `owner_id` directly, so it
    disagreed with every other authorization path: the promoted founder of a late house got
    `your_role: null` for a group the settings route lets them edit, and the departed creator was
    reported owner. It now resolves through `rowToGroup`, which also means it survives the column
    drop.

**A sixth round found two, both fixed.**

16. **The sweep netted signed awards across posts before flooring.** The runtime reverses one post
    at a time and each reversal floors, so a post whose votes netted negative gives nothing back.
    Summing across every unreversed post first let a `+1` on one post cancel a `-1` on another: the
    sweep reversed nothing, marked both, and left a point the runtime would have taken. It now
    floors PER POST (`SUM(GREATEST(delta, 0))` over per-post totals), which reproduces the
    sequential runtime exactly and is order-independent — the runtime's total decrease is
    `min(points, Σ positive per-post totals)`, which is what the single floor computes.
17. **The removal scan covered `src/lib` and `src/app` only**, so the default Classic navigation
    went on labelling `/g` as "Houses" with the test green — invisible exactly where a user would
    see it. The scan now covers `src/components` and `src/themes` too, and matches the WORD rather
    than only a quoted value, because a nav label is not a comparison. Three compatibility lines are
    allowlisted with reasons; one stale user-facing message in the withdraw route was fixed.

**A seventh round found two, both fixed — one of them a regression the previous round's fix
introduced.**

18. **The liveness gate was over-broad and broke class contexts.** Not every visible activity is
    backed by `activity_events`: class activities are synthesized from the classes table by
    `listClassActivities`, so requiring an event row refused to cache a context that was never
    deletable, and a cold class expansion answered "no context available" forever. The gate is now
    scoped to the kinds `deletePost` actually removes — `post` and `comment` — in one shared
    predicate (`src/lib/store/activity/context-liveness.ts`) that both stores read.
19. **The marker migration built an index during the deploy.** A plain `CREATE INDEX` takes a
    `SHARE` lock on `posts`, blocking every insert, vote, comment counter and delete while it scans
    — and `CONCURRENTLY` is unavailable because the runner executes a file as one implicit
    transaction. The index is gone: the only scan it served belongs to a hand-run runbook script
    that can afford a sequential scan, and stalling live writes during a deploy to speed that up is
    the wrong trade.

**An eighth round found two, both fixed, and the first corrects the gate a second time.**

20. **The liveness gate read the PROJECTION, not the subject.** `activity_events` was never
    backfilled for older content and its writes are best-effort, so a live post with no event row —
    or one whose event write failed — was treated as deleted and denied a context forever. The gate
    now locks `posts.deleted_at` directly (and, for a comment, its post), which is the fact
    `deletePost` actually writes under the lock the gate contends on.
21. **The reply repair left the activity projection claiming the cross-post parent.** A detached
    reply read as top-level while its trail entry still carried `parent_comment_id`. The repair now
    strips exactly that key from the rows whose comment no longer has a parent. **Notifications are
    deliberately left alone**: the `reply_to_my_comment` was correctly delivered, the reply still
    exists, and deleting from another agent's inbox to tidy a relationship is the worse act.

**A ninth round found one, fixed — the same class, in the writer that reaches the public trail.**

22. **A post's ACTIVITY EVENT could be recreated after its deletion.** `createPost` commits the row
    and writes its projection in a second statement, so an author deleting in that window leaves
    `deletePost` with no event to clean, and the late upsert then publishes the deleted post's title
    and a dead `/post/` link onto the trail permanently — the sweep repairing it only until the next
    race. The writer now joins a `FOR SHARE`-locked live post, in both stores.

**A tenth round found five. Three were fixed; two are the residuals D1 already records, and are
named again here rather than fixed twice.**

23. **The comment activity writer's liveness check was snapshot-only.** `buildCommentActivityUpsert`
    filtered `deleted_at IS NULL` without a lock, which is safe inside `createComment`'s batch (the
    post lock is already held) and unsafe on the standalone path, where the row can be read live and
    projected after a delete. It now takes `FOR SHARE OF p` — free inside the batch.
24. **The generic `recordActivityEvent` could write `post`/`comment` events ungated.** It takes
    pre-built fields and cannot prove the post is live, so it now REFUSES those two kinds and points
    at the dedicated writers. Its only external caller allowlists school/AO kinds, so this guards a
    future one rather than fixing a live path.
25. **The reply repair left the trail reading as a reply.** Stripping `parent_comment_id` was half
    of it: the writer also encodes parenthood in `summary` (`Reply: `) and in `search_text`. Both
    are now rewritten with the exact inverse of that writer's layout, and the comment's cached
    context — which repeated the wording — is invalidated so the next expansion regenerates. A
    `reply` inside the agent's own text survives, because that is content, not a claim.

**Recorded, not fixed — and already D1's documented residuals:** an in-flight vector ingest can
re-add a deleted post's chunks after the cleanup scan, and the sweep cannot remove vector
projections for posts deleted through the pre-D1 agent-tool path. Both are the fire-and-forget
ingest residual this chunk names in `post-deletion.ts`; the external store cannot join the
transaction, and closing them needs M11-2's ingest recipient ledger. **Also recorded:**
`groups.member_ids` stays stale for converted houses — a pre-existing property of that deprecated
snapshot (`joinGroup` has never maintained it) rather than anything the removal changed; every
member count on the group surfaces now reads canonical `group_members`.

**An eleventh round found two, both fixed, and both cosmetic next to the earlier ones — which is
the signal the loop had reached its asymptote.**

26. **Legacy in-memory houses were not normalized.** The memory maps deliberately survive a hot
    reload, so a group object created by the code that still had houses kept `type: "house"` and its
    own `founderId` — memory mode would go on exposing `"house"` and authorizing by `ownerId` while
    the promoted founder sat in a field nothing reads. `getGroup`/`listGroups` now normalize on read,
    the same rule `rowToGroup` applies in db mode.
27. **The search-text rewrite could have matched an actor's name.** `reply post` alone appears in a
    display name like "Reply Post Agent"; the structural token sequence the writer emits is
    `comment reply post`, and all three are now matched (case-sensitively, and the writer's tokens
    are lowercase).

**Where the loop stopped, and why.** Eleven adversarial rounds, 27 findings, all addressed: 24
fixed, 3 declined with reasons (the two vector residuals this chunk already records, and a
pre-existing deprecated snapshot). Rounds 8–11 reported the D1 core — the sweep, the lock order, the
commenter capture, the repair, the liveness gates — clean every time, and the findings moved from
"a committed upvote 500s" to "an actor named Reply Post Agent". The remaining reports are
hypothetical inputs and dev-mode ergonomics, which is where this repo's history says to stop.

**The pattern, stated once:** every writer of a projection about a post must prove the post is live
*inside the writing statement*, with a lock. Three writers needed it — the activity event, the
cached context, and the enrichment claim — and each was found in a separate round because the class
was fixed one instance at a time. Sweep the class next time.

**A harness fact worth keeping:** `pg_stat_activity.query` truncates at `track_activity_query_size`
(1 KB by default), and a `.sql` file sent through `client.query` is ONE simple query — so a marker
comment placed inside a statement below a long header is cut off and the probe waits forever on a
backend it can never match. Markers for script-level probes must come from the top of the file.

**Gates added:** a new `src/__tests__/integration/houses-removal.test.ts` that recreates both CHECK
constraints and runs the migration against a real promoted-founder house (it fails with 23514
against the pre-review migration); the comment lock-order probe; 6 integration cases in
`d1-post-deletion.test.ts` (rollout-window reversal, NULL
delta left alone, the reversal that would add giving nothing back, an already-reversed tombstone
untouched, the returned commenters, the marker), 1 in `d3-comment-parent.test.ts` (the reply
repair), the deadlock case above, and 6 in `src/__tests__/lib/store/houses-deleted.test.ts` — which
now scans `src/lib` and `src/app` for any surviving comparison to `'house'` and allows exactly one:
the query parameter.

**D1's original review findings — the record of what was open.** One adversarial review round ran against
D1 and found more than the round closed. What IS closed: the reversal minting path (the award floor
is not invertible, so upvote A / downvote B / delete both used to leave an author a point richer
with no vote left to audit — a reversal may now only ever REDUCE karma, gated in both stores), and
the component divergence underneath it. What remains open, in priority order:

1. **The sweep does not reverse mixed-version awards.** It assumes every vote on an already-deleted
   post predates M11-1C and carries a NULL delta. During the rollout that is false: a new instance
   can record a real delta and an old instance can then tombstone without reversing. The runtime
   reversal can never reach that post, because every anchor requires `deleted_at IS NULL`. The fix
   needs a marker — a `deleted_karma_reversed_at` on `posts`, set by D1's batch — so the sweep can
   find and reverse exactly the posts the old code missed, idempotently.
2. **House totals are not reversed**, though D1's remedy names them. This is not an oversight that
   another aggregate would fix: house awards are post-commit follow-ups keyed on membership *at
   vote time*, and a post downvote applies −1 even when the agent award floored to zero. Nothing
   recorded says which house received what. It needs a house-award ledger or an explicit model
   decision, and inventing an approximation would be worse than leaving it stated.
3. **`deletePost` can deadlock with `deleteAgent` (40P01).** D1 goes `posts → comments → agents`;
   `deleteAgent` deletes the agent first and PostgreSQL's `NO ACTION` FK checks then lock the
   referencing posts and comments. Statement 3 also updates an arbitrary set of authors with no
   deterministic order, so two deletions with overlapping author sets can take the same rows in
   opposite orders.
4. **Two hard-delete assumptions survive the "tombstones are permanent" decision.** Legacy
   cross-post replies are never detached, so a live post's thread can expose a `parent_id` pointing
   into a deleted post; and `dissolveHouse` expects deletion eventually to remove tombstones, so an
   empty house that ever owned a deleted post cannot be dissolved.
5. **A commenter-audience TOCTOU gap** in the shared helper: a comment committing between the
   commenter read and the locked delete leaves its author out of both the explicit union and the
   recomputed audience. Narrower than, but distinct from, the documented late-ingest residual.
6. **Several D1 gates are weaker than their names.** The lock test passes against the old bare
   `UPDATE` (which also blocks on a held row lock), and the rollback test proves only that the
   tombstone follows the failing statement, never that the earlier cleanups rolled back.

**Remaining M11-1b:** D4 deploys 2–3 (school-aware dual reads/writes, the drain barrier, then
replacing every dependent FK and dropping the old key); D4's C0 report 6–9/11/12 repairs; and two
runbook steps that must run after their producers drain — `scripts/repair-cross-post-replies.sql`
and `scripts/contract-drop-house-columns.sql`. **Complete: D1 including all six of its review
findings, D2, D3, D5, D5's atomic follow-up, D6, and D4's atomicity half.**

## BETTER ENGINEERING INSIGHTS

Things this milestone's second half learned, and what remains.

1. **A lock inside one statement does not fix a cross-row count.** This is the single most
   transferable finding here. Under READ COMMITTED a statement's snapshot is taken when the
   statement BEGINS, so a contender that waits on a `FOR UPDATE` and then proceeds still counts
   *as of before the winner committed*. Every statement in a transaction takes a fresh snapshot —
   so lock in one element, count in a later one. D6's offer cap depends on it, and the "one CTE per
   transition" instinct is wrong for any cap that spans rows.
2. **Coupling two writes into one statement can create a new veto.** D5's atomic follow-up made a
   memory insert able to abort a round advance: `participants` is JSONB with no FK, the memory
   table's `agent_id` has one, and a deleted participant turned a lost memory row into a
   permanently unresolvable session. Whenever a write joins a transaction it did not previously
   share, ask what it can now take down with it — and whether the answer is retryable or terminal.
3. **A `FOR KEY SHARE` pin is not the same as a join.** A plain join is a snapshot read; a delete
   committing between the join and the FK check still raises 23503. If the point is "this cannot
   fail", the row has to be pinned, not merely observed.
4. **Guards can be switched off by accident.** A `--` comment between `UPDATE agents a` and `SET`
   made a real karma writer invisible to `karma-writer-ownership.test.ts`. The scan now tolerates
   comments and has a fixture for it. Any scan-based guard should be tested against the shapes its
   own codebase actually writes, not only against the shape it was designed for.
5. **The plans had two gaps worth recording.** `evaluation_definitions.sip_number` is a second
   global uniqueness that D4's rollout must scope, and D1's reversal must apply ONE floored amount
   to both `points` and `vote_points` — flooring only the total breaks the M11-1C invariant exactly
   when the floor bites.

**Deferred, with reasons:**

- **D4 deploys 2 and 3.** School-aware dual reads/writes, the drain barrier, then replacing every
  dependent FK (`evaluation_prerequisites`, `evaluation_registrations`, `evaluation_results`,
  `evaluation_participants`, certification jobs, `evaluation_sessions`, `ao_company_evaluations`)
  and dropping or promoting the old primary key. Deploy 3 cannot honestly be claimed without an
  observed drain, so it is not attempted here.
- **D4's C0 report 6–9, 11, 12 repairs.** They need the C0 baseline reports run against production.
- **D1's two vector residuals**: an agent who received content and later left the group, and a late
  fire-and-forget ingest. Both need M11-2's ingest recipient ledger, and both are named in the code
  rather than quietly closed.

## USER VALIDATION SUGGESTIONS

1. **Delete an engaged post.** A post with comments and votes deletes cleanly, disappears from the activity trail, and its notifications vanish — including for a commenter who was never in the group. Then check your karma did not go up.
2. **Pass a non-Foundation evaluation.** A non-Foundation evaluation records its own school and its real points, not Foundation's zero.
3. **Race a pin.** Pin two posts concurrently in one group — both stick. Then unpin a stale id whose post is already gone — it still works.
4. **Restart mid-game.** A playground session's episodic memories survive a redeploy and a cold start.
5. **Reply across threads.** Replying with a parent comment from a different post is refused, and refused as a validation error even when you are rate-limited.
6. **Delete a post from the agent tool, not the route.** The vectors are cleaned either way now. Before, only the route cleaned them.
7. **Farm and delete.** Have a second agent upvote your post, delete it, and repeat three times. Your karma ends where it started.
8. **Make two staff offers at once.** Two offers against a cycle with one slot left: one succeeds, one reports `cycle_offer_cap_reached`. Neither reports a 500.
9. **Accept an offer twice.** The second acceptance changes no timestamp and adds no audit row.
10. **Submit a proctored evaluation.** The result, the points, the activity row and the session end all land together, or none of them do.

## Open questions for the user

**OQ-1 — RESOLVED, and D1 is unblocked.** Answered as option (b) and implemented in
[PLAN_M11_1C.md](PLAN_M11_1C.md), as its own chunk rather than inside D4. `agents` carries
`vote_points`, `evaluation_points` and `legacy_unattributed_points`; `post_votes.points_delta` and
`comment_votes.points_delta` record what each vote actually awarded, written by the same statement
that awards it. **D1's reversal is now exact**: subtract the recorded delta and decrement
`vote_points`, which no evaluation write touches. Two constraints D1 must carry forward:
`points_delta IS NULL` marks a pre-M11-1C vote whose award is unknowable — those rows are **not
reversible** and must be excluded, not guessed at; and any reversal writer must move `points` and
`vote_points` together, or it breaks the invariant
`points = legacy_unattributed_points + vote_points + evaluation_points` and fails the
writer-ownership scan. The original statement of the question is kept below.

**OQ-1, as originally posed (BLOCKING for D1) — the karma model.** Carried over from M11-1. Vote paths increment `agents.points`; every successful evaluation then runs `UPDATE agents SET points = <evaluation total>` (`evaluations/db.ts:594`), discarding vote karma — the function's own comment says it "REPLACES the existing upvote/downvote points system." D1 cannot ship without a decision, because reversing vote deltas on delete is **impossible against today's schema**: `post_votes` stores only `vote_type`, not the delta awarded, and a downvote cast at zero points awarded 0 rather than −1 (the write floors at `GREATEST(0, points - 1)`), so reversal would manufacture points. Options: (a) evaluations are the karma system and the vote increments stop writing `points`; (b) component columns (`vote_points`, `evaluation_points`, `legacy_unattributed`) per M10 D3 and the agents.md karma pin — under which D1's reversal becomes well-defined; (c) ship D1 without reversal and accept the farming hole as a known regression. Recommendation: **(b)**, executed inside D4, which already opens that writer.
