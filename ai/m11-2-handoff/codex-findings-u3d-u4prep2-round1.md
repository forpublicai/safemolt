
4. **[B] MAJOR — the lifetime-cap CAS can be starved before it is called.**  
   [lifecycle.ts](/Users/mohsin/Github/safemolt/src/lib/playground/lifecycle.ts:47), [db.ts](/Users/mohsin/Github/safemolt/src/lib/store/playground/db.ts:224)

   The CAS itself correctly admits only one concurrent completion, but the sweep examines only the 50 newest active sessions. With 51 active sessions, the oldest can already exceed the cap while the newest 50 are still young; every sweep skips those 50 and never examines the overdue session. Continuous creation can strand it indefinitely.

   Minimal fix: query cap-eligible sessions directly, ordered by `COALESCE(started_at,created_at)` ascending, and page until no due candidates remain. Prefer putting the age predicate in the store query.

5. **[A] MINOR — one missing playground shadow row is attributed to six event kinds.**  
   [soak-shadow-report.sql](/Users/mohsin/Github/safemolt/scripts/soak-shadow-report.sql:181), [soak-shadow-report.sql](/Users/mohsin/Github/safemolt/scripts/soak-shadow-report.sql:202)

   `kind_map` maps `playground_session` to six event kinds. `act_legacy` expands one activity row into all six, while `act_legacy_events` never requires the joined event’s actual kind to equal the mapped kind. If a `session_joined` legacy row lacks its shadow twin, `legacy_only` increments all six lifecycle summaries, falsely turning five `no_data` pairs into anomalies.

   Minimal fix: carry `e.kind` through `act_legacy_events` and require it to equal `kind_map.event_kind` whenever the source event resolves.

6. **[B] MINOR — valid JSON `null` escapes the trigger route’s response envelope.**  
   [route.ts](/Users/mohsin/Github/safemolt/src/app/api/v1/playground/sessions/trigger/route.ts:24)

   `req.json()` may return `null`, which is assigned to a compile-time-only `Record<string, unknown>`. The destructuring at line 31 then throws outside the route’s catch. Previously the outer catch returned the established JSON error envelope; now the framework handles the rejection.

   Minimal fix: parse to `unknown` and accept it only when it is a non-null object before destructuring.

**Unit A verdict:** Not flip-safe. The comparison exception boundary itself is well-contained, the notification/activity canonical mappers correctly detect right-key/wrong-content mismatches, and the quoted-literal report interface is sound. However, mutable activity-key supersession and the describe/read deletion window invalidate the claim that every `legacy_missing` is verdict-bearing. The report also misattributes playground `legacy_only` rows.

**Unit B verdict:** The join statement, distinct CTE prefixes, pinned parameter boundary, action-insert gating, cancellation/expiry transition gates, manifest deviation for ingest, additive statement renderer changes, and karma isolation look correct. The two small helper files are justified. Release is nevertheless blocked because every u3d transitional activity writer remains outside the emitting statement; additionally, the lifetime-cap caller can starve overdue sessions.

Verification: TypeScript passed with `tsc --noEmit --incremental false`, and `git diff --check` was clean. Focused Jest execution could not start because the read-only sandbox denied Jest’s temporary haste-map write. No files were modified.
tokens used
276,328
1. **[A] BLOCKER — reusable activity keys turn routine supersession into `legacy_missing`.**  
   [activity-trail.ts](/Users/mohsin/Github/safemolt/src/lib/events/consumers/activity-trail.ts:381), [soak-shadow-report.sql](/Users/mohsin/Github/safemolt/scripts/soak-shadow-report.sql:22)

   The twin reader requires `source_event_id === event.id`; any other source becomes verdict-bearing `legacy_missing`. Playground lifecycle events all reuse `playground_session:{sessionId}`. A session can be created, joined twice, and activated before the five-minute drain runs. The latest inline upsert replaces `source_event_id`, so every earlier event stamps `legacy_missing` despite both writers behaving correctly. This will make a normal playground soak permanently non-clean and also prevents `legacy_only` from detecting overwritten older effects.

   Minimal fix: preserve an immutable per-event legacy comparison snapshot keyed by `(consumer,event_id,effect_key)` in the emitting statement, or introduce an explicit superseded verdict backed by durable evidence. Comparing only the mutable current activity row cannot prove per-event parity.

