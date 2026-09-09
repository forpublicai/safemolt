/**
 * M11b Lane W (P5.1) `[integration]` — the webhook registration + delivery ledger against a real
 * Postgres. What only a database can show:
 *  - `claimNextWebhookDelivery`'s `FOR UPDATE SKIP LOCKED` exactly-one-winner shape;
 *  - the token fence on `recordWebhookAttempt` refusing a stale claim after a reclaim;
 *  - the terminal-ledger / webhook-primary-wakeup coupling, decided by real `RETURNING` gates, not
 *    by application code;
 *  - the `ON DELETE CASCADE` FKs on agent withdrawal.
 *
 * `agent_webhooks.agent_id`, `webhook_deliveries.agent_id` and `webhook_deliveries.wakeup_id` all
 * carry `REFERENCES ... ON DELETE CASCADE` (P5.1 Decision 10), so every fixture row hangs off a real
 * seeded agent, exactly as `m11-2-u5-wakeups.test.ts` (this file's template) requires for
 * `agent_wakeups`.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  claimNextWebhookDelivery,
  deleteAgentWebhook,
  getAgentWebhook,
  recordWebhookAttempt,
  upsertAgentWebhook,
} from "@/lib/store/webhooks/db";
import {
  createOrReArmWakeup,
  enqueueWakeup,
  getWakeupByAgentReasonEvent,
  resolveWakeupDelivery,
} from "@/lib/store/wakeups/db";
import { deleteAgent } from "@/lib/store/agents/db";
import { registerWebhook } from "@/lib/actions/webhooks";
import { deliverWakeup } from "@/lib/webhooks/deliver";
import { notificationsConsumer } from "@/lib/events/consumers/notifications";
import { drainEventConsumer } from "@/lib/store/events/drain-db";
import type { StoredAgent } from "@/lib/store-types";
import { activateRealConsumers } from "./helpers/activate-consumers";
import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";
import { pidOf, raceAgainstHeldLock, rejections, runConcurrently, waitersOn, waitForWaiter } from "./helpers/concurrency";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `b1w_${kind}_${RUN}_${(seq += 1)}`;

/**
 * A fresh BIGINT for `agent_wakeups.event_id` / `reason` dedup — never a real `events` row, exactly
 * like `m11-2-u5-wakeups.test.ts`'s `nextEventId`. Each call gets a distinct value so the wakeup
 * dedup indexes (`idx_wakeups_dedup_event`) never collide across this file's own tests.
 */
let syntheticEventId = 950_000_000;
const nextEventId = () => (syntheticEventId += 1);

async function seedAgent(): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `b1w_key_${id}`]
  );
  return id;
}

/** A webhook-primary wakeup, via the real enqueue path — its ledger row rides the same statement. */
async function seedWebhookWakeup(
  agentId: string,
  reason = "b1w_reason",
  eventId: number | null = nextEventId()
): Promise<number> {
  const result = await enqueueWakeup({
    agentId,
    reason,
    eventId,
    payload: { run: RUN },
    delivery: "webhook",
  });
  if (!result.wakeup) throw new Error("expected a fresh wakeup row");
  return result.wakeup.id;
}

/**
 * A REAL `webhook.disabled` event, subject-agent scoped — F5(b) needs a genuine kind a real
 * consumer covers, never a synthetic string, or `drainEventConsumer` skips it unreceipted.
 */
async function insertRealEvent(subjectAgentId: string): Promise<number> {
  const { rows } = await pgPool().query(
    `INSERT INTO events (kind, subject_type, subject_id, payload) VALUES ('webhook.disabled', 'agent', $1, '{}'::jsonb) RETURNING id`,
    [subjectAgentId]
  );
  return Number(rows[0].id);
}

/** An internal-primary wakeup — only gets a ledger row when the agent's registration is `mode='both'`. */
async function seedInternalWakeup(agentId: string): Promise<number> {
  const result = await enqueueWakeup({
    agentId,
    reason: "b1w_internal_reason",
    eventId: nextEventId(),
    payload: { run: RUN },
    delivery: "internal",
  });
  if (!result.wakeup) throw new Error("expected a fresh wakeup row");
  return result.wakeup.id;
}

async function ledgerRowForWakeup(wakeupId: number): Promise<Record<string, unknown>> {
  const { rows } = await pgPool().query(`SELECT * FROM webhook_deliveries WHERE wakeup_id = $1`, [wakeupId]);
  if (rows.length === 0) throw new Error(`expected a ledger row for wakeup ${wakeupId}`);
  return rows[0] as Record<string, unknown>;
}

async function wakeupRow(wakeupId: number): Promise<Record<string, unknown>> {
  const { rows } = await pgPool().query(`SELECT * FROM agent_wakeups WHERE id = $1`, [wakeupId]);
  return rows[0] as Record<string, unknown>;
}

