# b1 Lane W — codex round-1 fix spec (webhooks)

Findings: `ai/m11-2-handoff/codex-findings-b1-w-round1.md` (all nine ADJUDICATED as valid against
`CLAUDE.md`/`agents.md` invariants and P5.1). Rules: `ai/m11-2-handoff/b1-common-rules.md` (KISS,
complexity ≤ 12, WHY-only short comments, no git/codex/build, targeted jest + targeted integration,
mutation-check every behavioral fix and record the evidence verbatim). Fence = lane W's files only.

1. **Auto-disable disposition** (F1): the tenth-failure UPDATE that sets `disabled_at` must, in the
   SAME statement, terminalize every unclaimed-or-expired ledger row of that agent
   (`terminal_reason='webhook_disabled'`) and complete each row's webhook-PRIMARY wakeup
   (`result='webhook_disabled'`); `mode='both'` ledgers terminalize without touching internal
   wakeups. The row that triggered the tenth failure terminalizes too (its post-attempt fenced
   update finds the registration disabled). `webhook-pass.ts` must NOT deliver when the claim
   returns `disabledAt` — record the attempt as terminal instead. Memory twin identical.
2. **Re-arm resets the ledger** (F2): in every enqueue/re-arm path, the ledger insert becomes
   `ON CONFLICT (wakeup_id) DO UPDATE` that resets `attempts, delivered_at, terminal_reason,
   claimed_at, claim_token, lease_expires_at, next_attempt_at` ONLY when the wakeup was actually
   re-armed (gate on the re-arm CTE's RETURNING). Both stores.
3. **Registration liveness is a lock** (F3): the enqueue ledger CTE reads the registration with
   `FOR SHARE` (`disabled_at IS NULL`) and gates BOTH the `mode='both'` ledger and the
   webhook-primary path on that locked row — a bare `EXISTS` is snapshot-evaluated.
4. **Delete terminalizes expired claims** (F4): `deleteAgentWebhook` (and the auto-disable of
   item 1) terminalize rows where `claimed_at IS NULL OR lease_expires_at < NOW()`; only a LIVE
   lease is left to its claimant's post-attempt fenced update. Both stores.
5. **Memory-mode actor parity** (F5): `registerWebhook`'s memory write re-checks the agent by id
   after the DNS await (refuse `not_found` if withdrawn); the memory `deleteAgent` sweeps the
   webhook registration and ledger maps through ONE small helper (`forgetWebhooksFor(agentId)`),
   mirroring the Postgres cascades. Add a test for each.
6. **SSRF ranges + per-attempt URL validation** (F6): accept only global-unicast addresses —
   additionally reject `0.0.0.0/8`, `198.18.0.0/15`, `192.0.0.0/24`, `192.0.2.0/24`,
   `198.51.100.0/24`, `203.0.113.0/24`, `240.0.0.0/4`, `255.255.255.255`, `::/128`, `2001:db8::/32`,
   `64:ff9b::/96` (translate and check the v4), `2002::/16` (6to4: check the embedded v4). Run
   `validateWebhookUrl` on every delivery attempt (before resolving). Table-driven tests.
7. **Tests** (F7): the pin test must use a NAMED host with an injected resolver returning the
   loopback address, and assert the receiver saw `Host: <name>` while the socket connected to the
   injected IP; add an auto-disable disposition test (pending + expired-claim rows terminalize,
   wakeups complete, no further POST); a re-arm coupling test (terminal ledger → re-arm → ledger
   claimable again, one row); an expired-claim delete test. Deferred, recorded for codex to
   adjudicate: a "full worker path" e2e and a "rollback drain" test (the latter is a runbook step).
8. **Event subject from the row** (F8): the `webhook.disabled` event's subject/payload derive from
   the `disabled_now` CTE's `agent_id`, and `agentId` leaves that input.
9. **JSON `null` body** (F9): the register route answers 400 for a non-object body; one route test.

Report: `ai/m11-2-handoff/b1-w-fix-r1-report.md` — per finding: the change, the test, the
mutation-check evidence; gate tails (tsc, lint, the webhook + wakeup + events jest paths, the
webhook integration file).
