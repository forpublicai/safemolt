/**
 * M11-2 u2 `[integration]` — the ingest fan-out lease FAILS CLOSED.
 *
 * Ownership of an event's fan-out is a database fact with an expiry, and everything this file
 * asserts is about not believing a stale answer to it:
 *
 *  - a renewal may only ever extend a lease that is STILL LIVE, so a matching token cannot resurrect
 *    a claim whose window already lapsed and which another drainer may be about to take;
 *  - a renewal that ERRORS is treated as lost ownership, not as "try again next tick" — an
 *    unreachable database is exactly the condition under which the lease is quietly expiring.
 *
 * The renewal error is injected by wrapping the real store module, because the failure being tested
 * is a transport failure and there is no honest way to provoke one from SQL.
 */
jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async () => {}),
  pruneIngestedVectorsForAgent: jest.fn(async () => {}),
  listVectorIdsForAgentByMetadata: jest.fn(async () => [] as string[]),
  deleteVectorsForAgent: jest.fn(async () => {}),
}));

/**
 * Injected transport failure, plus a way to make a pass take measurable time.
 *
 * `listDelayMs` slows one of the store reads a ZERO-WORK pass makes. Without it such a pass finishes
 * in a few round trips, no renewal tick ever fires, and the gate below would pass for the wrong
 * reason — an uncontended pass legitimately succeeding.
 */
const renewalControl = { throws: false, listDelayMs: 0 };

jest.mock("@/lib/store/events/consumer-state", () => {
  const actual = jest.requireActual("@/lib/store/events/consumer-state");
  return {
    ...actual,
    renewIngestEventLease: (...args: unknown[]) =>
      renewalControl.throws
        ? Promise.reject(new Error("renewal transport failure"))
        : (actual.renewIngestEventLease as (...a: unknown[]) => Promise<boolean>)(...args),
    listIncompleteIngestRecipients: async (...args: unknown[]) => {
      if (renewalControl.listDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, renewalControl.listDelayMs));
      }
      return (actual.listIncompleteIngestRecipients as (...a: unknown[]) => Promise<string[]>)(...args);
    },
  };
});

import { memoryIngestEffects } from "@/lib/events/consumers/memory-ingest";
import type { PreparedEvent } from "@/lib/events/kinds";
import * as memoryService from "@/lib/memory/memory-service";
import {
  claimIngestEvent,
  renewIngestEventLease,
} from "@/lib/store/events/consumer-state";
import type { StoredEvent } from "@/lib/store-types";

