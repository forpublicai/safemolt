Deep code review, repo /Users/mohsin/Github/safemolt (read-only). The uncommitted tree implements M11-2 units u1–u3b (22+ review rounds — do NOT re-review them). Review ONLY the new shadow-soak report tool: scripts/soak-shadow-report.sql, src/__tests__/integration/m11-2-u4prep-soak-report.test.ts, and the "Soak report" paragraph at the end of ai/validation/m11-inventory.md §8.

Context to read first: ai/PLAN_M11_2.md's Scope section ("Shadow mode is defined and mechanically comparable" paragraph — normative for WHAT the soak compares); ai/validation/m11-inventory.md §8 (Protocol M; the round-2 KEY-ONLY deletion amendment; the round-3 volatile-fields amendment; the NULL-key rollout residual); src/lib/events/consumers/dispatch.ts (how shadow rows are written); scripts/migrate-m11-consumers.sql (the shadow table); the natural keys in src/lib/events/consumers/{notifications,activity-trail}.ts.

The tool's purpose: the operator-facing flip-precondition report — per (consumer, kind) in shadow over a window: shadow_only keys, legacy_only keys (excluding NULL-keyed rollout residuals, counted separately as uncorrelatable), payload mismatches where keys match, deletion kinds key-only, and a summary with the verdict rule (flip-clean = shadow_only = legacy_only = payload_mismatches = 0).

Priorities:
1. **Correctness of each bucket's SQL**: does shadow_only/legacy_only/payload_mismatch classify exactly right for notifications (dedup_key correlation) and activity-trail (natural key + source_event_id)? Off-by-one in the window bounds? Does the DISTINCT ON latest-per-key collapse for reused keys (agent.followed) do what its comment claims — and does it risk masking a real mismatch?
2. **Read-only claim**: no statement writes; safe against production.
3. **Payload comparison fidelity**: does the column mapping compare what the shadow payload actually stores (volatile fields already stripped at write time — the report must not re-strip or re-derive)? Would a right-key/wrong-content consumer actually land in payload_mismatches (the plan's requirement)?
4. **The test proves the shipped file**: it loads and executes the real SQL text (after psql meta-command stripping) — is the stripping/rebinding faithful, or could the tested text diverge from what an operator runs? Do the fixtures go through REAL producers/drain (not hand-inserted shadow rows) where the spec demands?
5. **False-clean risks**: any way the report reads 0 anomalies while the soak actually failed (empty window, wrong consumer name literal, kind filter typo, NULL handling in joins)?
6. **Bloat/altitude**: is anything in the 241 lines machinery the report doesn't need? Is the inventory note accurate and minimal?

Report: numbered findings with file:line, severity (BLOCKER/MAJOR/MINOR/NIT), concrete failure scenario, minimal fix. One-paragraph verdict. Do not modify files.
