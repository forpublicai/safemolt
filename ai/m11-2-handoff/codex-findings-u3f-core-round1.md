# u3f-core — codex review round 1

Prompt: `ai/m11-2-handoff/codex-u3f-review-core.md`. Model gpt-5.6-sol, `codex exec --sandbox
read-only`, solo. Verdict: NOT ready — **3 BLOCKER + 7 MAJOR**. Manifests + the Postgres accept
event gate are correct. Raw log: `codex-findings-u3f-core-round1-raw.log`.

Orchestrator adjudication: all 10 are REAL. Two (B2, M10) the orchestrator found independently
before the review returned. No pin is contradicted; the spec and agents.md resolve the two judgment
calls (B3, M4). Fix lanes: **admissions** and **classes** — disjoint files, two concurrent agents.

## BLOCKER

1. **db expiry sweep breaks the global lock order** (`admissions/store-db.ts:103`
   `refreshExpiredOffersDb`). It UPDATEs offers then applications with NO `agents` lock, while
   `deleteAgent` locks agents then cascades into applications/offers — a 40P01 cycle. `createOfferDb`'s
   internal sweep already has the `sweep_agents` CTE (agents `FOR KEY SHARE`, id-ordered) that this
   one is missing. The drain route calls this every 5 min, so the window is live. **ADOPT (admissions).**
   Fix: add the ordered `sweep_agents` CTE before the `expired` UPDATE, exactly as `createOfferDb` does.

2. **memory expiry driver emits no event and can release an active application**
   (`admissions/store-memory.ts:89` `refreshExpiredOffersMem`; the hardened twin is
   `expireLapsedOffersSync:311`). The public driver (`refreshExpired`→`refreshExpiredOffersMem`)
   appends no `admissions.offer_expired` (db `refreshExpiredOffersDb` does), and releases the
   application to `in_pool` without the "no other live offer" predicate the db side and
   `expireLapsedOffersSync` both apply. **ADOPT (admissions)** — found independently. Fix: one shared
   expiry helper that applies the live-offer predicate, collects the expired offers, preflights their
   per-offer `admissions.offer_expired` events and appends the batch through the dispatcher.

3. **an agent teaching-assistant emits `class.session_message`** (`messages/route.ts:66` +
   `actions/classes.ts:63`). The route only detects a human professor; an agent-assistant falls to
   `sendSessionMessage`, gets role `ta`, and EMITS — contradicting the spec's professor/TA operator
   branch (class-ops, history-silent). **ADOPT (classes), per the u3f-spec** ("the professor/TA
   branch moves behind class-ops … no event"). Fix: after `requireAgent`, detect `isClassAssistant`
   and route the TA through `addOperatorClassSessionMessage` (role `ta`, no event); `sendSessionMessage`
   then serves only enrolled students (role `student`, event). **JUDGMENT CALL — flagged for the user:
   this makes agent-TA class messages history-silent; the spec says so, but it is a product-semantics
   choice the user may veto (leaving TA emitting is the harmless-history alternative).**

## MAJOR

4. **class producer statements do not enforce the domain gates** (`actions/classes.ts:28/57/75`;
   `store/classes/db.ts:337/491/628`). Capacity, session-active, eval-active and enrollment are
   checked by UNLOCKED action pre-reads; the statements then INSERT/UPDATE with no such predicate, so
   a race breaches the cap / writes to a completed session AND emits the event on that wrong write.
   **ADOPT (classes), per agents.md** ("a refusal decided by a pre-read is decided from stale data;
   always reach the statement; classify from its flags"). Fix: gate each decisive statement on its
   domain rule (enroll: capacity + status + not-already-enrolled; message: session active + enrolled/
   assistant; eval-submit: eval active + enrolled), return outcome flags, gate the event on the row
   that passed. The action classifies from those flags. Both stores; memory re-checks after each await.

5. **db accept outcome comes from a post-transaction read** (`admissions/store-db.ts:597/609`
   `classifyAcceptOutcomeDb`). Acceptance commits its timestamp/audit/event; a decline committing
   before the follow-up read makes the accept return `invalid` although its effects (incl. the event)
   committed. **ADOPT (admissions).** Fix: return the outcome from a transaction element holding the
   locks (project the acceptance result from the decisive statement), not a later read.

6. **memory acceptance yields before finalization** (`admissions/store-memory.ts:440`
   `acceptOfferAsAgentMem`). It `await`s event dispatch BEFORE `tryFinalizeOfferMem`; a concurrent
   decline in that gap lets a no-human offer record acceptance+event then finish `declined` — the db
   batch finalizes atomically. **ADOPT (admissions).** Fix: run the synchronous finalization section
   before the first await; await dispatch only after all state changes.

7. **concurrent memory pool-ensures create duplicate applications** (`admissions/store-memory.ts:169`
   `ensureApplicationInPoolMem`). `await getAgentById` yields; two calls both pass the existing-check
   and both create an app + event, though PG's unique index permits one. **ADOPT (admissions), per the
   memory-preflight rule.** Fix: re-check `appKey`/`apps` synchronously after the last await, before
   writing.

8. **mutation paths bypass the action boundary** (`admissions/index.ts:184` inline
   `admissions.application_submitted` while `actions/admissions.ts:27 ensurePoolApplication` is dead;
   `accept/route.ts:31` + decline + `agent-tools/definitions/classes.ts:263/300` decide missing-
   resource refusals before their actions; `classes/[id]/route.ts:8` still imports `updateClass`).
   **ADOPT (split).** Admissions: the status-read lazy-ensure calls `ensurePoolApplication`; accept/
   decline routes classify from action flags, not pre-reads. Classes: the class-detail PATCH's
   `updateClass` moves behind a `class-ops` operator entry point (route imports no mutating store
   export); the two class tools stop pre-deciding refusals.

9. **adapters changed legacy wire shapes** (`actions/admissions.ts:15`+`application/route.ts:33`;
   `actions/classes.ts:20`+the class routes). E.g. no-open-cycle now 409 where the legacy route
   answered 503; hints and school-denial fields dropped. **ADOPT (split).** Fix: add stable `reason`
   values to the action results; each adapter maps them to the EXACT legacy status/title/hint/fields.
   Characterize the legacy shapes from `HEAD~2` (`a2585c5`, pre-implementation) FIRST and pin them.

10. **scoped tests do not prove the coupling** (`m11-2-u3f-core-characterization.test.ts:5` is
    import-text only; `ux6-contracts.test.ts` checks one mocked-store call). No test covers rollback,
    no-op events, expiry parity (db + memory), lock order, the assistant split, or the memory races.
    **ADOPT (split), found independently.** Fix: per producer — statement-shape + event-failure
    rollback + no-op-emits-nothing + memory-race tests; db-mode expiry integration (atomic
    offer_expired + write-free status read) and memory-mode expiry parity (emits offer_expired). Every
    fixture RUN-suffixed under UNIQUE columns.

## Fix plan
Two concurrent opus lanes on disjoint fences:
- **admissions**: B1, B2, M5, M6, M7, M8(admissions), M9(admissions), M10(admissions).
- **classes**: B3, M4, M8(classes), M9(classes), M10(classes).
Then orchestrator: full five gates, CORE codex re-review, iterate to convergence.
