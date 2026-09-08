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
import {
  claimNextWebhookDelivery,
  deleteAgentWebhook,
  getAgentWebhook,
  recordWebhookAttempt,
  upsertAgentWebhook,
} from "@/lib/store/webhooks/db";
import { enqueueWakeup } from "@/lib/store/wakeups/db";
import { deleteAgent } from "@/lib/store/agents/db";
import { registerWebhook } from "@/lib/actions/webhooks";
import type { StoredAgent } from "@/lib/store-types";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { rejections, runConcurrently } from "./helpers/concurrency";

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
async function seedWebhookWakeup(agentId: string): Promise<number> {
  const result = await enqueueWakeup({
    agentId,
    reason: "b1w_reason",
    eventId: nextEventId(),
    payload: { run: RUN },
    delivery: "webhook",
  });
  if (!result.wakeup) throw new Error("expected a fresh wakeup row");
  return result.wakeup.id;
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

beforeAll(async () => {
  // No neutralization needed here (unlike the wakeup router's "one live session" index): every
  // constraint `webhook_deliveries` carries — `UNIQUE (wakeup_id)`, the two claim-scan indexes — is
  // scoped to a wakeup or keyed off a RUN-suffixed agent, so a prior interrupted run leaves nothing
  // that can block a fresh row here the way a cross-run "one per scope" index can.
});

afterAll(async () => {
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
      agentId: agent,
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
      agentId: agent,
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
        agentId: agent,
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
      agentId: agent,
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
        agentId: agent,
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
        agentId: agent,
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
});
