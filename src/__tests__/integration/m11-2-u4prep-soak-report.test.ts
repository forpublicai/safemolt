/**
 * M11-2 u4-prep `[integration]` — drain-time shadow comparison, and the report that aggregates it.
 *
 * Two mechanisms, one file, because neither is provable without the other:
 *  - the DISPATCHER stamps `event_consumer_shadow.legacy_match` / `legacy_detail` while it writes
 *    the shadow row, reading the legacy twin the transitional inline writer committed with the
 *    event (Decision 2) moments earlier;
 *  - `scripts/soak-shadow-report.sql` aggregates those stamps, and owns only the arms no drain can
 *    stamp — a keyed legacy row with no shadow twin, and the malformed rows on either side.
 *
 * **Every legitimate fixture goes through the REAL DRAIN** (`activateEventConsumer` +
 * `drainEventConsumer` over the shipped registry), not through a direct `handleEvent` call: what
 * production runs is the drain, and receipting, manifest selection and the shadow write are all part
 * of the contract under test. An anomaly fixture is manufactured by corrupting or removing a row a
 * real writer produced — never by hand-typing a payload, which would carry unstripped volatile
 * fields and mismatch for the wrong reason.
 *
 * The report's own SQL is proved, not a re-implementation: the shipped file is read from disk, its
 * psql meta-commands are verified against an exact expected set and stripped, and `:'soak_start'` is
 * rebound to a `pg` parameter. Two REAL `psql` invocations cover both branches of the window.
 *
 * Events are looked up by their own `subject_id` — this database is shared across the whole
 * integration run — and "clean" fixtures assert a POSITIVE signal inside an isolated window
 * (`dbNow()` captured immediately before), never merely "no anomaly appeared".
 */
jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async () => {}),
  pruneIngestedVectorsForAgent: jest.fn(async () => {}),
  listVectorIdsForAgentByMetadata: jest.fn(async () => [] as string[]),
  deleteVectorsForAgent: jest.fn(async () => {}),
}));

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";

import { activityTrailEffects } from "@/lib/events/consumers/activity-trail";
import {
  activityTrailCoverage,
  memoryIngestCoverage,
  notificationsCoverage,
  type CoverageManifest,
} from "@/lib/events/consumers/coverage";
import { LEGACY_MATCH_VALUES } from "@/lib/events/consumers/legacy-compare";
import { notificationEffects } from "@/lib/events/consumers/notifications";
import { eventConsumers } from "@/lib/events/consumers/registry";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { followAgent } from "@/lib/store/agents/db";
import { createComment } from "@/lib/store/comments/db";
import { emitEvent, getEventById } from "@/lib/store/events/db";
import { drainEventConsumer } from "@/lib/store/events/drain-db";
import { joinGroup, leaveGroup } from "@/lib/store/groups/db";
import { createPost } from "@/lib/store/posts/db";
import { deletePostAndCleanUp } from "@/lib/post-deletion";
import type { StoredComment, StoredEvent, StoredPost } from "@/lib/store-types";

import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { activateRealConsumers } from "./helpers/activate-consumers";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u4p_${kind}_${RUN}_${(seq += 1)}`;
const LONG_BODY =
  "A body long enough to survive the memory chunker's minimum chunk length, which is fifty characters.";

const SOAK_REPORT_SQL_PATH = path.join(__dirname, "..", "..", "..", "scripts", "soak-shadow-report.sql");

/** The exact four psql meta-command lines the shipped script carries, in order — anything else fails. */
const EXPECTED_META_LINES = [
  `\\if :{?soak_start}`,
  `\\else`,
  `\\set soak_start ''`,
  `\\endif`,
];

function stripPsqlMetaCommands(raw: string): string {
  let expectedIndex = 0;
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("\\")) {
      kept.push(line);
      continue;
    }
    if (expectedIndex >= EXPECTED_META_LINES.length || trimmed !== EXPECTED_META_LINES[expectedIndex]) {
      throw new Error(
        `[soak-report test] unrecognized or out-of-order psql meta-command: ${JSON.stringify(trimmed)}. ` +
          `Expected next: ${EXPECTED_META_LINES[expectedIndex] ?? "(none — all four already consumed)"}`
      );
    }
    expectedIndex += 1;
  }
  if (expectedIndex !== EXPECTED_META_LINES.length) {
    throw new Error(
      `[soak-report test] expected ${EXPECTED_META_LINES.length} psql meta-command lines, found ${expectedIndex}`
    );
  }
  return kept.join("\n");
}

const RAW_REPORT_SQL = readFileSync(SOAK_REPORT_SQL_PATH, "utf8");
// A function replacement, deliberately: a literal `"$1"` in a `String.replace` pattern is a capture
// reference, and this regex has no groups.
const REPORT_SQL = stripPsqlMetaCommands(RAW_REPORT_SQL).replace(/:'soak_start'/g, () => "$1");

interface ReportRow {
  section: string;
  kind: string | null;
  consumer: string;
  effect_key: string | null;
  shadow_total: number | null;
  matched: number | null;
  payload_mismatch: number | null;
  legacy_missing: number | null;
  compare_error: number | null;
  superseded: number | null;
  unverifiable: number | null;
  not_stamped: number | null;
  legacy_only: number | null;
  uncorrelatable: number | null;
  note: string | null;
}

const NUMERIC_COLUMNS = [
  "shadow_total",
  "matched",
  "payload_mismatch",
  "legacy_missing",
  "compare_error",
  "superseded",
  "unverifiable",
  "not_stamped",
  "legacy_only",
  "uncorrelatable",
] as const;

/** `count(*)` is `bigint`, and `pg` returns bigint columns as strings — coerced here, once. */
async function runReport(soakStart: string): Promise<ReportRow[]> {
  const { rows } = await pgPool().query(REPORT_SQL, [soakStart]);
  return (rows as Record<string, unknown>[]).map((row) => {
    const coerced: Record<string, unknown> = { ...row };
    for (const column of NUMERIC_COLUMNS) coerced[column] = row[column] == null ? null : Number(row[column]);
    return coerced;
  }) as unknown as ReportRow[];
}

function summaryFor(rows: ReportRow[], consumer: string, kind: string): ReportRow {
  const row = rows.find((r) => r.section === "summary" && r.consumer === consumer && r.kind === kind);
  expect(row).toBeDefined();
  return row!;
}

async function seedAgent(): Promise<{ id: string; name: string }> {
  const id = nextId("agent");
  const name = `${id}_named`;
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, name, `u4p_key_${id}`]
  );
  return { id, name };
}

async function seedGroup(ownerId: string): Promise<string> {
  const id = nextId("group");
  await pgPool().query(
    `INSERT INTO groups (id, name, display_name, description, owner_id, member_ids)
     VALUES ($1, $1, $1, '', $2, '[]'::jsonb)`,
    [id, ownerId]
  );
  return id;
}

async function clearRateWindow(agentId: string): Promise<void> {
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id = $1`, [agentId]);
}