async function backdateLease(deliveryId: number): Promise<void> {
  await pgPool().query(
    `UPDATE webhook_deliveries SET lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
    [deliveryId]
  );
}

/**
 * The coupling gate, reusable across the three terminal paths: a terminal ledger row may never pair
 * with a nonterminal webhook-primary wakeup, and — the opposite direction, exercised by a `mode='both'`
 * ledger — a terminal ledger must never complete a wakeup that is not itself webhook-primary.
 */
async function assertLedgerWakeupCoupling(wakeupId: number): Promise<void> {
  const ledger = await ledgerRowForWakeup(wakeupId);
  const wakeup = await wakeupRow(wakeupId);
  expect(ledger.terminal_reason).not.toBeNull();
  if (wakeup.delivery === "webhook") {
    expect(wakeup.completed_at).not.toBeNull();
  } else {
    expect(wakeup.completed_at).toBeNull();
  }
}

/**
 * F3 (round 5): a real gate `enqueueWakeup` pauses ON, inside its OWN transaction, once it has
 * inserted the interrupted delivery — proving `deleteAgentWebhook` waits on ENQUEUE's own
 * registration lock, never a substitute holder (finding 3). Gated by `reason` so only this file's
 * one designated call pauses; every other insert here passes through untouched.
 */
const PAUSE_TABLE = `b1w_pause_gate_${RUN}`;
const PAUSE_FN = `b1w_pause_fn_${RUN}`;
const PAUSE_REASON = `b1w_f3r5_pause_${RUN}`;

beforeAll(async () => {
  // No neutralization needed here (unlike the wakeup router's "one live session" index): every
  // constraint `webhook_deliveries` carries — `UNIQUE (wakeup_id)`, the two claim-scan indexes — is
  // scoped to a wakeup or keyed off a RUN-suffixed agent, so a prior interrupted run leaves nothing
  // that can block a fresh row here the way a cross-run "one per scope" index can.
  await pgPool().query(`CREATE TABLE ${PAUSE_TABLE} (id int PRIMARY KEY)`);
  await pgPool().query(`INSERT INTO ${PAUSE_TABLE} VALUES (1)`);
  await pgPool().query(`
    CREATE OR REPLACE FUNCTION ${PAUSE_FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF EXISTS (SELECT 1 FROM agent_wakeups w WHERE w.id = NEW.wakeup_id AND w.reason = '${PAUSE_REASON}') THEN
        PERFORM 1 FROM ${PAUSE_TABLE} FOR UPDATE;
      END IF;
      RETURN NEW;
    END;
    $fn$;
  `);
  await pgPool().query(`
    CREATE TRIGGER ${PAUSE_FN} AFTER INSERT ON webhook_deliveries
    FOR EACH ROW EXECUTE FUNCTION ${PAUSE_FN}()
  `);
});

afterAll(async () => {
  await pgPool().query(`DROP TRIGGER IF EXISTS ${PAUSE_FN} ON webhook_deliveries`);
  await pgPool().query(`DROP FUNCTION IF EXISTS ${PAUSE_FN}()`);
  await pgPool().query(`DROP TABLE IF EXISTS ${PAUSE_TABLE}`);
  // Explicit, ordered deletes first (cascades would also get there, but a failed cascade must not
  // strand this run's rows for the next one) — same discipline as m11-2-u5-wakeups.test.ts.
  await pgPool().query(`DELETE FROM webhook_deliveries WHERE agent_id LIKE $1`, [`b1w_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM agent_webhooks WHERE agent_id LIKE $1`, [`b1w_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM agent_wakeups WHERE agent_id LIKE $1`, [`b1w_agent_${RUN}%`]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [`b1w_agent_${RUN}%`]);
  await closeIntegrationConnections();
});

describe("claimNextWebhookDelivery — exactly one claimant per row", () => {
  it("lets exactly one of N concurrent callers claim a reclaimable (expired-lease) row", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const wakeupId = await seedWebhookWakeup(agent);
    const delivery = await ledgerRowForWakeup(wakeupId);

    // Seed a claimed-but-expired row so every caller races the SAME reclaimable row, not an empty
    // queue — a sharper proof of "exactly one winner" than claiming an unclaimed row once.
    await pgPool().query(
      `UPDATE webhook_deliveries SET claimed_at = NOW(), claim_token = $2, lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [delivery.id, "b1w_stale_seed_token"]
    );

    const tokens = Array.from({ length: 5 }, (_, i) => `b1w_claim_${RUN}_${i}`);
    const outcomes = await runConcurrently(
      tokens.map((claimToken) => () => claimNextWebhookDelivery({ claimToken, leaseMs: 30_000 }))
    );

    expect(rejections(outcomes)).toEqual([]);
    const nonNull = outcomes.filter(
      (o): o is { ok: true; value: NonNullable<Awaited<ReturnType<typeof claimNextWebhookDelivery>>> } =>
        o.ok && o.value !== null
    );
    expect(nonNull).toHaveLength(1);
    const winnerToken = nonNull[0].value.claimToken;
    expect(tokens).toContain(winnerToken);

    const finalRow = await ledgerRowForWakeup(wakeupId);
    expect(finalRow.claim_token).toBe(winnerToken);
  });
});

describe("recordWebhookAttempt — the token fence", () => {
  it("reclaims an expired lease and rejects the stale token's update", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const wakeupId = await seedWebhookWakeup(agent);

    const first = await claimNextWebhookDelivery({ claimToken: `b1w_tok1_${RUN}`, leaseMs: 30_000 });
    expect(first).not.toBeNull();
    await backdateLease(first!.id);

    const second = await claimNextWebhookDelivery({ claimToken: `b1w_tok2_${RUN}`, leaseMs: 30_000 });
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first!.id);
    const afterReclaim = await ledgerRowForWakeup(wakeupId);
    expect(afterReclaim.claim_token).toBe(`b1w_tok2_${RUN}`);

    // The stale (first) token no longer fences anything — the row now belongs to the second claim.
    const staleOutcome = await recordWebhookAttempt({
      id: first!.id,
      claimToken: first!.claimToken,
      status: 500,
      ok: false,
    });
    expect(staleOutcome).toBe("not_found");

    // The stale call must not have mutated what the second claim left behind.
    const afterStale = await ledgerRowForWakeup(wakeupId);
    expect(afterStale.attempts).toBe(afterReclaim.attempts);
    expect(afterStale.terminal_reason).toBe(afterReclaim.terminal_reason);
    expect(afterStale.claim_token).toBe(`b1w_tok2_${RUN}`);
  });
});

