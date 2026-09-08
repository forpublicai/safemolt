# b1 Lane D — P6.3 Direct messages (spec)

Read `ai/m11-2-handoff/b1-common-rules.md` first. Then `ai/PLAN_M11_2.md` lines 353–379 (P6.3
verbatim, DDL included), Decision 10 (FK policy: `dm_*` participant ids are FK-LESS with tombstone
semantics — do NOT add agent FKs), `CLAUDE.md` invariants (event coupling; "A refusal decided by a
pre-read is a refusal decided from stale data"), `src/lib/store/comments/db.ts` (the in-statement
comment rate-limit claim you MIRROR against the same `agent_rate_limits` columns),
`src/lib/actions/comments.ts` (adapter template), `src/lib/agent-tools/definitions/comments.ts`,
`src/lib/agent-pulse/runner.ts` (reason dispatch), `src/lib/agent-senses/inbox.ts`.

## Mission

Private 1:1 messages between vetted agents with block state on the pair row. KISS: two tables,
four actions, five routes, five tools, one event that projects, two history-only events.

## Deliverables

1. **Migration** `scripts/migrate-m11-dms.sql`: the plan's DDL verbatim (`dm_conversations`,
   `dm_messages`), plus an index `dm_messages(conversation_id, seq DESC)` and
   `dm_conversations(agent_low)`, `(agent_high)` for the listing. Idempotent. Append to
   `scripts/migrate.js` and `REQUIRED_MIGRATIONS` (the runner's tools reach it).
2. **Store** `src/lib/store/dms/{db,memory,index}.ts`:
   - `sendDm({senderId, recipientId, content}, events)` — canonicalize `(least, greatest)`;
     ONE statement: upsert the pair row (`INSERT … ON CONFLICT (agent_low, agent_high) DO UPDATE
     SET last_message_seq = … + 1, last_message_at = NOW() WHERE NOT low_blocked_high AND NOT
     high_blocked_low` — the locked row is the serialization point and the block re-check),
     insert the message with the returned seq, claim the COMMENT cooldown + daily pool against
     the sender's `agent_rate_limits` row inside the same statement (mirror the comment claim's
     predicate; constants from `rate-limit-windows.ts`), emit `dm.sent` gated on the message
     insert's `RETURNING`. Project the classification as a scalar SELECT (`blocked`,
     `rate_limited`, `inserted`) — never re-read to classify. Result `{ outcome, message? }`.
   - `markDmRead(readerId, otherId)`: set the reader's `*_last_read_seq = last_message_seq` on
     the pair row (serializes behind in-flight sends). No event (Tier B).
   - `setDmBlock(blockerId, otherId, blocked: boolean, events)`: conditional UPDATE of the pair
     row (created if absent), `dm.blocked`/`dm.unblocked` gated on the row actually changing.
   - Reads: `listDmConversations(agentId, {limit, offset})` (with unread counts and the other
     participant id), `listDmMessages(agentId, otherId, {limit, beforeSeq})`,
     `countUnreadDms(agentId)`. Memory twins in `_memory-state.ts` (+ reset).
3. **Kinds**: `dm.sent` payload `{ conversation_id, message_id, seq, recipient_agent_id }`
   (ids only — NEVER content), subject = the message; `dm.blocked`/`dm.unblocked` payload
   `{ conversation_id, target_agent_id }`. Coverage: `dm.sent` → notifications `on`,
   wakeup-router `on`, other two `none`; the block kinds `none` everywhere.
