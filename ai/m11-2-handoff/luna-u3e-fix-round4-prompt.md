# Implementation task — u3e fix round 4: repair two pinned-contract regressions + two harness defects

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree on `ops/code-improve` — do NOT commit, do NOT run any git write command.

Round 3 implemented the round-2 findings, but the full integration run then failed 3 suites. Two are a REAL regression from the vetting fix; one is harness dirt. Fix all three. Binding context: agents.md karma + D4 + prepared-events + memory-preflight invariants.

## Item 1 — the vetting outcome regression (the important one)
Round 3 made every `completeVetting` call that does not win the `is_vetted = false` transition return `unavailable` with its challenge unconsumed. That contradicts the PINNED contract, and the pinned suites are authoritative over the review prescription that suggested it:
- `src/__tests__/integration/c14-vetting-durability.test.ts` "an already-passed bootstrap evaluation gains no second registration or result": a SEQUENTIAL second completeVetting with a fresh valid challenge on an already-vetted agent answers `completed` with `bootstrap: []` and consumes that challenge. Currently fails with `unavailable`.
- `src/__tests__/integration/m11-1c-karma-components.test.ts` "C14 parity › consumes the vetting challenge exactly once...": its `seedAgent` creates agents with `is_vetted = true`, and the FIRST completeVetting still answers `completed`, inserts the bootstrap evaluations, recomputes points and consumes the challenge. Currently fails with `unavailable`.

Required semantics (both stores, identical):
- The batch keeps its ensure-semantics for EVERY caller holding a valid unconsumed challenge: consume that challenge, ensure the two bootstrap evaluations (already-passed gate means no second rows), run the points recompute, answer `completed`.
- ONLY these gate on the winning unvetted decision (the round-3 decision token): the `is_vetted` flip itself and the `agent.vetted` EVENT. Per-contract `evaluation.completed` events fire only for bootstrap results actually INSERTED by this call (the ensure gate already decides that).
- Net effect for the concurrent two-challenge race: both calls answer `completed`, both challenges end consumed, exactly ONE `agent.vetted` event, exactly one set of bootstrap rows, recompute correct. Update the round-2/3 race tests that pinned `unavailable` for the loser — they must now assert THIS. The pinned suites (c14, m11-1c) must pass UNTOUCHED.
Do not weaken the FOR UPDATE agent lock or reorder the batch. Mutation-check: with the fix in place, temporarily re-gate the challenge consumption on the decision token → c14's sequential test must fail → restore.

## Item 2 — c25 fixture fragility (harness)
`src/__tests__/integration/c25-deletion-veto.test.ts` (~line 393) creates a deliberately WRONG-SHAPED foreign key (`posts.deleted_by_agent_id REFERENCES groups(id)`) as a fixture. `ALTER TABLE ... ADD CONSTRAINT` VALIDATES existing rows, so any leftover soft-deleted post from an interrupted earlier run fails the fixture — that happened in the last full run. Add `NOT VALID` to that fixture constraint (and any sibling fixture FK in the same describe with the same exposure). The catalog shape the C25 migration inspects is unchanged; the fixture stops depending on unrelated table content. Change ONLY the fixture statements, nothing about what the migration test asserts.

## Item 3 — u4prep teardown leaves cross-run dirt (harness)
An interrupted run left the row `posts.id = 'post_1786485140575_9jqxpeq'` (author `u4p_agent_msp73vlk_jsyl_9`) in the reserved integration DB — it is what broke c25. The `afterAll` of `src/__tests__/integration/m11-2-u4prep-soak-report.test.ts` cleans only its own `RUN` tag, so dirt from a dead run survives forever. Make the suite's cleanup ALSO sweep rows whose ids/authors/groups match the bare `u4p_%` prefix regardless of RUN (that prefix belongs exclusively to this suite), in the same FK-safe order the afterAll already uses — comments, posts, group_members, groups, following, rate limits, notifications, activity_events, agents. Run it in `beforeAll` (sweep stale dirt before the suite starts) — the existing per-RUN afterAll stays as is. The next full run must clean the orphan above.

## Fences
Item 1: src/lib/store/agents/{db,memory}.ts, src/lib/actions/agents.ts if its rendering must follow, the u3e race tests. Items 2–3: only the two named test files. Nothing else. karma-writer-ownership must not change; c14 and m11-1c test FILES stay byte-identical.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration && npm run build. All five must pass — including c14, m11-1c and c25. Advisory lock: wait if held. Known flake: c13a — re-run before concluding. Piped commands report the pipe tail's exit code — read jest's summary lines.

## Report
Per item: files changed, test changes, mutation-check evidence. Then the five gate results verbatim (suite/test counts).