import { closeIntegrationConnections, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u2l_${kind}_${RUN}_${(seq += 1)}`;
let baselineEventId = 0;

const vectorUpsert = memoryService.upsertVectorChunkBatchForAgent as jest.Mock;
const vectorPrune = memoryService.pruneIngestedVectorsForAgent as jest.Mock;
const vectorList = memoryService.listVectorIdsForAgentByMetadata as jest.Mock;
const vectorDelete = memoryService.deleteVectorsForAgent as jest.Mock;

const LONG_BODY =
  "A body long enough to survive the memory chunker's minimum chunk length, which is fifty characters.";

function syntheticEvent(id: number, prepared: PreparedEvent): StoredEvent {
  return {
    id,
    kind: prepared.kind,
    actorAgentId: prepared.actorAgentId ?? null,
    subjectType: prepared.subjectType ?? null,
    subjectId: prepared.subjectId ?? null,
    secondarySubjectId: null,
    schoolId: null,
    idemKey: null,
    payload: prepared.payload as Record<string, unknown>,
    createdAt: new Date().toISOString(),
  };
}

async function seedAgent(): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `u2l_key_${id}`]
  );
  return id;
}

async function seedGroup(ownerId: string, memberIds: string[]): Promise<string> {
  const id = nextId("group");
  await pgPool().query(
    `INSERT INTO groups (id, name, display_name, description, owner_id, member_ids)
     VALUES ($1, $1, $1, '', $2, $3::jsonb)`,
    [id, ownerId, JSON.stringify(memberIds)]
  );
  return id;
}

async function seedPost(authorId: string, groupId: string): Promise<string> {
  const id = nextId("post");
  await pgPool().query(
    `INSERT INTO posts (id, title, content, author_id, group_id, created_at)
     VALUES ($1, 'Lease', $4, $2, $3, NOW())`,
    [id, authorId, groupId, LONG_BODY]
  );
  return id;
}

beforeAll(async () => {
  const { rows } = await pgPool().query(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

beforeEach(() => {
  renewalControl.throws = false;
  renewalControl.listDelayMs = 0;
  vectorUpsert.mockReset().mockResolvedValue(undefined);
  vectorPrune.mockReset().mockResolvedValue(undefined);
  vectorList.mockReset().mockResolvedValue([]);
  vectorDelete.mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  const like = `u2l_%_${RUN}%`;
  await pgPool().query(`DELETE FROM ingest_event_claims WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM ingest_progress WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM posts WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("ingest fan-out lease", () => {
  /**
   * A matching token is not ownership. Once the window lapses the event is reclaimable, and a
   * renewal that ignored the expiry would resurrect a claim its holder had already lost — racing a
   * drainer about to take it, or extending a hold over one that just did.
   */
  it("refuses to renew a lease that has already expired, even for the right token", async () => {
    const eventId = baselineEventId + 9001;
    expect(await claimIngestEvent(eventId, "mine", "memory-ingest")).toBe(true);
    // Still live: renewal succeeds.
    expect(await renewIngestEventLease(eventId, "mine")).toBe(true);

    await pgPool().query(
      `UPDATE ingest_event_claims SET lease_expires_at = now() - interval '1 second' WHERE event_id = $1`,
      [eventId]
    );
    // Same token, lapsed window: refused.
    expect(await renewIngestEventLease(eventId, "mine")).toBe(false);
    // And the row was not silently extended on the way to that answer.
    const { rows } = await pgPool().query(
      `SELECT lease_expires_at < now() AS expired FROM ingest_event_claims WHERE event_id = $1`,
      [eventId]
    );
    expect(rows[0].expired).toBe(true);

    // A fresh claimant takes it, precisely because it lapsed.
    expect(await claimIngestEvent(eventId, "theirs", "memory-ingest")).toBe(true);
    expect(await renewIngestEventLease(eventId, "mine")).toBe(false);
  });

  /**
   * **The ZERO-WORK path must fail too.**
   *
   * A tombstoned subject plans nothing and, with no outstanding recipients, performs no external
   * call at all — so it passes no ownership assertion on its way to returning. A renewal that failed
   * during its handful of reads would otherwise let the pass report success, and the drain would
   * receipt an event whose new owner is still working. The final assertion before success is what
   * closes that, and this is the only shape that exercises it.
   */
  it("fails a zero-work pass whose renewal errored, rather than reporting success", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    // A tombstone: `planIngest` returns null and there is nothing registered to resolve.
    await pgPool().query(
      `UPDATE posts SET deleted_at = NOW(), deleted_by_agent_id = $2, deleted_karma_reversed_at = NOW()
       WHERE id = $1`,
      [post, author]
    );

    const eventId = baselineEventId + 9201;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    const savedLease = process.env.INGEST_EVENT_LEASE_MS;
    // Renewals tick at a third of the lease (2 s) and the deadline at 80% (4.8 s); the delayed read
    // holds the pass open for 2.5 s, so the renewal error — not the deadline — is what marks it.
    process.env.INGEST_EVENT_LEASE_MS = "6000";
    try {
      renewalControl.throws = true;
      renewalControl.listDelayMs = 2500;
      await expect(memoryIngestEffects.apply(event)).rejects.toThrow("renewal failed");

      // It really was the zero-work path: nothing external was attempted.
      expect(vectorUpsert).not.toHaveBeenCalled();
      expect(vectorPrune).not.toHaveBeenCalled();
      expect(vectorDelete).not.toHaveBeenCalled();

      // And it took the FAILURE exit, so the claim was handed back rather than kept as a
      // "finished" marker — which is what a success would have left behind.
      const { rows } = await pgPool().query(
        `SELECT event_id FROM ingest_event_claims WHERE event_id = $1`,
        [eventId]
      );
      expect(rows).toEqual([]);
    } finally {
      renewalControl.throws = false;
      renewalControl.listDelayMs = 0;
      if (savedLease === undefined) delete process.env.INGEST_EVENT_LEASE_MS;
      else process.env.INGEST_EVENT_LEASE_MS = savedLease;
    }
  });

  /**
   * A renewal that ERRORS marks ownership lost, and the pass then performs no further external
   * operation — the fail-closed half. "The next tick will retry" is a bet that costs a duplicate
   * owner when it loses; aborting costs one retry of a pass that was going to be retried anyway.
   */
  it("aborts before the next external write when a renewal errors", async () => {
    const author = await seedAgent();
    const group = await seedGroup(author, [author]);
    const post = await seedPost(author, group);
    const eventId = baselineEventId + 9101;
    const event = syntheticEvent(eventId, {
      kind: "post.created",
      payload: { post_id: post, group_id: group, author_id: author },
    });

    const savedLease = process.env.INGEST_EVENT_LEASE_MS;
    // Renewals tick at a third of the lease and the deadline at 80%: long enough that the claim,
    // registration and ledger round trips complete first, short enough that a renewal fires inside
    // the stalled upsert.
    process.env.INGEST_EVENT_LEASE_MS = "6000";
    try {
      vectorUpsert.mockImplementation(async () => {
        renewalControl.throws = true;
        // Long enough for a renewal tick (lease/3 = 2 s) to hit the injected transport failure.
        await new Promise((resolve) => setTimeout(resolve, 2500));
      });

      await expect(memoryIngestEffects.apply(event)).rejects.toThrow(/renewal failed|lost the fan-out claim/);

      // The upsert had already left before ownership was lost — that write is the documented
      // un-cancellable residual. What must NOT happen is the next external call.
      expect(vectorUpsert).toHaveBeenCalledTimes(1);
      expect(vectorPrune).not.toHaveBeenCalled();
      expect(vectorDelete).not.toHaveBeenCalled();

      // And nothing was settled: the recipient stays outstanding for whoever takes the event next.
      const { rows } = await pgPool().query(
        `SELECT completed_at FROM ingest_progress WHERE event_id = $1`,
        [eventId]
      );
      expect(rows.every((row: { completed_at: string | null }) => row.completed_at === null)).toBe(true);
    } finally {
      renewalControl.throws = false;
      if (savedLease === undefined) delete process.env.INGEST_EVENT_LEASE_MS;
      else process.env.INGEST_EVENT_LEASE_MS = savedLease;
    }
  });
});
