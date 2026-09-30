# b1 Lane R — codex round-2 fix spec (reactions)

Findings: `ai/m11-2-handoff/codex-findings-b1-r-round2.md` — all seven ADJUDICATED valid; codex
OVERTURNED the two serializer deferrals (context, news), so items 8–9 join this round. Rules:
`b1-common-rules.md`. Fence = lane R's files + `src/lib/agent-senses/feed.ts`, `src/lib/agent-senses/
types.ts` (a `reactions` field on the post shape only), `src/app/api/v1/agents/me/context/serialize.ts`,
`src/app/api/v1/news/route.ts`.

1. **F1 no deadlock with withdrawal**: the rate-row lock is `FOR NO KEY UPDATE` (statement 1's
   seed uses `ON CONFLICT (agent_id) DO UPDATE SET reaction_count = agent_rate_limits.reaction_count`
   — a NON-key column — so no key lock is taken); the reaction insert's actor FK then takes its
   `FOR KEY SHARE` on the agent without conflicting. Integration test: a withdrawal holding the
   agent row overlaps a reaction ⇒ no `40P01`; one side refuses, nothing torn.
2. **F2 real overlaps for reaction-first + notification writer + rollback**: reaction-first with
   the tombstone UPDATE held on another connection (both subject types) ⇒ the delete then removes
   the reaction and its notification; the notification writer started while the tombstone is
   held blocks then refuses; force the tombstone statement to fail after the reaction cleanup
   element ran ⇒ the reaction row is back (rollback).
3. **F3 F5/F6 mutation evidence**: hold the seeded rate row on one connection while two identical
   requests contend ⇒ exactly one `added`, one `already_reacted`; force statement 2 to fail ⇒ the
   seed rolled back. Record suppress→fail→restore→green.
4. **F4 memory validates events first**: `addReaction`/`removeReaction` (memory) call the event
   preflight BEFORE the subject/duplicate/cap refusals (the db validates before any statement);
   batch-uniqueness stays before the write. Test: an invalid event on a missing subject throws
   in both stores.
5. **F5 emoji is a string**: both routes (POST and DELETE) answer 400 unless `body.emoji` is a
   string; tests with an object value.
6. **F6 serializer read test**: create reactions, call the post read route, the comments list
   route and the read tools, assert the exact non-empty `reactions` maps.
7. **F7 comment**: the reaction notification writer's comment keeps only the lock order and the
   cleanup anchor (≤ 5 lines).
8. **Context serializer** (deferral overturned): the senses feed gatherer attaches `reactions`
   (one batched `getReactionCounts` per page) to its post shape; `serialize.ts` stays pure and
   just emits the field; the parity gate keeps passing.
9. **News discussions** (deferral overturned): `news/route.ts` attaches live `reactions` counts to
   each `existing_discussions` entry with one batched read at request time (the RSS cache stays
   untouched).

Report: `ai/m11-2-handoff/b1-r-fix-r2-report.md`.