describe("terminal-ledger / webhook-primary-wakeup coupling", () => {
  it("success completes the webhook-primary wakeup", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const wakeupId = await seedWebhookWakeup(agent);
    const claimed = await claimNextWebhookDelivery({ claimToken: `b1w_ok_${RUN}`, leaseMs: 30_000 });

    const outcome = await recordWebhookAttempt({
      id: claimed!.id,
      claimToken: claimed!.claimToken,
      status: 200,
      ok: true,
    });
    expect(outcome).toBe("success");
    await assertLedgerWakeupCoupling(wakeupId);
    const ledger = await ledgerRowForWakeup(wakeupId);
    expect(ledger.terminal_reason).toBe("delivered");
  });

  it("exhaustion (3 failures) completes the webhook-primary wakeup", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const wakeupId = await seedWebhookWakeup(agent);

    let outcome = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimNextWebhookDelivery({ claimToken: `b1w_ex_${RUN}_${attempt}`, leaseMs: 30_000 });
      expect(claimed).not.toBeNull();
      outcome = await recordWebhookAttempt({
        id: claimed!.id,
        claimToken: claimed!.claimToken,
        status: 500,
        ok: false,
      });
      if (attempt < 3) {
        expect(outcome).toBe("retry");
        // `retry` releases the claim and defers `next_attempt_at` into the future (1m/10m/60m
        // backoff) — reclaim it directly so this test does not need to sleep for the backoff.
        await pgPool().query(`UPDATE webhook_deliveries SET next_attempt_at = NOW() WHERE wakeup_id = $1`, [
          wakeupId,
        ]);
      }
    }
    expect(outcome).toBe("exhausted");
    await assertLedgerWakeupCoupling(wakeupId);
    const ledger = await ledgerRowForWakeup(wakeupId);
    expect(ledger.terminal_reason).toBe("exhausted");
    expect(ledger.attempts).toBe(3);
  });

  it("removal (deleteAgentWebhook) terminalizes the unclaimed ledger row and completes the wakeup", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const wakeupId = await seedWebhookWakeup(agent);

    const result = await deleteAgentWebhook(agent);
    expect(result.deleted).toBe(true);
    await assertLedgerWakeupCoupling(wakeupId);
    const ledger = await ledgerRowForWakeup(wakeupId);
    expect(ledger.terminal_reason).toBe("webhook_removed");
  });

  it("a mode='both' ledger terminalizes WITHOUT completing the internal-primary wakeup it rides beside", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "both" });
    const wakeupId = await seedInternalWakeup(agent);
    const wakeupBefore = await wakeupRow(wakeupId);
    expect(wakeupBefore.delivery).toBe("internal");

    const claimed = await claimNextWebhookDelivery({ claimToken: `b1w_both_${RUN}`, leaseMs: 30_000 });
    expect(claimed).not.toBeNull();
    expect(claimed!.wakeupId).toBe(wakeupId);

    const outcome = await recordWebhookAttempt({
      id: claimed!.id,
      claimToken: claimed!.claimToken,
      status: 200,
      ok: true,
    });
    expect(outcome).toBe("success");

    // Opposite direction of the coupling gate: the ledger is terminal, but its wakeup is
    // internal-primary and must be left for the internal tick to complete, never this statement.
    await assertLedgerWakeupCoupling(wakeupId);
    const ledger = await ledgerRowForWakeup(wakeupId);
    expect(ledger.terminal_reason).toBe("delivered");
  });
});

describe("agent withdrawal cascades", () => {
  it("leaves zero agent_webhooks/webhook_deliveries rows for a deleted agent", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });

    // One pending, one claimed (nonterminal), one terminal ledger row for this agent. Seeded as
    // three separate wakeups so `claimNextWebhookDelivery`'s scan always has an unclaimed candidate
    // left after the first two claims, regardless of which row it picks first.
    await seedWebhookWakeup(agent); // stays pending — never claimed
    const claimedWakeup = await seedWebhookWakeup(agent);
    const terminalWakeup = await seedWebhookWakeup(agent);

    const claimed = await claimNextWebhookDelivery({ claimToken: `b1w_wd_claim_${RUN}`, leaseMs: 30_000 });
    expect(claimed).not.toBeNull();
    if (claimed!.wakeupId !== claimedWakeup) {
      // Claimed the wrong one first (scan order is not id order) — claim the intended terminal
      // wakeup next and finish it, leaving `claimedWakeup`'s row genuinely nonterminal-claimed.
      const second = await claimNextWebhookDelivery({ claimToken: `b1w_wd_term_${RUN}`, leaseMs: 30_000 });
      expect(second).not.toBeNull();
      await recordWebhookAttempt({
        id: second!.id,
        claimToken: second!.claimToken,
        status: 200,
        ok: true,
      });
    } else {
      const term = await claimNextWebhookDelivery({ claimToken: `b1w_wd_term_${RUN}`, leaseMs: 30_000 });
      expect(term).not.toBeNull();
      expect(term!.wakeupId).toBe(terminalWakeup);
      await recordWebhookAttempt({
        id: term!.id,
        claimToken: term!.claimToken,
        status: 200,
        ok: true,
      });
    }

    const before = await pgPool().query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE agent_id = $1`, [
      agent,
    ]);
    expect(before.rows[0].n).toBe(3);

    const deleted = await deleteAgent(agent);
    expect(deleted.ok).toBe(true);

    const webhooks = await pgPool().query(`SELECT count(*)::int AS n FROM agent_webhooks WHERE agent_id = $1`, [
      agent,
    ]);
    expect(webhooks.rows[0].n).toBe(0);
    const deliveries = await pgPool().query(
      `SELECT count(*)::int AS n FROM webhook_deliveries WHERE agent_id = $1`,
      [agent]
    );
    expect(deliveries.rows[0].n).toBe(0);
  });
});

describe("registerWebhook — the two-step rollout gate", () => {
  const ORIGINAL_FLAG = process.env.WEBHOOKS_ENABLED;

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.WEBHOOKS_ENABLED;
    else process.env.WEBHOOKS_ENABLED = ORIGINAL_FLAG;
  });

  it("refuses with 'webhooks_not_enabled' and writes nothing when the flag is unset", async () => {
    delete process.env.WEBHOOKS_ENABLED;
    const agent = await seedAgent();
    const stub = { id: agent, name: agent } as unknown as StoredAgent;

    const result = await registerWebhook(stub, { url: "https://example.com/hook", mode: "primary" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("webhooks_not_enabled");
    expect(await getAgentWebhook(agent)).toBeNull();
  });

  it("F5: refuses 'not_found' (not a raised 23503) when the acting agent was withdrawn before the write", async () => {
    process.env.WEBHOOKS_ENABLED = "true";
    const agent = await seedAgent();
    const stub = { id: agent, name: agent } as unknown as StoredAgent;
    const deleted = await deleteAgent(agent);
    expect(deleted.ok).toBe(true);

    const result = await registerWebhook(stub, { url: "https://example.com/hook", mode: "primary" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
    expect(await getAgentWebhook(agent)).toBeNull();
  });
});

describe("F1: auto-disable disposition sweep", () => {
  it("crossing the threshold terminalizes pending and expired-claim rows, leaves a live claim alone", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    await pgPool().query(`UPDATE agent_webhooks SET failure_count = 9 WHERE agent_id = $1`, [agent]);

    const triggeringWakeup = await seedWebhookWakeup(agent);
    const pendingWakeup = await seedWebhookWakeup(agent);
    const expiredClaimWakeup = await seedWebhookWakeup(agent);
    const liveClaimWakeup = await seedWebhookWakeup(agent);

    const expiredLedger = await ledgerRowForWakeup(expiredClaimWakeup);
    await pgPool().query(
      `UPDATE webhook_deliveries SET claimed_at = NOW(), claim_token = 'stale', lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [expiredLedger.id]
    );
    const liveLedger = await ledgerRowForWakeup(liveClaimWakeup);
    await pgPool().query(
      `UPDATE webhook_deliveries SET claimed_at = NOW(), claim_token = 'live', lease_expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1`,
      [liveLedger.id]
    );

    const claimed = await claimNextWebhookDelivery({ claimToken: `b1w_disp_trig_${RUN}`, leaseMs: 30_000 });
    expect(claimed!.wakeupId).toBe(triggeringWakeup);
    const outcome = await recordWebhookAttempt({
      id: claimed!.id,
      claimToken: claimed!.claimToken,
      status: 500,
      ok: false,
    });
    // F1: crossing the threshold reclassifies THIS attempt's own outcome as `disabled`.
    expect(outcome).toBe("disabled");
    await assertLedgerWakeupCoupling(triggeringWakeup);
    expect((await ledgerRowForWakeup(triggeringWakeup)).terminal_reason).toBe("webhook_disabled");

    for (const wakeupId of [pendingWakeup, expiredClaimWakeup]) {
      const ledger = await ledgerRowForWakeup(wakeupId);
      expect(ledger.terminal_reason).toBe("webhook_disabled");
      const wakeup = await wakeupRow(wakeupId);
      expect(wakeup.completed_at).not.toBeNull();
      expect(wakeup.result).toBe("webhook_disabled");
    }

    const liveAfter = await ledgerRowForWakeup(liveClaimWakeup);
    expect(liveAfter.terminal_reason).toBeNull();
    expect(liveAfter.claim_token).toBe("live");
  });
});

