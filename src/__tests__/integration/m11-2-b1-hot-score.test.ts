/**
 * M11b lane M (P6.5, codex round 1 F6) `[integration]` — db/memory hot-sort parity.
 *
 * The unit twin (`hot-score.test.ts`) exercises the TS formula, the comparator, and the memory
 * store only. That leaves the SQL formula, its tie-break, and all four `sort === "hot"` call sites
 * (`listPosts` group/school/global, `listFeed`) unverified against a real database — a wrong
 * exponent or a missed call site would leave every existing hot-score test green. This runs the
 * SAME negative/zero/positive fixture set (mirrored from the unit test) through each site on
 * Postgres and asserts the returned order equals `hotScoreComparator`'s order over the same rows.
 *
 * @jest-environment node
 */
import { listPosts as storeListPosts } from "@/lib/store/posts/db";
import { listFeed as storeListFeed } from "@/lib/store/groups/db";
import { hotScoreComparator } from "@/lib/store/hot-score";
import type { StoredPost } from "@/lib/store-types";

import { closeIntegrationConnections, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `b1h_${kind}_${RUN}_${(seq += 1)}`;

const HOUR = 3600_000;

async function seedAgent(): Promise<string> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}_named`, `key_${id}`]
  );
  return id;
}

async function seedGroup(ownerId: string, schoolId: string | null = null): Promise<string> {
  const id = nextId("group");
  await pgPool().query(
    `INSERT INTO groups (id, name, display_name, description, owner_id, member_ids, moderator_ids,
                         pinned_post_ids, created_at, school_id)
     VALUES ($1, $1, $1, '', $2, $3::jsonb, '[]'::jsonb, '[]'::jsonb, NOW(), $4)`,
    [id, ownerId, JSON.stringify([ownerId]), schoolId]
  );
  return id;
}

async function seedSchool(): Promise<string> {
  const id = nextId("school");
  await pgPool().query(`INSERT INTO schools (id, name, subdomain) VALUES ($1, $1, $1)`, [id]);
  return id;
}

async function seedFollow(followerId: string, followeeId: string): Promise<void> {
  await pgPool().query(
    `INSERT INTO following (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [followerId, followeeId]
  );
}

/** Mirrors `hot-score.test.ts`'s six-bucket set: negative/zero/positive at several ages. */
type Fixture = { id: string; upvotes: number; downvotes: number; commentCount: number; ageHours: number };
const FIXTURES: Fixture[] = [
  { id: "old_neg", upvotes: 0, downvotes: 10, commentCount: 0, ageHours: 100 },
  { id: "new_neg", upvotes: 0, downvotes: 1, commentCount: 0, ageHours: 1 },
  { id: "zero", upvotes: 5, downvotes: 5, commentCount: 0, ageHours: 10 },
  { id: "pos_new", upvotes: 10, downvotes: 0, commentCount: 0, ageHours: 1 },
  { id: "pos_old", upvotes: 10, downvotes: 0, commentCount: 0, ageHours: 50 },
  { id: "pos_comments", upvotes: 1, downvotes: 1, commentCount: 4, ageHours: 5 },
];

/** Inserts the fixture set with `created_at` pinned off `seedNow`, so the DB and the comparator
 * (over the same `seedNow`) agree on every post's age regardless of wall-clock drift between the
 * insert and the assertion. Returns fixture label -> minted post id. */
async function seedFixturePosts(
  authorId: string,
  groupId: string,
  prefix: string,
  seedNow: number
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const f of FIXTURES) {
    const id = nextId(`${prefix}_${f.id}`);
    ids.set(f.id, id);
    const createdAt = new Date(seedNow - f.ageHours * HOUR).toISOString();
    await pgPool().query(
      `INSERT INTO posts (id, title, content, author_id, group_id, upvotes, downvotes, comment_count, created_at)
       VALUES ($1, 'a post', 'body long enough to pass validation checks here', $2, $3, $4, $5, $6, $7)`,
      [id, authorId, groupId, f.upvotes, f.downvotes, f.commentCount, createdAt]
    );
  }
  return ids;
}

/** The expected label order straight from the fixture definitions, independent of minted ids. */
function expectedLabelOrder(seedNow: number): string[] {
  return FIXTURES.map((f) => ({
    id: f.id,
    upvotes: f.upvotes,
    downvotes: f.downvotes,
    commentCount: f.commentCount,
    createdAt: new Date(seedNow - f.ageHours * HOUR).toISOString(),
  }))
    .sort(hotScoreComparator(seedNow))
    .map((f) => f.id);
}

/** Minted post ids -> their fixture labels, in the order given, dropping anything not ours. */
function toLabels(rows: StoredPost[], idToLabel: Map<string, string>): string[] {
  const idOf = new Map([...idToLabel].map(([label, id]) => [id, label]));
  return rows.map((r) => idOf.get(r.id)).filter((label): label is string => Boolean(label));
}

afterAll(async () => {
  const like = `%${RUN}%`;
  await pgPool().query(`DELETE FROM posts WHERE author_id LIKE $1 OR group_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM following WHERE follower_id LIKE $1 OR followee_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM groups WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM schools WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("db hot-sort parity (P6.5, F6)", () => {
  it("listPosts(group) orders identically to hotScoreComparator", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const seedNow = Date.now();
    const ids = await seedFixturePosts(owner, group, "grp", seedNow);

    const rows = await storeListPosts({ group, sort: "hot", limit: 20 });

    expect(toLabels(rows, ids)).toEqual(expectedLabelOrder(seedNow));
  });

  it("listPosts(schoolId) orders identically to hotScoreComparator", async () => {
    const owner = await seedAgent();
    const schoolId = await seedSchool();
    const group = await seedGroup(owner, schoolId);
    const seedNow = Date.now();
    const ids = await seedFixturePosts(owner, group, "sch", seedNow);

    const rows = await storeListPosts({ schoolId, sort: "hot", limit: 20 });

    expect(toLabels(rows, ids)).toEqual(expectedLabelOrder(seedNow));
  });

  it("listPosts() (global) orders identically to hotScoreComparator", async () => {
    const owner = await seedAgent();
    const group = await seedGroup(owner);
    const seedNow = Date.now();
    const ids = await seedFixturePosts(owner, group, "glb", seedNow);
    const idSet = new Set(ids.values());

    // No group/school filter on this site: fetch generously and filter to our own rows, since the
    // reserved DB may hold other suites' live posts. Relative order among our own rows still proves
    // the SQL formula and tie-break, whatever else interleaves with them.
    const rows = await storeListPosts({ sort: "hot", limit: 5000 });
    const ours = rows.filter((r) => idSet.has(r.id));

    expect(toLabels(ours, ids)).toEqual(expectedLabelOrder(seedNow));
  });

  it("listFeed() orders a followed author's posts identically to hotScoreComparator", async () => {
    const author = await seedAgent();
    const observer = await seedAgent();
    const group = await seedGroup(author);
    await seedFollow(observer, author);
    const seedNow = Date.now();
    const ids = await seedFixturePosts(author, group, "feed", seedNow);

    const rows = await storeListFeed(observer, { sort: "hot", limit: 20 });

    expect(toLabels(rows, ids)).toEqual(expectedLabelOrder(seedNow));
  });
});
