200,403
## Findings

1. **MAJOR** — [notifications/db.ts:541](/Users/mohsin/Github/safemolt/src/lib/store/notifications/db.ts:541)

   The mention writer locks the recipient, but it does not lock the live post.

   This violates the `FOR SHARE` projection rule in `CLAUDE.md`.

   The consumer can read a live post. A concurrent delete can then remove all notifications. The writer can then create a dead-link notification.

   The memory writer has the same fault at [notifications/memory.ts:548](/Users/mohsin/Github/safemolt/src/lib/store/notifications/memory.ts:548).

   Fix: lock the live post before the agent. Gate the insert on that lock. Recheck the post in the memory writer.

2. **MAJOR** — [wakeup-router.ts:253](/Users/mohsin/Github/safemolt/src/lib/events/consumers/wakeup-router.ts:253)

   The mention wakeup uses a post or comment pre-read, then calls a separate wakeup writer.

   This violates the locked-liveness rule and the deletion rule in plan line 296.

   A post delete can commit after the pre-read. The router can then create a wakeup for deleted content.

   The comment path has the same gap at [wakeup-router.ts:260](/Users/mohsin/Github/safemolt/src/lib/events/consumers/wakeup-router.ts:260).

   Fix: use a source-aware wakeup writer. Lock posts, then comments, then agents in one statement.

3. **MAJOR** — [posts/memory.ts:105](/Users/mohsin/Github/safemolt/src/lib/store/posts/memory.ts:105)

   The memory post writer does not recheck the author after the mention-resolution wait at [actions/posts.ts:152](/Users/mohsin/Github/safemolt/src/lib/actions/posts.ts:152).

   This violates the memory-mode recheck invariant.

   A non-owner author can withdraw during mention resolution. Memory mode then creates an orphan post, a quota record, and events.

   PostgreSQL refuses the same write through its foreign keys.

   Fix: recheck `agents.has(authorId)` after event validation and before event preflight or quota mutation.

4. **MAJOR** — [agents/db.ts:664](/Users/mohsin/Github/safemolt/src/lib/store/agents/db.ts:664)

   The active-followee count includes hidden agents. The memory twin does the same at [agents/memory.ts:582](/Users/mohsin/Github/safemolt/src/lib/store/agents/memory.ts:582).

   This violates P6.4 and its hidden-agent exclusion rule.

   A user who follows one hidden agent can infer that hidden agent’s activity from the count.

   The count also uses `>=`. Thus, it includes an agent at exactly ten minutes. The public bucket excludes that agent.

   Fix: apply the public-hidden predicate and use a strict `>` cutoff in both stores.

5. **MINOR** — [posts/db.ts:123](/Users/mohsin/Github/safemolt/src/lib/store/posts/db.ts:123)

   The store adds `source_id` to every secondary event. It does not check for the store-assigned marker.

   The memory twin does the same at [posts/memory.ts:170](/Users/mohsin/Github/safemolt/src/lib/store/posts/memory.ts:170). Both comment stores use the same pattern.

   This exceeds P6.1 and the per-event substitution rule.

   A future secondary event with its own `source_id` will receive the post or comment ID instead.

   Fix: add the override only when that event contains `STORE_ASSIGNED_PAYLOAD_ID`.

6. **MINOR** — [hot-score.test.ts:90](/Users/mohsin/Github/safemolt/src/__tests__/lib/store/hot-score.test.ts:90)

   The hot-score tests run the TypeScript helper and the memory store only.

   This does not satisfy the P6.5 fixed-clock database parity gate.

   A wrong SQL formula, tie-break, or database call site will leave every current hot-score test green.

   Fix: run identical fixed-time fixtures through the database and memory hot-sort paths. Assert all four database sites.

7. **MINOR** — [mentions-e2e.test.ts:249](/Users/mohsin/Github/safemolt/src/__tests__/lib/events/mentions-e2e.test.ts:249)

   The tests check suppression behavior, but they do not test both drain orders or concurrent drainers.

   This does not satisfy the explicit gate in plan line 297.

   An implementation that checks for an existing reply wakeup can pass the current order and fail when the mention drains first.

   Fix: test mention-first, reply-first, and concurrent drain calls. Assert one total wakeup.

8. **NIT** — [actions/posts.ts:82](/Users/mohsin/Github/safemolt/src/lib/actions/posts.ts:82)

   The post and comment actions contain almost identical mention-resolution helpers.

   This conflicts with the lane’s KISS requirement.

   Fix: keep one shared resolver and pass the source type and school ID.

NOT CONVERGED