describe("F4: delete terminalizes an expired-lease claim, not just an unclaimed row", () => {
  it("sweeps an expired-claim ledger row exactly like an unclaimed one", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const wakeupId = await seedWebhookWakeup(agent);
    const ledger = await ledgerRowForWakeup(wakeupId);
    await pgPool().query(
      `UPDATE webhook_deliveries SET claimed_at = NOW(), claim_token = 'crashed', lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [ledger.id]
    );

    const result = await deleteAgentWebhook(agent);
    expect(result.deleted).toBe(true);

    await assertLedgerWakeupCoupling(wakeupId);
    expect((await ledgerRowForWakeup(wakeupId)).terminal_reason).toBe("webhook_removed");
  });
});

describe("F2: re-arm resets a stale terminal ledger row", () => {
  it("exhausts, re-arms, and finds ONE ledger row that is claimable again", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const eventId = nextEventId();

    const first = await createOrReArmWakeup({
      agentId: agent,
      reason: "b1w_rearm_reason",
      eventId,
      payload: { run: RUN },
      delivery: "webhook",
    });
    expect(first).toEqual({ created: true, reArmed: false });
    const wakeup = await getWakeupByAgentReasonEvent(agent, "b1w_rearm_reason", eventId);
    expect(wakeup).not.toBeNull();

    await pgPool().query(`UPDATE webhook_deliveries SET attempts = 2 WHERE wakeup_id = $1`, [wakeup!.id]);
    const claimed = await claimNextWebhookDelivery({ claimToken: `b1w_rearm_ex_${RUN}`, leaseMs: 30_000 });
    const outcome = await recordWebhookAttempt({
      id: claimed!.id,
      claimToken: claimed!.claimToken,
      status: 500,
      ok: false,
    });
    expect(outcome).toBe("exhausted");
    expect((await wakeupRow(wakeup!.id)).completed_at).not.toBeNull();

    const rearmed = await createOrReArmWakeup({
      agentId: agent,
      reason: "b1w_rearm_reason",
      eventId,
      payload: { run: RUN },
      delivery: "webhook",
    });
    expect(rearmed).toEqual({ created: false, reArmed: true });

    const { rows } = await pgPool().query(`SELECT * FROM webhook_deliveries WHERE wakeup_id = $1`, [wakeup!.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].terminal_reason).toBeNull();
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].claimed_at).toBeNull();

    const reclaim = await claimNextWebhookDelivery({ claimToken: `b1w_rearm_re_${RUN}`, leaseMs: 30_000 });
    expect(reclaim?.wakeupId).toBe(wakeup!.id);
  });
});

describe("F1: no ledger-less webhook-primary wakeup", () => {
  it("refuses the enqueue when the registration vanishes between resolveWakeupDelivery and enqueueWakeup", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });

    const delivery = await resolveWakeupDelivery(agent);
    expect(delivery).toBe("webhook");
    await deleteAgentWebhook(agent); // the race window: gone before the enqueue below runs

    const result = await enqueueWakeup({
      agentId: agent,
      reason: "b1w_f1_gone",
      eventId: nextEventId(),
      payload: { run: RUN },
      delivery: delivery!,
    });

    expect(result).toEqual({ created: false, wakeup: null });
    const { rows } = await pgPool().query(`SELECT id FROM agent_wakeups WHERE agent_id = $1 AND reason = $2`, [
      agent,
      "b1w_f1_gone",
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("F1 (round 4): an enqueue racing a real agent withdrawal never deadlocks", () => {
  it("blocks on the withdrawal's own agent lock, then refuses cleanly once the agent is gone", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });

    const observation = await raceAgainstHeldLock({
      // Verbatim from `deleteAgent`'s own final statement (`agents/db.ts`) -- this agent has no
      // posts/comments, so this IS the whole withdrawal shape that matters to this race.
      hold: async (holder) => {
        await holder.query(`DELETE FROM agents WHERE id = $1`, [agent]);
      },
      contend: () =>
        enqueueWakeup({
          agentId: agent,
          reason: "b1w_f1_withdrawal_race",
          eventId: nextEventId(),
          payload: { run: RUN },
          delivery: "webhook",
        }),
      contenderMarker: "p5.1:agent-lock",
    });

    // The REAL enqueueWakeup queued behind the REAL withdrawal's own agent lock -- no substitute
    // holder standing in for either side (finding 2's complaint about the disposition-sweep test).
    expect(observation.observedBlocked).toBe(true);
    // The withdrawal held the lock we raced against, so it committed first: the agent is gone and
    // the enqueue refuses cleanly -- never a 23503, never a 40P01.
    expect(observation.result).toEqual({ created: false, wakeup: null });
    const { rows } = await pgPool().query(`SELECT 1 FROM agents WHERE id = $1`, [agent]);
    expect(rows).toHaveLength(0);
  });
});

describe("F1 (round 5): recordWebhookAttempt and deleteAgentWebhook both start with the agent row", () => {
  it("both queue behind a real withdrawal's own agent lock, then resolve cleanly, never a 40P01", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const wakeupId = await seedWebhookWakeup(agent);
    const claimed = await claimNextWebhookDelivery({ claimToken: `b1w_f1r5_${RUN}`, leaseMs: 30_000 });
    expect(claimed?.wakeupId).toBe(wakeupId);

    const observation = await raceAgainstHeldLock({
      // Same withdrawal shape as F1 (round 4): this agent's cascade holds the agent row and every
      // row it owns — `agent_webhooks`, this ledger row, this wakeup.
      hold: async (holder) => {
        await holder.query(`DELETE FROM agents WHERE id = $1`, [agent]);
      },
      contend: () =>
        Promise.allSettled([
          recordWebhookAttempt({ id: claimed!.id, claimToken: claimed!.claimToken, status: 200, ok: true }),
          deleteAgentWebhook(agent),
        ]),
      contenderMarker: "p5.1:agent-lock",
    });

    // Mutation target: without statement 1's `agents ... FOR KEY SHARE` in both functions, neither
    // query carries this marker and this assertion goes false (see the r5 report for the failing run).
    expect(observation.observedBlocked).toBe(true);
    const [attemptOutcome, deleteOutcome] = observation.result;
    expect(attemptOutcome.status).toBe("fulfilled"); // never a 40P01
    expect(deleteOutcome.status).toBe("fulfilled");
    if (attemptOutcome.status === "fulfilled") expect(attemptOutcome.value).toBe("not_found");
    if (deleteOutcome.status === "fulfilled") expect(deleteOutcome.value).toEqual({ deleted: false });
    const { rows } = await pgPool().query(`SELECT 1 FROM agents WHERE id = $1`, [agent]);
    expect(rows).toHaveLength(0);
  });
});

describe("F3: an internal re-arm never resets an active mode='both' ledger", () => {
  it("leaves a live-claimed both ledger untouched across an internal re-arm", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "both" });
    const eventId = nextEventId();

    const first = await createOrReArmWakeup({
      agentId: agent,
      reason: "b1w_f3_both",
      eventId,
      payload: { run: RUN },
      delivery: "internal",
    });
    expect(first).toEqual({ created: true, reArmed: false });
    const wakeup = await getWakeupByAgentReasonEvent(agent, "b1w_f3_both", eventId);
    const ledger = await ledgerRowForWakeup(wakeup!.id);
    await pgPool().query(
      `UPDATE webhook_deliveries SET claimed_at = NOW(), claim_token = 'b1w_f3_live', lease_expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1`,
      [ledger.id]
    );

    // The internal tick completes and re-arms while the webhook side is still live-claimed.
    await pgPool().query(`UPDATE agent_wakeups SET completed_at = NOW(), result = NULL WHERE id = $1`, [wakeup!.id]);

    const rearmed = await createOrReArmWakeup({
      agentId: agent,
      reason: "b1w_f3_both",
      eventId,
      payload: { run: RUN },
      delivery: "internal",
    });
    expect(rearmed).toEqual({ created: false, reArmed: true });

    const ledgerAfter = await ledgerRowForWakeup(wakeup!.id);
    expect(ledgerAfter.claim_token).toBe("b1w_f3_live");
    expect(ledgerAfter.claimed_at).not.toBeNull();
  });
});

describe("F3 (round 5): deleteAgentWebhook genuinely waits on enqueueWakeup's OWN registration lock", () => {
  it("delete blocks on enqueue's own held lock (proven by backend pid), then sweeps what enqueue committed", async () => {
    await activateRealConsumers();
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });

    // A REAL receipted event — drained through the real notifications consumer BEFORE the enqueue
    // below — so the disposition sweep's completion of this wakeup is proven independent of the
    // event's own (already-finished) consumer processing, never a synthetic bigint no consumer sees.
    const realEventId = await insertRealEvent(agent);
    await drainEventConsumer(notificationsConsumer, { batchSize: 200 });
    const { rows: receiptRows } = await pgPool().query(
      `SELECT 1 FROM event_receipts WHERE consumer = $1 AND event_id = $2`,
      [notificationsConsumer.name, realEventId]
    );
    expect(receiptRows).toHaveLength(1);

    // The controller holds the pause-gate row FIRST, so the `AFTER INSERT` trigger — firing inside
    // enqueue's OWN transaction right after it inserts this delivery — blocks enqueue mid-flight,
    // AFTER its own registration `FOR SHARE` lock is already taken and still held (finding 3: a
    // stand-in holder never proves this; only enqueue's own statement, paused mid-flight, does).
    const controller = await pgClient();
    let enqueuePromise: ReturnType<typeof enqueueWakeup> | null = null;
    let deletePromise: ReturnType<typeof deleteAgentWebhook> | null = null;
    try {
      await controller.query("BEGIN");
      await controller.query(`SELECT 1 FROM ${PAUSE_TABLE} FOR UPDATE`);
      const controllerPid = await pidOf(controller);

      enqueuePromise = enqueueWakeup({
        agentId: agent,
        reason: PAUSE_REASON,
        eventId: realEventId,
        payload: { run: RUN },
        delivery: "webhook",
      });

      const enqueuePaused = await waitForWaiter(controllerPid, "p5.1:agent-lock", 5000);
      expect(enqueuePaused).toBe(true); // enqueue is genuinely mid-statement, past its own registration lock
      const [enqueueWaiter] = await waitersOn(controllerPid, "p5.1:agent-lock");
      const enqueuePid = enqueueWaiter.pid;

      deletePromise = deleteAgentWebhook(agent);
      // Mutation target: remove `reg`'s `FOR SHARE` in `registrationCte` and this goes false — delete
      // then has nothing of ENQUEUE's left to wait on (see the r5 report for the failing run).
      const deleteWaitedOnEnqueue = await waitForWaiter(enqueuePid, "p5.1:delete-registration", 5000);
      expect(deleteWaitedOnEnqueue).toBe(true);
    } finally {
      // Release the pause gate and drain both calls here too: a failed assertion above must not
      // leave either one still running into the next test (round 4's own "Bug A" leak).
      await controller.query("COMMIT").catch(() => {});
      await controller.end().catch(() => {});
      await Promise.allSettled([enqueuePromise, deletePromise]);
    }

    // The REAL enqueueWakeup — not a hand-rolled INSERT — commits its wakeup+ledger only once
    // released, the exact window finding 3 names.
    const enqueueResult = await enqueuePromise!;
    expect(enqueueResult.wakeup).not.toBeNull();
    const interruptedWakeupId = enqueueResult.wakeup!.id;

    const result = await deletePromise!;
    expect(result.deleted).toBe(true);

    const { rows: nonterminal } = await pgPool().query(
      `SELECT count(*)::int AS n FROM webhook_deliveries WHERE agent_id = $1 AND terminal_reason IS NULL`,
      [agent]
    );
    expect(nonterminal[0].n).toBe(0);
    const { rows: incomplete } = await pgPool().query(
      `SELECT count(*)::int AS n FROM agent_wakeups WHERE agent_id = $1 AND delivery = 'webhook' AND completed_at IS NULL`,
      [agent]
    );
    expect(incomplete[0].n).toBe(0);
    expect((await ledgerRowForWakeup(interruptedWakeupId)).terminal_reason).toBe("webhook_removed");
  });
});

describe("F1: two concurrent successful attempts for one agent never deadlock", () => {
  it("both genuinely queue behind a held registration lock, then both complete without a 40P01", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const wakeupA = await seedWebhookWakeup(agent);
    const wakeupB = await seedWebhookWakeup(agent);
    const claimedA = await claimNextWebhookDelivery({ claimToken: `b1w_f1race_a_${RUN}`, leaseMs: 30_000 });
    const claimedB = await claimNextWebhookDelivery({ claimToken: `b1w_f1race_b_${RUN}`, leaseMs: 30_000 });
    expect(new Set([claimedA?.wakeupId, claimedB?.wakeupId])).toEqual(new Set([wakeupA, wakeupB]));

    // Force the overlap: a THIRD connection holds the same registration row FOR SHARE, which
    // conflicts with `recordWebhookAttempt`'s own statement-1 `FOR NO KEY UPDATE` -- so BOTH attempts
    // must genuinely queue before either can proceed. A regression back to `FOR SHARE` (finding 1's
    // original bug) is compatible with this holder and leaves both attempts unblocked, failing the
    // assertion below instead of silently passing (round 3's "passed three times" gap).
    //
    // Counted by the MARKER, never by `pg_blocking_pids(pid).includes(holderPid)`: once the first
    // attempt is itself queued on the holder, Postgres serializes the SECOND attempt behind that
    // first attempt's own transient per-tuple lock (`wait_event = tuple`) rather than behind the
    // holder directly (`wait_event = transactionid`) -- so the second waiter's blocker is the first
    // waiter's pid, not the holder's, and a holder-scoped check can never see both at once, on any
    // fix or any regression. Marker-scoped "is this OUR statement, and is it queued on some lock" is
    // the query-shape-agnostic property this test actually needs. Holder release and both attempts
    // are always awaited, in `finally`: an assertion failure here must not leave an open transaction
    // blocking every later test forever.
    const holder = await pgClient();
    let attemptA: ReturnType<typeof recordWebhookAttempt> | undefined;
    let attemptB: ReturnType<typeof recordWebhookAttempt> | undefined;
    let waiterCount = 0;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT mode FROM agent_webhooks WHERE agent_id = $1 AND disabled_at IS NULL FOR SHARE`, [
        agent,
      ]);

      attemptA = recordWebhookAttempt({ id: claimedA!.id, claimToken: claimedA!.claimToken, status: 200, ok: true });
      attemptB = recordWebhookAttempt({ id: claimedB!.id, claimToken: claimedB!.claimToken, status: 200, ok: true });

      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const { rows } = await pgPool().query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND cardinality(pg_blocking_pids(pid)) > 0
             AND query LIKE '%p5.1:webhook-attempt-lock%'`
        );
        waiterCount = new Set(rows.map((r) => r.pid)).size;
        if (waiterCount >= 2) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      await holder.query("COMMIT").catch(() => {});
      await holder.end().catch(() => {});
    }
    expect(waiterCount).toBe(2); // both attempts genuinely overlapped, queued on the SAME lock

    const [resultA, resultB] = await Promise.allSettled([attemptA!, attemptB!]);

    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");
    if (resultA.status === "fulfilled") expect(resultA.value).toBe("success");
    if (resultB.status === "fulfilled") expect(resultB.value).toBe("success");
    expect((await ledgerRowForWakeup(wakeupA)).terminal_reason).toBe("delivered");
    expect((await ledgerRowForWakeup(wakeupB)).terminal_reason).toBe("delivered");
  }, 30_000);
});

describe("F1: a late attempt on an expired ledger never deadlocks with a concurrent delete", () => {
  it("resolves both sides cleanly, leaving a single consistent terminal state", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const wakeupId = await seedWebhookWakeup(agent);
    const claimed = await claimNextWebhookDelivery({ claimToken: `b1w_f1late_${RUN}`, leaseMs: 30_000 });
    expect(claimed).not.toBeNull();
    // "Late": the lease has expired, but nobody has reclaimed it yet — the token is still current.
    await pgPool().query(`UPDATE webhook_deliveries SET lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [
      claimed!.id,
    ]);

    const [attemptResult, deleteResult] = await Promise.allSettled([
      recordWebhookAttempt({ id: claimed!.id, claimToken: claimed!.claimToken, status: 200, ok: true }),
      deleteAgentWebhook(agent),
    ]);

    expect(attemptResult.status).toBe("fulfilled"); // no 40P01, whichever side wins
    expect(deleteResult.status).toBe("fulfilled");

    const ledger = await ledgerRowForWakeup(wakeupId);
    expect(["delivered", "webhook_removed"]).toContain(ledger.terminal_reason);
    const wakeup = await wakeupRow(wakeupId);
    expect(wakeup.completed_at).not.toBeNull();
    expect(wakeup.result).toBe(ledger.terminal_reason); // one consistent outcome, never torn between the two
  });
});

