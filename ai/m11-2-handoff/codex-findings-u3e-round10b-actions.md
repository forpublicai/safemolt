1. **MAJOR** — Certification refusal behavior has no route evidence.  
   Files: [characterization test](/Users/mohsin/Github/safemolt/src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:373), [submit route](/Users/mohsin/Github/safemolt/src/app/api/v1/evaluations/[id]/submit/route.ts:27)  
   The scoped tests cover only ordinary self-serve submission. They do not test absent, `null`, string, or object certification transcripts. A regression could return 500, or use the wrong title, while all scoped tests pass.  
   Minimal fix: add a route table for absent/`null` → `Missing transcript`, and string/object → `Submission rejected`, with exact status and body checks.

2. **MAJOR** — The claimed lifecycle adapter evidence is incomplete.  
   Files: [route imports](/Users/mohsin/Github/safemolt/src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:38), [complete-vetting action test](/Users/mohsin/Github/safemolt/src/__tests__/lib/actions/evaluations.test.ts:756), [memory outcome tests](/Users/mohsin/Github/safemolt/src/__tests__/lib/store/agents/complete-vetting-memory.test.ts:61)  
   The characterization suite does not call the Cognito claim route, X verify route, or vetting-complete route. The action test checks only `consumed_challenge`. The memory tests often check only `outcome: "unavailable"`, not the decisive reason. A regression that reports a live losing challenge as expired, or a lost-response retry as `challenge_not_found`, can pass this evidence.  
   Minimal fix: add exact action and route cases for `already_vetted`, expired, mismatch, consumed, and not found. Add the required live-challenge race and lost-response retry cases. Characterize both claim routes too.

3. **MAJOR** — The negative-authorization evidence is not the required single exact-code table.  
   File: [characterization test](/Users/mohsin/Github/safemolt/src/__tests__/api/v1/m11-2-u3e-evaluations-characterization.test.ts:808)  
   The five operations are split across two tables. The first table does not retain or assert the route status. Both tables use substring checks instead of exact route and tool codes. A route can return the wrong status or envelope code and still pass if the expected text is present.  
   Minimal fix: merge all five operations into one table. For each adapter, assert the exact HTTP status, route `error_detail.code`, tool code, and the full before/after state snapshot including the event log.

4. **MAJOR** — The route-versus-tool completion race does not verify either adapter’s response contract.  
   File: [integration race test](/Users/mohsin/Github/safemolt/src/__tests__/integration/m11-2-u3e-evaluations.test.ts:632)  
   Each result is reduced to a Boolean, and the test only checks that both values are Booleans. Both adapters could report failure, or one could return an invalid response, while the one-row/one-event database assertions still pass. The test also does not establish the valid response for each possible winner.  
   Minimal fix: retain the route status/body and the complete tool result. Assert the legal winner and loser responses, while keeping the one-result and one-event checks.

5. **MINOR** — The certification refusal switch is not type-safe at its boundary.  
   File: [submit route](/Users/mohsin/Github/safemolt/src/app/api/v1/evaluations/[id]/submit/route.ts:35)  
   `submitted.reason` is cast to `CertificationRefusalReason`. This makes the `never` check ineffective: if the action adds or misspells a reason, TypeScript still accepts the route. At runtime, the default branch returns that unknown reason as the response title.  
   Minimal fix: make `submitCertificationTranscriptAction` return a discriminated refusal union that uses `CertificationRefusalReason`, then remove the cast.

6. **NIT** — Vetting completion retains unreachable rendering code and obsolete comments.  
   Files: [complete route](/Users/mohsin/Github/safemolt/src/app/api/v1/agents/vetting/complete/route.ts:103), [complete route](/Users/mohsin/Github/safemolt/src/app/api/v1/agents/vetting/complete/route.ts:119), [agent action](/Users/mohsin/Github/safemolt/src/lib/actions/agents.ts:347)  
   The action converts every refused store outcome to `ok: false`, and converts `already_vetted` to defined idempotent success. Therefore, the route’s `result.outcome === "unavailable"` branch cannot run. The comments still say that the adapter re-reads and classifies outcomes. This can mislead later work into restoring the removed stale-read behavior.  
   Minimal fix: delete the unreachable branch and update the comments to state that the action classifies the decisive outcome.

Verdict: no blocker was found in the event manifests. The nine history-only kinds are `none`, `evaluation.completed` is correctly `legacy`, and its four declared writer counts match the two stores. The deprecation payload also has the required shape and keeps enforcement at M11b/P6.1. However, the review is not clean because several explicit round contracts are not proven by the scoped tests, especially certification refusals, vetting outcome classification, denial parity, and adapter-race responses. I did not run tests or modify files.