/** The soak's opening instant, from the SAME clock the report's own `now()`-relative default uses. */
async function dbNow(): Promise<string> {
  const { rows } = await pgPool().query<{ now: Date }>(`SELECT now() AS now`);
  return rows[0].now.toISOString();
}

const commentCreatedEvent = (commenterId: string, postId: string): PreparedEvent<"comment.created"> => ({
  kind: "comment.created",
  actorAgentId: commenterId,
  subjectType: "comment",
  subjectId: STORE_ASSIGNED_PAYLOAD_ID,
  payload: { comment_id: STORE_ASSIGNED_PAYLOAD_ID, post_id: postId, parent_id: null },
});

const postCreatedEvent = (authorId: string, groupId: string): PreparedEvent<"post.created"> => ({
  kind: "post.created",
  actorAgentId: authorId,
  subjectType: "post",
  subjectId: STORE_ASSIGNED_PAYLOAD_ID,
  payload: { post_id: STORE_ASSIGNED_PAYLOAD_ID, group_id: groupId, author_id: authorId },
});

const followEvent = (followerId: string, followeeId: string): PreparedEvent<"agent.followed"> => ({
  kind: "agent.followed",
  actorAgentId: followerId,
  subjectType: "agent",
  subjectId: followeeId,
  payload: {},
});

const groupJoinedEvent = (agentId: string, groupId: string): PreparedEvent<"group.joined"> => ({
  kind: "group.joined",
  actorAgentId: agentId,
  subjectType: "group",
  subjectId: groupId,
  payload: {},
});

const postDeletedEvent = (authorId: string, post: { id: string; groupId: string }): PreparedEvent<"post.deleted"> => ({
  kind: "post.deleted",
  actorAgentId: authorId,
  subjectType: "post",
  subjectId: post.id,
  payload: {
    post_id: post.id,
    group_id: post.groupId,
    author_id: authorId,
    commenter_ids: [STORE_ASSIGNED_PAYLOAD_ID],
    comment_ids: [STORE_ASSIGNED_PAYLOAD_ID],
    audience_agent_ids: [STORE_ASSIGNED_PAYLOAD_ID],
  },
});

let soakStart: string;
const createdEventIds: number[] = [];

/** The event a real producer just emitted, by the SUBJECT it names — immune to a stray write elsewhere. */
async function findEventBySubject(kind: string, subjectId: string): Promise<StoredEvent> {
  const { rows } = await pgPool().query<{ id: string }>(
    `SELECT id FROM events WHERE kind = $1 AND subject_id = $2 ORDER BY id DESC LIMIT 1`,
    [kind, subjectId]
  );
  expect(rows).toHaveLength(1);
  const event = await getEventById(Number(rows[0].id));
  expect(event).not.toBeNull();
  createdEventIds.push(event!.id);
  return event!;
}

/** A real post via `createPost`, its `post.created` event captured. */
async function seedPost(title = "Post"): Promise<{ author: { id: string; name: string }; group: string; post: StoredPost; event: StoredEvent }> {
  const author = await seedAgent();
  const group = await seedGroup(author.id);
  await clearRateWindow(author.id);
  const post = await createPost(author.id, group, title, LONG_BODY, undefined, [postCreatedEvent(author.id, group)]);
  expect(post).not.toBeNull();
  const event = await findEventBySubject("post.created", post!.id);
  return { author, group, post: post!, event };
}

/** A real comment on `post` via `createComment`, its `comment.created` event captured. */
async function seedComment(
  post: { id: string },
  content = "comment"
): Promise<{ commenter: { id: string; name: string }; comment: StoredComment; event: StoredEvent }> {
  const commenter = await seedAgent();
  await clearRateWindow(commenter.id);
  const comment = await createComment(post.id, commenter.id, content, undefined, [commentCreatedEvent(commenter.id, post.id)]);
  expect(comment).not.toBeNull();
  const event = await findEventBySubject("comment.created", comment!.id);
  return { commenter, comment: comment!, event };
}

/** Deletes `post` via the real deletion path, its `post.deleted` event captured. */
async function seedDeletion(authorId: string, post: { id: string; groupId: string }): Promise<StoredEvent> {
  const deletion = await deletePostAndCleanUp(post.id, authorId, [postDeletedEvent(authorId, post)]);
  expect(deletion.ok).toBe(true);
  return findEventBySubject("post.deleted", post.id);
}

/**
 * The whole shipped registry, drained. Activation happens once in `beforeAll` and classifies
 * everything emitted before it as pre-activation, so this file's own fixtures are the only events it
 * can reach that this run created.
 */
async function drainAll(): Promise<void> {
  for (const consumer of eventConsumers) {
    // Bounded passes rather than one: this database is shared, so a backlog from an earlier suite
    // could otherwise fill a single batch and leave THIS file's fixture unconsumed and unstamped.
    for (let pass = 0; pass < 10; pass += 1) {
      const counts = await drainEventConsumer(consumer, { batchSize: 200 });
      if (counts.processed === 0) break;
    }
  }
}