describe("F6: the disposition sweep runs only when this call's own attempt was accepted", () => {
  it("a rejected (wrong-token) call does not sweep this agent's other pending deliveries", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const rejectedWakeup = await seedWebhookWakeup(agent);
    const pendingWakeup = await seedWebhookWakeup(agent);
    const rejectedLedger = await ledgerRowForWakeup(rejectedWakeup);
    await pgPool().query(`UPDATE agent_webhooks SET failure_count = 10, disabled_at = NOW() WHERE agent_id = $1`, [
      agent,
    ]);

    const outcome = await recordWebhookAttempt({
      id: rejectedLedger.id as number,
      claimToken: "b1w_f6_wrong_token_never_issued",
      status: 500,
      ok: false,
    });
    expect(outcome).toBe("not_found");

    expect((await ledgerRowForWakeup(pendingWakeup)).terminal_reason).toBeNull();
    expect((await ledgerRowForWakeup(rejectedWakeup)).terminal_reason).toBeNull();

    // Cleanup, not assertion: both rows are deliberately left non-terminal and UNCLAIMED above, which
    // makes them the oldest due rows in the whole table — `claimNextWebhookDelivery` scans globally,
    // so a later test's plain claim call would win one of THESE instead of its own. A fake live claim
    // (never used elsewhere) takes them out of the due scan without touching what was just asserted.
    await pgPool().query(
      `UPDATE webhook_deliveries SET claimed_at = NOW(), claim_token = 'b1w_f6_cleanup', lease_expires_at = NOW() + INTERVAL '1 hour' WHERE wakeup_id = ANY($1::bigint[])`,
      [[rejectedWakeup, pendingWakeup]]
    );
  });
});