2. **[B] BLOCKER — u3d’s transitional activity projection is not committed with its event.**  
   [db.ts](/Users/mohsin/Github/safemolt/src/lib/store/playground/db.ts:174), [db.ts](/Users/mohsin/Github/safemolt/src/lib/store/playground/db.ts:187), [events.ts](/Users/mohsin/Github/safemolt/src/lib/store/activity/events.ts:869)

   Every u3d DB producer commits its mutation and event first, then calls the best-effort activity writer in a second statement. The same pattern appears for cancellation, expiry, join, action submission, resolution completion, and lifetime-cap completion. The activity wrapper catches and suppresses its own failure.

   A process termination or activity-upsert error after the first statement leaves the event committed but the shadow mode’s real legacy effect absent. The drain then records `legacy_missing`; worse, the public trail remains missing because `shadow` only records diagnostics. This contradicts the prepared-event invariant that a transitional projection be written by the statement emitting its event.

   Minimal fix: splice the activity upsert into each decisive CTE statement, taking the emitted event ID directly. Expiry needs a per-row upsert correlated by subject. Mirror the atomic section in memory mode.

3. **[A] MAJOR — a correct concurrent deletion can still produce verdict-bearing `legacy_missing`.**  
   [notifications.ts](/Users/mohsin/Github/safemolt/src/lib/events/consumers/notifications.ts:234), [notifications.ts](/Users/mohsin/Github/safemolt/src/lib/events/consumers/notifications.ts:256), [activity-trail.ts](/Users/mohsin/Github/safemolt/src/lib/events/consumers/activity-trail.ts:372)

   `describe` and `readLegacyTwin` are separate auto-committed queries. Although `describe` locks the live subject, that lock ends when its query returns. A post can then be deleted—correctly removing its activity and notification projections—before the twin lookup. The lookup stamps `legacy_missing`, even though the subject was no longer live at comparison time.

   Thus the defense that “a stamp proves describe re-fetched a live subject” does not make every missing verdict anomalous; it proves liveness only at an earlier instant.

   Minimal fix: make each twin lookup revalidate and lock its subject in the same query that reads the legacy row. Return `unverifiable` when that locked subject is gone. Activity still separately needs the supersession solution from finding 1.

4. **[B] MAJOR — the lifetime-cap CAS can be starved before it is called.**  
   [lifecycle.ts](/Users/mohsin/Github/safemolt/src/lib/playground/lifecycle.ts:47), [db.ts](/Users/mohsin/Github/safemolt/src/lib/store/playground/db.ts:224)

   The CAS itself correctly admits only one concurrent completion, but the sweep examines only the 50 newest active sessions. With 51 active sessions, the oldest can already exceed the cap while the newest 50 are still young; every sweep skips those 50 and never examines the overdue session. Continuous creation can strand it indefinitely.

   Minimal fix: query cap-eligible sessions directly, ordered by `COALESCE(started_at,created_at)` ascending, and page until no due candidates remain. Prefer putting the age predicate in the store query.

5. **[A] MINOR — one missing playground shadow row is attributed to six event kinds.**  
   [soak-shadow-report.sql](/Users/mohsin/Github/safemolt/scripts/soak-shadow-report.sql:181), [soak-shadow-report.sql](/Users/mohsin/Github/safemolt/scripts/soak-shadow-report.sql:202)

   `kind_map` maps `playground_session` to six event kinds. `act_legacy` expands one activity row into all six, while `act_legacy_events` never requires the joined event’s actual kind to equal the mapped kind. If a `session_joined` legacy row lacks its shadow twin, `legacy_only` increments all six lifecycle summaries, falsely turning five `no_data` pairs into anomalies.

   Minimal fix: carry `e.kind` through `act_legacy_events` and require it to equal `kind_map.event_kind` whenever the source event resolves.

6. **[B] MINOR — valid JSON `null` escapes the trigger route’s response envelope.**  
   [route.ts](/Users/mohsin/Github/safemolt/src/app/api/v1/playground/sessions/trigger/route.ts:24)

   `req.json()` may return `null`, which is assigned to a compile-time-only `Record<string, unknown>`. The destructuring at line 31 then throws outside the route’s catch. Previously the outer catch returned the established JSON error envelope; now the framework handles the rejection.

   Minimal fix: parse to `unknown` and accept it only when it is a non-null object before destructuring.

**Unit A verdict:** Not flip-safe. The comparison exception boundary itself is well-contained, the notification/activity canonical mappers correctly detect right-key/wrong-content mismatches, and the quoted-literal report interface is sound. However, mutable activity-key supersession and the describe/read deletion window invalidate the claim that every `legacy_missing` is verdict-bearing. The report also misattributes playground `legacy_only` rows.

**Unit B verdict:** The join statement, distinct CTE prefixes, pinned parameter boundary, action-insert gating, cancellation/expiry transition gates, manifest deviation for ingest, additive statement renderer changes, and karma isolation look correct. The two small helper files are justified. Release is nevertheless blocked because every u3d transitional activity writer remains outside the emitting statement; additionally, the lifetime-cap caller can starve overdue sessions.

Verification: TypeScript passed with `tsc --noEmit --incremental false`, and `git diff --check` was clean. Focused Jest execution could not start because the read-only sandbox denied Jest’s temporary haste-map write. No files were modified.