interface StampRow {
  legacy_match: string | null;
  legacy_detail: Record<string, unknown> | null;
}

async function stampOf(consumer: string, eventId: number, effectKey: string): Promise<StampRow | null> {
  const { rows } = await pgPool().query<StampRow>(
    `SELECT legacy_match, legacy_detail FROM event_consumer_shadow
     WHERE consumer = $1 AND event_id = $2 AND effect_key = $3`,
    [consumer, eventId, effectKey]
  );
  return rows[0] ?? null;
}

async function stampsOf(consumer: string, eventId: number): Promise<StampRow[]> {
  const { rows } = await pgPool().query<StampRow>(
    `SELECT legacy_match, legacy_detail FROM event_consumer_shadow
     WHERE consumer = $1 AND event_id = $2 ORDER BY effect_key`,
    [consumer, eventId]
  );
  return rows;
}

async function receipted(eventId: number): Promise<string[]> {
  const { rows } = await pgPool().query<{ consumer: string }>(
    `SELECT consumer FROM event_receipts WHERE event_id = $1 ORDER BY consumer`,
    [eventId]
  );
  return rows.map((row) => row.consumer);
}

const REAL_CONSUMERS = [...eventConsumers.map((consumer) => consumer.name)].sort();

async function sweepStaleU4pFixtures(): Promise<void> {
  const like = "u4p\\_%";
  await pgPool().query(
    `DELETE FROM comments WHERE author_id LIKE $1 ESCAPE '\\' OR post_id IN
       (SELECT id FROM posts WHERE author_id LIKE $1 ESCAPE '\\' OR group_id LIKE $1 ESCAPE '\\')`,
    [like]
  );
  await pgPool().query(
    `DELETE FROM posts WHERE author_id LIKE $1 ESCAPE '\\' OR group_id LIKE $1 ESCAPE '\\'`,
    [like]
  );
  await pgPool().query(
    `DELETE FROM group_members WHERE agent_id LIKE $1 ESCAPE '\\' OR group_id LIKE $1 ESCAPE '\\'`,
    [like]
  );
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1 ESCAPE '\\'`, [like]);
  await pgPool().query(
    `DELETE FROM following WHERE follower_id LIKE $1 ESCAPE '\\' OR followee_id LIKE $1 ESCAPE '\\'`,
    [like]
  );
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id LIKE $1 ESCAPE '\\'`, [like]);
  await pgPool().query(
    `DELETE FROM notifications WHERE agent_id LIKE $1 ESCAPE '\\' OR dedup_key LIKE $1 ESCAPE '\\'`,
    [like]
  );
  await pgPool().query(
    `DELETE FROM activity_events WHERE actor_id LIKE $1 ESCAPE '\\' OR entity_id LIKE $1 ESCAPE '\\'`,
    [like]
  );
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1 ESCAPE '\\'`, [like]);
}

beforeAll(async () => {
  await sweepStaleU4pFixtures();
  soakStart = await dbNow();
  await activateRealConsumers();
});

afterAll(async () => {
  const like = `u4p_%_${RUN}%`;
  if (createdEventIds.length > 0) {
    await pgPool().query(`DELETE FROM event_consumer_shadow WHERE event_id = ANY($1::bigint[])`, [createdEventIds]);
    await pgPool().query(`DELETE FROM event_receipts WHERE event_id = ANY($1::bigint[])`, [createdEventIds]);
    await pgPool().query(`DELETE FROM event_consumer_failures WHERE event_id = ANY($1::bigint[])`, [createdEventIds]);
    await pgPool().query(`DELETE FROM event_dead_letters WHERE event_id = ANY($1::bigint[])`, [createdEventIds]);
    await pgPool().query(`DELETE FROM ingest_progress WHERE event_id = ANY($1::bigint[])`, [createdEventIds]);
    await pgPool().query(`DELETE FROM ingest_event_claims WHERE event_id = ANY($1::bigint[])`, [createdEventIds]);
    await pgPool().query(`DELETE FROM events WHERE id = ANY($1::bigint[])`, [createdEventIds]);
  }
  await pgPool().query(`DELETE FROM notifications WHERE agent_id LIKE $1 OR dedup_key LIKE $2`, [like, `%${RUN}%`]);
  await pgPool().query(`DELETE FROM activity_events WHERE actor_id LIKE $1 OR entity_id LIKE $1`, [like]);
  await pgPool().query(
    `DELETE FROM comments WHERE author_id LIKE $1 OR post_id IN (SELECT id FROM posts WHERE author_id LIKE $1)`,
    [like]
  );
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE $1 OR group_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM group_members WHERE agent_id LIKE $1 OR group_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM following WHERE follower_id LIKE $1 OR followee_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agent_rate_limits WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("the shipped script's psql surface", () => {
  it("recognizes exactly the four shipped directives and rejects an unrecognized or reordered one", () => {
    expect(() => stripPsqlMetaCommands(RAW_REPORT_SQL)).not.toThrow();
    const injected = RAW_REPORT_SQL.replace("\\endif", "\\include naughty.sql\n\\endif");
    expect(() => stripPsqlMetaCommands(injected)).toThrow(/unrecognized or out-of-order/);
    const reordered = RAW_REPORT_SQL.replace("\\if :{?soak_start}\n\\else", "\\else\n\\if :{?soak_start}");
    expect(reordered).not.toBe(RAW_REPORT_SQL);
    expect(() => stripPsqlMetaCommands(reordered)).toThrow();
  });

  /**
   * The report's `stamp_vocabulary` is a hand-written copy of `LEGACY_MATCH_VALUES`, and a value it
   * does not know is claimed by `invalid_shadow` as `unknown_stamp:<value>`. That is the right
   * failure mode for a NEWER build's vocabulary reaching an OLDER report — and exactly the wrong one
   * for a value this build stamps routinely, which would turn every `superseded` row into a
   * malformed-row anomaly. So the two lists are compared outright.
   */
  it("carries the same stamp vocabulary the dispatcher stamps", () => {
    const block = /stamp_vocabulary\(value\) AS \(\s*VALUES([\s\S]*?)\n\),/.exec(RAW_REPORT_SQL);
    expect(block).not.toBeNull();
    const inSql = Array.from(block![1].matchAll(/'([a-z_]+)'/g)).map((match) => match[1]);
    expect(inSql.slice().sort()).toEqual([...LEGACY_MATCH_VALUES].sort());
  });

  it("interpolates the window as a QUOTED LITERAL, never as raw SQL", () => {
    // The hardening in one assertion: a bare `:soak_start` would substitute whatever the operator
    // typed straight into the statement. `:'soak_start'` cannot.
    expect(RAW_REPORT_SQL).toContain(`NULLIF(:'soak_start', '')::timestamptz`);
    expect(RAW_REPORT_SQL).not.toMatch(/[^']:soak_start\b/);
  });

  it("runs through a REAL psql with NO -v at all — the default branch", () => {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error("[integration] POSTGRES_URL is unset");
    // The `\else` arm sets an EMPTY variable and the `params` CTE supplies the 3-day default. It is
    // its own branch and its own failure mode: an unguarded cast of `''` raises 22007 at plan time,
    // which only an invocation without `-v` can catch.
    const out = execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", SOAK_REPORT_SQL_PATH], {
      encoding: "utf8",
    });
    expect(out).toContain("summary");
  });

  it("runs through a REAL psql WITH -v soak_start= — the override branch", () => {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error("[integration] POSTGRES_URL is unset");
    // A window nothing can land inside, however busy the shared DB is: a `no_data:` result can ONLY
    // come from the override reaching `\if :{?soak_start}` and winning.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const out = execFileSync(
      "psql",
      [url, "-v", "ON_ERROR_STOP=1", "-v", `soak_start=${farFuture}`, "-f", SOAK_REPORT_SQL_PATH],
      { encoding: "utf8" }
    );
    expect(out).toContain("no_data:");
  });
});

describe("expected_pairs matches the checked-in coverage manifests", () => {
  it("lists exactly the (consumer, kind) pairs each manifest marks 'shadow'", async () => {
    const shadowPairs = (consumer: string, manifest: CoverageManifest) =>
      Object.entries(manifest).filter(([, state]) => state === "shadow").map(([kind]) => `${consumer}:${kind}`);
    const expected = new Set([
      ...shadowPairs("activity-trail", activityTrailCoverage),
      ...shadowPairs("notifications", notificationsCoverage),
      ...shadowPairs("memory-ingest", memoryIngestCoverage),
    ]);
    // A window far in the future: nothing can land inside it, so any row present is `expected_pairs`
    // driving the output, not real data.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await runReport(farFuture);
    const reported = new Set(rows.filter((r) => r.section === "summary" && r.consumer !== "(any)").map((r) => `${r.consumer}:${r.kind}`));
    expect(reported).toEqual(expected);
  });
});

describe("a clean pair through the real drain is STAMPED matched and COUNTED matched", () => {
  it("post.created + comment.created: activity and notification twins match, ingest is unverifiable", async () => {
    const windowStart = await dbNow();
    const { author, post, event: postEvent } = await seedPost("Drain matched");
    const { comment, event: commentEvent } = await seedComment(post, "drain matched comment");

    await drainAll();

    // Every consumer receipted both events — `shadow` and `none` alike, which is what keeps the scan
    // floor moving. A missing receipt would wedge this consumer at that id forever.
    expect(await receipted(postEvent.id)).toEqual(REAL_CONSUMERS);
    expect(await receipted(commentEvent.id)).toEqual(REAL_CONSUMERS);

    const postKey = `post:${post.id}`;
    const commentKey = `comment:${comment.id}`;
    const notifKey = `comment_on_my_post:${author.id}:${commentEvent.id}`;

    expect(await stampOf("activity-trail", postEvent.id, postKey)).toEqual({ legacy_match: "matched", legacy_detail: null });
    expect(await stampOf("activity-trail", commentEvent.id, commentKey)).toEqual({ legacy_match: "matched", legacy_detail: null });
    expect(await stampOf("notifications", commentEvent.id, notifKey)).toEqual({ legacy_match: "matched", legacy_detail: null });

    // Ingest has no SQL-visible legacy side at all, and says so per row rather than leaving NULL.
    const ingest = await stampsOf("memory-ingest", postEvent.id);
    expect(ingest.length).toBeGreaterThan(0);
    expect(ingest.every((row) => row.legacy_match === "unverifiable")).toBe(true);
    expect(String(ingest[0].legacy_detail?.reason)).toContain("external vector provider");

    const rows = await runReport(windowStart);
    const activityPosts = summaryFor(rows, "activity-trail", "post.created");
    expect(activityPosts.matched).toBe(1);
    expect(activityPosts.note).toEqual(expect.stringContaining("clean:"));
    const notifComments = summaryFor(rows, "notifications", "comment.created");
    expect(notifComments.matched).toBe(1);
    expect(notifComments.note).toEqual(expect.stringContaining("clean:"));
    const ingestPosts = summaryFor(rows, "memory-ingest", "post.created");
    expect(ingestPosts.unverifiable).toBeGreaterThan(0);
    expect(ingestPosts.note).toEqual(expect.stringContaining("unverifiable"));
    // No detail row anywhere for a clean key.
    expect(rows.some((r) => r.effect_key === postKey && r.section !== "summary")).toBe(false);
    expect(rows.some((r) => r.effect_key === notifKey && r.section !== "summary")).toBe(false);
  }, 30000);

  it("agent.followed: both consumers stamp matched from one real follow", async () => {
    const windowStart = await dbNow();
    const follower = await seedAgent();
    const followee = await seedAgent();
    await followAgent(follower.id, followee.name, [followEvent(follower.id, followee.id)]);
    const event = await findEventBySubject("agent.followed", followee.id);

    await drainAll();

    expect(await stampOf("activity-trail", event.id, `follow:${follower.id}:${followee.id}`)).toEqual({
      legacy_match: "matched",
      legacy_detail: null,
    });
    expect(await stampOf("notifications", event.id, `new_follower:${followee.id}:${event.id}`)).toEqual({
      legacy_match: "matched",
      legacy_detail: null,
    });

    const rows = await runReport(windowStart);
    expect(summaryFor(rows, "activity-trail", "agent.followed").matched).toBe(1);
    expect(summaryFor(rows, "notifications", "agent.followed").matched).toBe(1);
  });

  it("group.joined: the activity twin matches", async () => {
    const windowStart = await dbNow();
    const owner = await seedAgent();
    const joiner = await seedAgent();
    const group = await seedGroup(owner.id);
    const joined = await joinGroup(joiner.id, group, [groupJoinedEvent(joiner.id, group)]);
    expect(joined.success).toBe(true);
    const event = await findEventBySubject("group.joined", group);

    await drainAll();

    expect(await stampOf("activity-trail", event.id, `group_join:${joiner.id}:${group}`)).toEqual({
      legacy_match: "matched",
      legacy_detail: null,
    });
    const rows = await runReport(windowStart);
    const summary = summaryFor(rows, "activity-trail", "group.joined");
    expect(summary.matched).toBe(1);
    expect(summary.note).toEqual(expect.stringContaining("clean:"));
  });

  /**
   * u4prep2 finding 1 — a REUSED natural key, through two real producers and one drain.
   *
   * `group_join:{agent}:{group}` survives a leave, so a re-join writes the same row again and the
   * inline upsert replaces `source_event_id` with the second event's. The first event then drains
   * against a row it no longer owns, which is routine on both sides: it used to stamp verdict-bearing
   * `legacy_missing` and made an ordinary join/leave/re-join permanently un-clean.
   */
  it("group.joined twice on one key: the older event is superseded, the newer matched", async () => {
    const windowStart = await dbNow();
    const owner = await seedAgent();
    const joiner = await seedAgent();
    const group = await seedGroup(owner.id);

    expect((await joinGroup(joiner.id, group, [groupJoinedEvent(joiner.id, group)])).success).toBe(true);
    const firstEvent = await findEventBySubject("group.joined", group);
    expect((await leaveGroup(joiner.id, group)).success).toBe(true);
    // The trail row outlives the membership — leaving removes no projection — so the re-join is a
    // second write to the SAME key.
    expect((await joinGroup(joiner.id, group, [groupJoinedEvent(joiner.id, group)])).success).toBe(true);
    const secondEvent = await findEventBySubject("group.joined", group);
    expect(secondEvent.id).toBeGreaterThan(firstEvent.id);

    await drainAll();

    const key = `group_join:${joiner.id}:${group}`;
    const older = await stampOf("activity-trail", firstEvent.id, key);
    expect(older?.legacy_match).toBe("superseded");
    expect(Number(older?.legacy_detail?.legacy_source_event_id)).toBe(secondEvent.id);
    expect(await stampOf("activity-trail", secondEvent.id, key)).toEqual({
      legacy_match: "matched",
      legacy_detail: null,
    });

    const rows = await runReport(windowStart);
    const summary = summaryFor(rows, "activity-trail", "group.joined");
    expect(summary.superseded).toBe(1);
    expect(summary.matched).toBe(1);
    // Counted and shown, never an anomaly — and never a detail row either.
    expect(summary.note).toEqual(expect.stringContaining("clean:"));
    expect(rows.some((r) => r.section === "superseded")).toBe(false);
  }, 30000);

  /**
   * `agent_loop.action` — u6 stitch item 3 (e).
   *
   * The strongest form of the u4prep2 rule this kind can demonstrate: `logAction` writes the journal
   * row, emits the event and writes the legacy trail row IN ONE STATEMENT, so the twin the drain
   * reads is stamped with exactly the event it is comparing — there is no window in which the drain
   * could see a row without a watermark, and no reusable key for a later event to take over.
   */
  it("agent_loop.action: the activity twin matches, stamped by the emitting statement", async () => {
    const windowStart = await dbNow();
    const actor = await seedAgent();
    const { logAction } = await import("@/lib/agent-loop");
    await logAction(actor.id, "create_post", undefined, undefined, "a soak journal entry");

    const event = await findEventBySubject("agent_loop.action", actor.id);
    const logId = String((event.payload as { log_id: string }).log_id);

    await drainAll();

    expect(await stampOf("activity-trail", event.id, `agent_loop:${logId}`)).toEqual({
      legacy_match: "matched",
      legacy_detail: null,
    });
    const rows = await runReport(windowStart);
    const summary = summaryFor(rows, "activity-trail", "agent_loop.action");
    expect(summary.matched).toBe(1);
    expect(summary.note).toEqual(expect.stringContaining("clean:"));
  });

  it("post.deleted stamps unverifiable on both non-ingest consumers, and is never called clean", async () => {
    const windowStart = await dbNow();
    const { author, post } = await seedPost("Deleted");
    await seedComment(post, "doomed comment");
    await drainAll();
    const deletedEvent = await seedDeletion(author.id, post);
    await drainAll();

    for (const consumer of ["activity-trail", "notifications"]) {
      const stamps = await stampsOf(consumer, deletedEvent.id);
      expect(stamps.length).toBeGreaterThan(0);
      expect(stamps.every((row) => row.legacy_match === "unverifiable")).toBe(true);
    }
    const rows = await runReport(windowStart);
    const summary = summaryFor(rows, "activity-trail", "post.deleted");
    expect(summary.unverifiable).toBeGreaterThan(0);
    expect(summary.note).toEqual(expect.stringContaining("deletion kind"));
    // The deletion family carries no verdict columns at all — a clean 0 there would be a lie.
    expect(summary.matched).toBeNull();
    expect(summary.payload_mismatch).toBeNull();
  }, 30000);
});

describe("a corrupted LEGACY row is stamped payload_mismatch, with the differing path", () => {
  it("notifications: a rewritten target title lands as target.title", async () => {
    const windowStart = await dbNow();
    const { author, post } = await seedPost("Notif mismatch");
    const { event } = await seedComment(post, "mismatch comment");
    const key = `comment_on_my_post:${author.id}:${event.id}`;

    // The legacy row the inline writer produced is corrupted BEFORE the drain, so the consumer's
    // comparison is the thing under test — not an after-the-fact edit of the shadow row.
    await pgPool().query(
      `UPDATE notifications SET target = jsonb_set(target, '{title}', '"WRONG TITLE"') WHERE dedup_key = $1`,
      [key]
    );

    await drainAll();

    const stamp = await stampOf("notifications", event.id, key);
    expect(stamp?.legacy_match).toBe("payload_mismatch");
    expect(stamp?.legacy_detail?.paths).toEqual(["target.title"]);
    expect(JSON.stringify(stamp?.legacy_detail)).toContain("WRONG TITLE");

    const rows = await runReport(windowStart);
    const summary = summaryFor(rows, "notifications", "comment.created");
    expect(summary.payload_mismatch).toBe(1);
    expect(summary.note).toEqual(expect.stringContaining("ANOMALIES"));
    const detail = rows.find((r) => r.section === "payload_mismatch" && r.effect_key === key);
    expect(detail).toBeDefined();
    expect(detail!.note).toEqual(expect.stringContaining("WRONG TITLE"));
  }, 30000);

  it("activity-trail: a rewritten title lands as title, and an emptied metadata lands as metadata", async () => {
    const windowStart = await dbNow();
    const { post: titlePost, event: titleEvent } = await seedPost("Activity mismatch");
    await pgPool().query(`UPDATE activity_events SET title = 'WRONG TITLE' WHERE kind = 'post' AND entity_id = $1`, [
      titlePost.id,
    ]);

    const { post: metaPost, event: metaEvent } = await seedPost("Activity metadata mismatch");
    await pgPool().query(`UPDATE activity_events SET metadata = '{}'::jsonb WHERE kind = 'post' AND entity_id = $1`, [
      metaPost.id,
    ]);

    await drainAll();

    const titleStamp = await stampOf("activity-trail", titleEvent.id, `post:${titlePost.id}`);
    expect(titleStamp?.legacy_match).toBe("payload_mismatch");
    expect(titleStamp?.legacy_detail?.paths).toEqual(["title"]);

    // A DROPPED key is a mismatch too — the presence-sensitive diff is what a containment check
    // (`@>`) would pass vacuously.
    const metaStamp = await stampOf("activity-trail", metaEvent.id, `post:${metaPost.id}`);
    expect(metaStamp?.legacy_match).toBe("payload_mismatch");
    expect(metaStamp?.legacy_detail?.paths).toEqual(expect.arrayContaining(["metadata.group_id"]));

    const rows = await runReport(windowStart);
    expect(summaryFor(rows, "activity-trail", "post.created").payload_mismatch).toBe(2);
  }, 30000);
});

describe("a legacy twin that is absent when the event drains is stamped legacy_missing", () => {
  it("notifications: the row removed before the drain", async () => {
    const windowStart = await dbNow();
    const { author, post } = await seedPost("Notif missing");
    const { event } = await seedComment(post, "missing twin comment");
    const key = `comment_on_my_post:${author.id}:${event.id}`;
    await pgPool().query(`DELETE FROM notifications WHERE dedup_key = $1`, [key]);

    await drainAll();

    const stamp = await stampOf("notifications", event.id, key);
    expect(stamp?.legacy_match).toBe("legacy_missing");
    expect(stamp?.legacy_detail).toEqual({ dedup_key: key });

    const rows = await runReport(windowStart);
    const summary = summaryFor(rows, "notifications", "comment.created");
    expect(summary.legacy_missing).toBe(1);
    expect(summary.note).toEqual(expect.stringContaining("ANOMALIES"));
    expect(rows.some((r) => r.section === "legacy_missing" && r.effect_key === key)).toBe(true);
  }, 30000);

  /**
   * The OLDER-watermark direction, which is the verdict-bearing one (u4prep2 finding 1).
   *
   * A row whose `source_event_id` stopped before this event means the inline writer never landed for
   * it — nothing newer replaced it either. The mirror case, a row a LATER event owns, is routine
   * supersession and is stamped `superseded`; see the group.joined re-join fixture above.
   */
  it("activity-trail: a row whose watermark stopped at an EARLIER event", async () => {
    const windowStart = await dbNow();
    const { post, event } = await seedPost("Activity stale source");
    await pgPool().query(
      `UPDATE activity_events SET source_event_id = source_event_id - 1 WHERE kind = 'post' AND entity_id = $1`,
      [post.id]
    );

    await drainAll();

    const stamp = await stampOf("activity-trail", event.id, `post:${post.id}`);
    expect(stamp?.legacy_match).toBe("legacy_missing");
    expect(String(stamp?.legacy_detail?.reason)).toContain("stopped at an earlier event");
    expect(Number(stamp?.legacy_detail?.legacy_source_event_id)).toBe(event.id - 1);

    const rows = await runReport(windowStart);
    expect(summaryFor(rows, "activity-trail", "post.created").legacy_missing).toBe(1);
  }, 30000);
});

/**
 * u4prep2 finding 3 — the describe→twin-read gap, closed by re-locking the subject.
 *
 * **Driven directly rather than through the drain, and that is deliberate.** The window under test
 * is the one BETWEEN `describe` and `readLegacyTwin`, two separate auto-committed statements inside
 * one dispatch; no fixture can pause the drain there without a barrier this suite does not carry.
 * What the fix is, though, is a property of the twin read alone — a subject that is gone answers
 * `unverifiable`, never `legacy_missing` — so the reader is called with a real event, a real key,
 * and a real deletion, before and after. The live half is the control: without it, an `unverifiable`
 * could just as well come from a key nothing ever matched.
 */
describe("a subject deleted before the twin read is unverifiable, not legacy_missing", () => {
  it("both consumers answer unverifiable once the post is a tombstone", async () => {
    const { author, post, event: postEvent } = await seedPost("Deleted before twin read");
    const { comment, event: commentEvent } = await seedComment(post, "doomed twin comment");
    const notifKey = `comment_on_my_post:${author.id}:${commentEvent.id}`;

    // Live: every reader finds its own twin. Whatever the payloads say, the STATE is `row`.
    expect((await notificationEffects.readLegacyTwin!(commentEvent, notifKey)).state).toBe("row");
    expect(
      (await activityTrailEffects.readLegacyTwin!(commentEvent, `comment:${comment.id}`)).state
    ).toBe("row");
    expect((await activityTrailEffects.readLegacyTwin!(postEvent, `post:${post.id}`)).state).toBe("row");

    // The real deletion path: the tombstone, the trail rows and the notifications, all correct.
    await seedDeletion(author.id, post);

    for (const twin of [
      await notificationEffects.readLegacyTwin!(commentEvent, notifKey),
      await activityTrailEffects.readLegacyTwin!(commentEvent, `comment:${comment.id}`),
      await activityTrailEffects.readLegacyTwin!(postEvent, `post:${post.id}`),
    ]) {
      expect(twin.state).toBe("unverifiable");
      expect(String((twin as { reason: string }).reason)).toContain("deleted before the twin read");
    }
  }, 30000);
});

describe("the arms no drain can stamp", () => {
  it("legacy_only: a keyed legacy row whose shadow twin never existed", async () => {
    const windowStart = await dbNow();
    const { author, post } = await seedPost("Legacy only");
    const { event } = await seedComment(post, "legacy only comment");
    const key = `comment_on_my_post:${author.id}:${event.id}`;
    await drainAll();
    // The shadow row is removed AFTER the receipt, so nothing can rewrite it: the legacy row is now
    // keyed, in-window, and uncompared by anything — exactly the shape no stamp can describe.
    await pgPool().query(
      `DELETE FROM event_consumer_shadow WHERE consumer = 'notifications' AND event_id = $1`,
      [event.id]
    );

    const rows = await runReport(windowStart);
    const summary = summaryFor(rows, "notifications", "comment.created");
    expect(summary.legacy_only).toBe(1);
    expect(summary.note).toEqual(expect.stringContaining("ANOMALIES"));
    expect(rows.some((r) => r.section === "legacy_only_key" && r.effect_key === key)).toBe(true);
  }, 30000);

  it("uncorrelatable: a legacy row written with no key at all", async () => {
    const windowStart = await dbNow();
    const { post } = await seedPost("Uncorrelatable");
    const commenter = await seedAgent();
    await clearRateWindow(commenter.id);
    // No events array: the inline writer runs with a NULL dedup key, which correlates with nothing.
    const comment = await createComment(post.id, commenter.id, "uncorrelatable comment");
    expect(comment).not.toBeNull();

    const rows = await runReport(windowStart);
    const summary = summaryFor(rows, "notifications", "comment.created");
    expect(summary.uncorrelatable).toBeGreaterThanOrEqual(1);
    expect(summary.note).toEqual(expect.stringContaining("ANOMALIES"));
  }, 30000);

  it("not_stamped: a pre-amendment row is its own bucket and is never clean", async () => {
    const windowStart = await dbNow();
    const { post, event } = await seedPost("Not stamped");
    const key = `post:${post.id}`;
    // What a build with no drain-time comparison wrote: a well-formed row with a NULL verdict.
    await pgPool().query(
      `INSERT INTO event_consumer_shadow (consumer, event_id, effect_key, payload)
       VALUES ('activity-trail', $1, $2, '{}'::jsonb)`,
      [event.id, key]
    );

    const rows = await runReport(windowStart);
    const summary = summaryFor(rows, "activity-trail", "post.created");
    expect(summary.not_stamped).toBe(1);
    expect(summary.note).toEqual(expect.stringContaining("ANOMALIES"));
    expect(rows.some((r) => r.section === "not_stamped" && r.effect_key === key)).toBe(true);
  }, 30000);
});

describe("malformed rows on either side fail the verdict instead of vanishing", () => {
  it("invalid_shadow: NULL fields, an orphan event id, an unexpected pair and an unknown stamp", async () => {
    const author = await seedAgent();
    const event = await emitEvent({
      kind: "post.created",
      actorAgentId: author.id,
      subjectType: "post",
      subjectId: nextId("post"),
      payload: { post_id: nextId("post"), group_id: nextId("group"), author_id: author.id },
    });
    createdEventIds.push(event.id);
    const orphanEventId = 999_999_999_999;
    const orphanKey = `u4p_orphan:${nextId("orphan")}`;
    const unknownStampKey = `post:${nextId("unknown_stamp")}`;
    try {
      await pgPool().query(
        `INSERT INTO event_consumer_shadow (consumer, event_id, effect_key, payload, legacy_match) VALUES
           (NULL, $1, 'u4p_invalid:null-consumer', '{}'::jsonb, 'matched'),
           ('activity-trail', NULL, 'u4p_invalid:null-event-id', '{}'::jsonb, 'matched'),
           ('activity-trail', $1, NULL, '{}'::jsonb, 'matched'),
           ('activity-trail', $1, 'u4p_invalid:null-payload', NULL, 'matched'),
           ('activty-trail', $1, 'u4p_invalid:misspelled-consumer', '{}'::jsonb, 'matched'),
           ('activity-trail', $2, $3, '{}'::jsonb, 'matched'),
           ('activity-trail', $1, $4, '{}'::jsonb, 'banana')`,
        [event.id, orphanEventId, orphanKey, unknownStampKey]
      );

      const rows = await runReport(soakStart);
      const detail = rows.filter((r) => r.section === "invalid_shadow_row");
      expect(detail.some((r) => r.note?.includes("reason=null_field") && r.consumer === "(null)")).toBe(true);
      expect(detail.some((r) => r.note?.includes("reason=null_field") && r.effect_key === "(null)")).toBe(true);
      expect(detail.some((r) => r.note?.includes("event_id=(null)"))).toBe(true);
      expect(detail.some((r) => r.effect_key === orphanKey && r.note?.includes("reason=orphan_event_id"))).toBe(true);
      expect(
        detail.some((r) => r.note?.includes("reason=unexpected_pair:activty-trail:post.created"))
      ).toBe(true);
      // An unrecognized stamp is claimed here rather than absorbed into a clean total — a newer
      // build's vocabulary must be visible, never counted as matched.
      expect(detail.some((r) => r.effect_key === unknownStampKey && r.note?.includes("reason=unknown_stamp:banana"))).toBe(true);

      const total = rows.find((r) => r.section === "summary" && r.consumer === "(any)" && r.note?.includes("event_consumer_shadow"));
      expect(total!.shadow_total).toBeGreaterThanOrEqual(7);
    } finally {
      await pgPool().query(
        `DELETE FROM event_consumer_shadow
         WHERE event_id = $1 OR event_id = $2
            OR (consumer IS NULL AND effect_key = 'u4p_invalid:null-consumer')
            OR (event_id IS NULL AND effect_key = 'u4p_invalid:null-event-id')`,
        [event.id, orphanEventId]
      );
    }
  });

  it("invalid_legacy: an unparseable key suffix and a suffix naming no event, neither raising 22P02", async () => {
    const recipient = await seedAgent();
    const unparseable = `comment_on_my_post:${recipient.id}:not-a-number`;
    const noSuchEvent = `comment_on_my_post:${recipient.id}:999999999999`;
    const staleActivityEntity = nextId("stale_activity");
    await pgPool().query(
      `INSERT INTO notifications (id, agent_id, type, priority, actor, target, href, metadata, dedup_key)
       VALUES ($1, $3, 'comment_on_my_post', 'normal', '{}'::jsonb, '{}'::jsonb, '', '{}'::jsonb, $4),
              ($2, $3, 'comment_on_my_post', 'normal', '{}'::jsonb, '{}'::jsonb, '', '{}'::jsonb, $5)`,
      [nextId("notif"), nextId("notif"), recipient.id, unparseable, noSuchEvent]
    );
    await pgPool().query(
      `INSERT INTO activity_events (kind, entity_id, occurred_at, actor_id, title, summary, href, source_event_id)
       VALUES ('post', $1, NOW(), $2, 'Stale source', 'Stale source', '/post/' || $1, 999999999999)`,
      [staleActivityEntity, recipient.id]
    );
    try {
      const rows = await runReport(soakStart);
      const detail = rows.filter((r) => r.section === "invalid_legacy_row");
      expect(detail.some((r) => r.effect_key === unparseable && r.note?.includes("unparseable_event_id_suffix"))).toBe(true);
      expect(detail.some((r) => r.effect_key === noSuchEvent && r.note?.includes("dedup_key names no event"))).toBe(true);
      expect(
        detail.some((r) => r.effect_key === `post:${staleActivityEntity}` && r.note?.includes("source_event_id names no event"))
      ).toBe(true);

      const total = rows.find((r) => r.section === "summary" && r.consumer === "(any)" && r.note?.includes("names no event"));
      expect(total!.shadow_total).toBeGreaterThanOrEqual(3);
    } finally {
      await pgPool().query(`DELETE FROM notifications WHERE dedup_key = ANY($1::text[])`, [[unparseable, noSuchEvent]]);
      await pgPool().query(`DELETE FROM activity_events WHERE kind = 'post' AND entity_id = $1`, [staleActivityEntity]);
    }
  });
});

/**
 * u4prep2 finding 5 — one legacy row, one kind.
 *
 * `kind_map` is six-to-one for the playground family: all six lifecycle kinds write the SAME
 * `playground_session:{id}` row. Expanding a legacy row through the map charged every one of them,
 * so a single uncompared row turned five `no_data` pairs into anomalies and made the report's own
 * output unusable for deciding which kind to look at.
 *
 * The fixture is the finest one that isolates it: a real event of ONE playground kind, a legacy trail
 * row stamped with that event's id, and no shadow twin — which is `legacy_only` by definition. It is
 * deliberately never drained; the assertion is the report's attribution, not a dispatch.
 */
describe("a legacy row shared by six kinds is attributed to exactly one", () => {
  const OTHER_PLAYGROUND_KINDS = [
    "playground.session_created",
    "playground.participant_affiliation_updated",
    "playground.session_completed",
    "playground.session_cancelled",
    "playground.session_expired",
  ];

  it("legacy_only increments only the kind whose event actually stamped the row", async () => {
    const windowStart = await dbNow();
    const actor = await seedAgent();
    const sessionId = nextId("session");
    const event = await emitEvent({
      kind: "playground.session_joined",
      actorAgentId: actor.id,
      subjectType: "playground_session",
      subjectId: sessionId,
      payload: {},
    });
    createdEventIds.push(event.id);
    await pgPool().query(
      `INSERT INTO activity_events (kind, entity_id, occurred_at, actor_id, title, summary, href, source_event_id)
       VALUES ('playground_session', $1, NOW(), $2, 'g session', 'g session', '/playground', $3)`,
      [sessionId, actor.id, event.id]
    );
    try {
      const rows = await runReport(windowStart);

      const joined = summaryFor(rows, "activity-trail", "playground.session_joined");
      expect(joined.legacy_only).toBe(1);
      expect(joined.note).toEqual(expect.stringContaining("ANOMALIES"));
      for (const kind of OTHER_PLAYGROUND_KINDS) {
        const summary = summaryFor(rows, "activity-trail", kind);
        expect([kind, summary.legacy_only]).toEqual([kind, 0]);
        expect([kind, summary.note]).toEqual([kind, expect.stringContaining("no_data")]);
      }
      // And ONE detail row, not six.
      expect(
        rows.filter(
          (r) => r.section === "legacy_only_key" && r.effect_key === `playground_session:${sessionId}`
        )
      ).toHaveLength(1);
    } finally {
      await pgPool().query(
        `DELETE FROM activity_events WHERE kind = 'playground_session' AND entity_id = $1`,
        [sessionId]
      );
    }
  }, 30000);
});
