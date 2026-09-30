# u3d fix round — findings [B]2, [B]4, [B]6 from the combined codex review

Repo: /Users/mohsin/Github/safemolt. Uncommitted tree; unit u3d (P1.4 playground slice) is implemented and under review. Full findings: /private/tmp/claude-501/-Users-mohsin-Github-safemolt/4cf0ac78-0abd-449a-bed2-5ef83d9016ff/tasks/b6xnanyop.output — read the [B] items first. Fix EXACTLY these three. agents.md's invariants BIND you; the one you are restoring is CLAUDE.md's: **"A transitional projection must be written by the statement that emitted its event."**

## Finding 2 — BLOCKER: u3d's transitional activity writers are post-commit second statements
Every u3d db producer (join, action submission, cancellation, expiry, resolution completion, lifetime-cap completion) commits its mutation + event first, then calls the best-effort activity wrapper in a second statement — whose failure is swallowed. A crash in the gap leaves the event committed with no legacy projection (and the drain then stamps legacy_missing).
Fix: splice each activity upsert INTO the decisive CTE statement, taking the emitted event id and created_at directly (the u3b comment precedent: buildCommentActivityUpsertCte; the u3c group-join precedent). Expiry needs a per-row upsert correlated by subject. Mirror the atomic sections in memory mode (synchronous, no await between mutation, append and projection). The swallowing wrappers remain ONLY for call sites that are not u3d producers. Update DECLARED_LEGACY_WRITERS anchors (pattern + count) for every moved writer — the manifest test must keep passing. Mutation-check at least one producer: write a failure-injection or crash-window test proving the projection and event commit together.

## Finding 4 — MAJOR: the lifetime-cap sweep can be starved
The sweep examines only the 50 newest active sessions; with continuous creation an overdue older session is never examined.
Fix: query cap-eligible sessions directly — the age predicate in the store query, ordered by COALESCE(started_at, created_at) ASC — and page until no due candidate remains. Test: 51+ actives where only the oldest is overdue ⇒ it completes.

## Finding 6 — MINOR: trigger route JSON null escapes the envelope
`req.json()` may resolve to null; the destructure throws outside the catch.
Fix: parse to unknown, accept only non-null objects before destructuring; characterization case for a `null` body pinning the error envelope.

## Fences
Do NOT edit: legacy-compare.ts, consumers/dispatch.ts, the twin readers in store/notifications/*, scripts/soak-shadow-report.sql (a second fix round owns the [A] findings next), evaluations files (another agent owns them RIGHT NOW), karma anything. Your surface: store/playground/{db,memory}.ts, store/activity/{events,index}.ts (builders for YOUR kinds only), playground/{session-manager,lifecycle}.ts, coverage.ts anchors, the trigger route, u3d test files, inventory runbook note.

## Gates
npx tsc --noEmit && npm run lint && npm test -- --runInBand && npm run test:integration -- --testPathPattern="m11-2-u3d-playground|m11-2-u4prep-soak-report" && npm run build. (The advisory lock serializes; another agent may hold it — wait.) Report per finding + the mutation-check evidence + gates.