describe("F3 (round 4): a terminal delivery's replayed token sweeps nothing", () => {
  it("a repeat call with the auto-disabling delivery's own (now terminal) token leaves a sibling's expired lease untouched", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    await pgPool().query(`UPDATE agent_webhooks SET failure_count = 9 WHERE agent_id = $1`, [agent]);

    const triggeringWakeup = await seedWebhookWakeup(agent);
    const siblingWakeup = await seedWebhookWakeup(agent);
    const triggeringClaimed = await claimNextWebhookDelivery({ claimToken: `b1w_f3r4_trig_${RUN}`, leaseMs: 30_000 });
    const siblingClaimed = await claimNextWebhookDelivery({ claimToken: `b1w_f3r4_sib_${RUN}`, leaseMs: 30_000 });
    expect(triggeringClaimed!.wakeupId).toBe(triggeringWakeup);
    expect(siblingClaimed!.wakeupId).toBe(siblingWakeup);

    // Crosses the threshold: terminalizes, but KEEPS its claim_token (only a `retry` outcome clears
    // it) — the replay below reuses this same real token, never a wrong/never-issued one (that is F6).
    const firstOutcome = await recordWebhookAttempt({
      id: triggeringClaimed!.id,
      claimToken: triggeringClaimed!.claimToken,
      status: 500,
      ok: false,
    });
    expect(firstOutcome).toBe("disabled");
    // The sibling was still LIVE-claimed at that moment, so the first call's sweep left it alone.
    expect((await ledgerRowForWakeup(siblingWakeup)).terminal_reason).toBeNull();

    // Now the sibling's lease expires — the exact window finding 3 names.
    await pgPool().query(`UPDATE webhook_deliveries SET lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [
      siblingClaimed!.id,
    ]);

    const replayOutcome = await recordWebhookAttempt({
      id: triggeringClaimed!.id,
      claimToken: triggeringClaimed!.claimToken,
      status: 500,
      ok: false,
    });
    expect(replayOutcome).toBe("not_found");

    // Mutation check target: the OLD statement re-derived the sweep's agent scope from the (id,
    // token) pair alone, which still matched (terminal deliveries keep their token) and swept this
    // now-expired sibling despite the replay itself being refused.
    expect((await ledgerRowForWakeup(siblingWakeup)).terminal_reason).toBeNull();
    const siblingWakeupRow = await wakeupRow(siblingWakeup);
    expect(siblingWakeupRow.completed_at).toBeNull();

    // Left LIVE (claim_token intact) with an expired lease on purpose, the assertions above are
    // exactly what that state proves — but `claimNextWebhookDelivery` scans globally, so an
    // untouched reclaimable row here silently becomes the NEXT test's claim. Resolve it for real
    // through the same statement under test, rather than leaking it into F5(a)/F5(d).
    await recordWebhookAttempt({ id: siblingClaimed!.id, claimToken: siblingClaimed!.claimToken, status: 200, ok: true });
  });
});

describe("F5(a): a forced failure between the ledger write and the wakeup completion rolls both back", () => {
  const TRIGGER_FN = `b1w_fail_wakeup_${RUN}`;
  const FAIL_REASON = `b1w_f5a_fail_${RUN}`;

  /** A trigger on `agent_wakeups`, not `webhook_deliveries`: it fires strictly AFTER the ledger's own
   * UPDATE has run inside the same statement, proving the two are one atomic unit, not two writes. */
  async function withRefusedWakeupCompletion<T>(run: () => Promise<T>): Promise<T> {
    await pgPool().query(`
      CREATE OR REPLACE FUNCTION ${TRIGGER_FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.reason = '${FAIL_REASON}' THEN
          RAISE EXCEPTION 'b1w injected wakeup-completion failure';
        END IF;
        RETURN NEW;
      END;
      $fn$;
    `);
    await pgPool().query(`
      CREATE TRIGGER ${TRIGGER_FN} BEFORE UPDATE ON agent_wakeups
      FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}()
    `);
    try {
      return await run();
    } finally {
      await pgPool().query(`DROP TRIGGER IF EXISTS ${TRIGGER_FN} ON agent_wakeups`);
      await pgPool().query(`DROP FUNCTION IF EXISTS ${TRIGGER_FN}()`);
    }
  }

  it("neither the ledger row nor the wakeup change when the wakeup completion is refused", async () => {
    const agent = await seedAgent();
    await upsertAgentWebhook({ agentId: agent, url: "https://example.com/hook", secret: "s", mode: "primary" });
    const wakeupId = await seedWebhookWakeup(agent, FAIL_REASON);
    const claimed = await claimNextWebhookDelivery({ claimToken: `b1w_f5a_${RUN}`, leaseMs: 30_000 });
    expect(claimed?.wakeupId).toBe(wakeupId); // the claim scans globally — pin it to THIS test's row

    await withRefusedWakeupCompletion(async () => {
      await expect(
        recordWebhookAttempt({ id: claimed!.id, claimToken: claimed!.claimToken, status: 200, ok: true })
      ).rejects.toThrow(/b1w injected wakeup-completion failure/);
    });

    const ledger = await ledgerRowForWakeup(wakeupId);
    expect(ledger.attempts).toBe(0);
    expect(ledger.terminal_reason).toBeNull();
    expect(ledger.claim_token).toBe(claimed!.claimToken); // the claim itself also rolled back with it
    const wakeup = await wakeupRow(wakeupId);
    expect(wakeup.completed_at).toBeNull();
  });
});

describe("F5(d): a failing local receiver retries then disables at the threshold, with a stable wakeup id", () => {
  it("retries once, then crosses the failure threshold — both real HTTP attempts carry the same X-SafeMolt-Wakeup-Id", async () => {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      received.push(String(req.headers["x-safemolt-wakeup-id"]));
      req.resume();
      req.on("end", () => {
        res.writeHead(500);
        res.end();
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });

    const ORIGINAL_SEAM = process.env.WEBHOOK_ALLOW_INSECURE_LOCAL;
    process.env.WEBHOOK_ALLOW_INSECURE_LOCAL = "true";

    try {
      const agent = await seedAgent();
      await upsertAgentWebhook({
        agentId: agent,
        url: `http://127.0.0.1:${port}/hook`,
        secret: "s",
        mode: "both",
      });
      // One failure short of the auto-disable threshold, so this SAME delivery's 2nd attempt is the
      // one that crosses it (2 attempts is well under this delivery's own 3-attempt exhaustion cap).
      await pgPool().query(`UPDATE agent_webhooks SET failure_count = 8 WHERE agent_id = $1`, [agent]);
      const wakeupId = await seedWebhookWakeup(agent, "b1w_f5d_reason", null);

      const first = await claimNextWebhookDelivery({ claimToken: `b1w_f5d_1_${RUN}`, leaseMs: 30_000 });
      expect(first?.wakeupId).toBe(wakeupId); // the claim scans globally — pin it to THIS test's row
      const firstDelivery = await deliverWakeup({
        url: first!.url!,
        secret: first!.secret!,
        wakeupId: first!.wakeupId,
        eventId: first!.eventId,
        payload: { reason: first!.reason, wakeup_id: first!.wakeupId, subject: {}, context_href: "/" },
      });
      expect(firstDelivery.status).toBe(500);
      const firstOutcome = await recordWebhookAttempt({
        id: first!.id,
        claimToken: first!.claimToken,
        status: firstDelivery.status,
        ok: false,
      });
      expect(firstOutcome).toBe("retry");

      await pgPool().query(`UPDATE webhook_deliveries SET next_attempt_at = NOW() WHERE wakeup_id = $1`, [wakeupId]);

      const second = await claimNextWebhookDelivery({ claimToken: `b1w_f5d_2_${RUN}`, leaseMs: 30_000 });
      expect(second).not.toBeNull();
      expect(second!.wakeupId).toBe(wakeupId);
      const secondDelivery = await deliverWakeup({
        url: second!.url!,
        secret: second!.secret!,
        wakeupId: second!.wakeupId,
        eventId: second!.eventId,
        payload: { reason: second!.reason, wakeup_id: second!.wakeupId, subject: {}, context_href: "/" },
      });
      expect(secondDelivery.status).toBe(500);
      const secondOutcome = await recordWebhookAttempt({
        id: second!.id,
        claimToken: second!.claimToken,
        status: secondDelivery.status,
        ok: false,
      });
      expect(secondOutcome).toBe("disabled");

      expect(received).toHaveLength(2);
      expect(received[0]).toBe(String(wakeupId));
      expect(received[1]).toBe(String(wakeupId));

      const ledger = await ledgerRowForWakeup(wakeupId);
      expect(ledger.terminal_reason).toBe("webhook_disabled");
      const registration = await getAgentWebhook(agent);
      expect(registration!.disabledAt).not.toBeNull();
    } finally {
      if (ORIGINAL_SEAM === undefined) delete process.env.WEBHOOK_ALLOW_INSECURE_LOCAL;
      else process.env.WEBHOOK_ALLOW_INSECURE_LOCAL = ORIGINAL_SEAM;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
