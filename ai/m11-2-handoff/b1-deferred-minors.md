# b1 deferred MINOR/NIT items (per b1-convergence-policy.md item 1)

| Lane | Round | Finding | Reason deferred |
|---|---|---|---|
| R | 5 | MINOR — guard test disables autonomy before the reaction starts; a lock-free token check would pass; wants an uncommitted-disable contention test (`m11-2-b1-reactions.test.ts:667`) | lane converged (no MAJOR); the guard is gated in-statement per r3/r4 and the disabled-before case is covered |
| R | 5 | MINOR — composite-key collision test uses different emojis per subject type, so dropping `subjectType` from the key is undetected (`reactions-memory.test.ts:117`) | lane converged; the PK includes `subject_type` by migration DDL |
| R | 5 | NIT — comments > 5 lines in `reactions/db.ts:152` and `notifications/memory.ts:443`; one claims a non-insert leaves the rate table untouched | lane converged; cosmetic |
| M | 6 | MINOR — `presence-writer.test.ts` scanner attributes a write after a function's closing brace to that function (an arrow function after the allowed touch could pass) | lane converged; the scanner still catches every write site the codebase has; harden when the next writer appears |
| M | 6 | MINOR — lock-order test's final assertion accepts a `23503` rejection as "not null" (`m11-2-b1-mentions.test.ts:637`); should assert `settled.ok === true` and a mention notification | lane converged; one-line test tightening, no behavior at stake |
| M | 6 | NIT — six-line comment in `wakeup-router.ts:238` repeats the suppression rule | lane converged; cosmetic |
