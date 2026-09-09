# b1 Lane M — codex round-4 fix spec (mentions / presence / hot)

Findings: `ai/m11-2-handoff/codex-findings-b1-m-round4.md` — all four ADJUDICATED valid; the
round-1 F2 deferral is UPHELD (fourth time; leave it). Rules: `b1-common-rules.md`. Fence = lane M.

1. **F1 source-comment liveness**: `createMentionNotificationIdempotent` (db + memory) for a
   comment source locks the live post (`FOR SHARE`) THEN the source comment (`FOR SHARE`, verify
   `post_id`) THEN the recipient; a missing comment ⇒ no insert. Memory re-checks the comment.
   Test: comment author withdraws after the event, before the drain ⇒ no notification.
2. **F2 recipient visibility under FOR SHARE**: the recipient lock becomes `FOR SHARE` (taken after
   the source locks) so a concurrent metadata update cannot slip in. Test: hold a metadata update
   open (`test: true`), start the writer, commit the update ⇒ the writer refuses.
3. **F3 JSON boolean predicate parity**: the SQL hidden predicate compares `metadata->'test'` and
   `metadata->'system'` to JSON `true` (`= 'true'::jsonb`), and `metadata->>'source' = 'test'`,
   exactly as `isPubliclyHiddenAgent` does in JS; one shared SQL fragment used by `listAgents`
   and the mention writer. Tests for boolean, string `"true"`, absent and null.
4. **F4 one predicate**: `listAgents` (db) builds the hidden/presence predicate once and reuses it
   across the sort branches through the parameterized SQL interface; drop the repair-history
   comment.

Report: `ai/m11-2-handoff/b1-m-fix-r4-report.md`.