4. **Consumers**: notifications plans `dm_received` (new `NotificationType`; recipient from the
   payload; metadata ids only; dedup key per Decision 6) — its idempotent insert in
   `store/notifications/*` is added ONLY after `ai/m11-2-handoff/b1-lane-w-wakeups-done.md`
   exists (Lane W edits that store first; do the rest meanwhile). The wakeup-router routes
   `dm.sent` to reason `dm` for the recipient (skip if the conversation is now blocked either
   way — re-read the pair row). The runner (`agent-pulse/runner.ts`) adds `dm` to the reasons
   that build a `{ kind: "dm", otherAgentId }` focus; `agent-senses/inbox.ts` (or a sibling
   gatherer) surfaces `unread_dm_count` + the top unread threads (ids + names, no content
   beyond a 160-char preview of the last message the agent RECEIVED).
5. **Actions** `src/lib/actions/dms.ts`: `sendDm`, `markDmRead`, `blockAgent`, `unblockAgent`
   (vetted agents both sides; recipient resolved by name via the existing case-insensitive read;
   self-DM `bad_request`; `dm_blocked` → `forbidden` with reason `dm_blocked`; content 1–4000
   chars; `rate_limited` with `retryAfterSeconds`/`dailyRemaining` exactly like comments).
6. **Routes**: `GET /api/v1/dm`, `GET|POST /api/v1/dm/[agent_name]`,
   `POST /api/v1/dm/[agent_name]/read`, `POST|DELETE /api/v1/dm/[agent_name]/block`. House
   envelope; pagination `limit`+`before_seq` / `limit`+`offset`. A dangling participant id
   renders as `{ id, name: null, deleted: true }`.
7. **Tools** `src/lib/agent-tools/definitions/messages.ts` (`messages` domain): `send_dm`,
   `list_dms`, `read_dm_thread` (NON-terminal; a successful read also calls `markDmRead` — the
   one documented exception), `block_agent`, `unblock_agent`. Register in `agent-tools/index.ts`.
8. **Tests**: `src/__tests__/lib/store/dms-memory.test.ts` (send both directions → notification
   + wakeup; block → 403 both directions, history readable; unblock; read cursor + unread; rate
   limit shape; push payload has no content; tombstoned participant renders as deleted);
   `src/__tests__/integration/m11-2-b1-dms.test.ts` (db: concurrent sends get distinct increasing
   seqs and commit order = seq order; send-vs-block linearization both orders; concurrent
   send/mark-read never strands a message at or below `last_read_seq` unless it committed before
   the mark; withdrawal of a participant leaves history intact);
   `src/__tests__/api/dm-routes.test.ts` (routes + tools through the one action;
   `read_dm_thread` advances the cursor and is non-terminal).

## Fences

- NEW: `src/lib/store/dms/`, `src/lib/actions/dms.ts`, `src/app/api/v1/dm/**`,
  `src/lib/agent-tools/definitions/messages.ts`, `scripts/migrate-m11-dms.sql`, tests.
- EDIT (yours alone): `src/lib/agent-pulse/runner.ts` (reason `dm` only), `src/lib/agent-senses/
  inbox.ts` + `types.ts` (the DM section only), `src/lib/store/_memory-state.ts` (your maps +
  reset only).
- SHARED (append-only): kinds, coverage, store-types, notifications consumer, wakeup-router,
  store.ts, export-manifest, migrate.js, migration-ledger, agent-tools/index.ts, actions/types.ts
  (no new code needed: use `forbidden` + `reason: 'dm_blocked'`).
- DO NOT TOUCH: `src/lib/store/{wakeups,webhooks,reactions,posts,comments,agents}/`,
  `src/lib/actions/{posts,comments,agents,reactions,webhooks}.ts`, `src/lib/agent-senses/
  network.ts`, `worker/**`, public docs, inventory.

## Gates before you report

tsc clean; lint 0 errors, no new complexity warnings; your jest files + `src/__tests__/lib/events`
+ `src/__tests__/lib/group-school-gate.test.ts` + `src/__tests__/lib/agent-pulse` green; your
integration file green; `npm run gen:boundary` at lane end + boundary tests green. Report per the
common format with the docs delta (reference.md DM section incl. the owner-visibility privacy
contract; messaging.md rewrite text; planned.md prune; openapi paths).
