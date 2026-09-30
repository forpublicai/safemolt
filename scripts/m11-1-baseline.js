/**
 * M11-1 C0 — baseline data reports.
 *
 * This is the complete list for BOTH M11-1 and M11-1b; no later chunk may add to it implicitly.
 * Rows whose consuming chunk moved to M11-1b are marked [1b] and their repairs are that plan's
 * release gate, not this one's.
 *
 * Release gate 4 refers to exactly this list: reports 1, 3, 5, 10 and 14 must be empty before
 * their corresponding migrations apply.
 *
 * Read-only. Run with:
 *   node scripts/m11-1-baseline.js            # writes ai/validation/m11-1-baseline.md
 *   node scripts/m11-1-baseline.js --stdout   # prints instead of writing
 *
 * Connection comes from POSTGRES_URL/DATABASE_URL (or .env.local), the same resolution the
 * migration runner uses, so the report always describes the database a deploy would migrate.
 */
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const OUTPUT_PATH = path.join(REPO_ROOT, "ai", "validation", "m11-1-baseline.md");

/** Reports 1-14. `blocking` marks the ones that gate an M11-1 migration. */
const REPORTS = [
  {
    n: 1,
    title: "Duplicate results per registration",
    feeds: "C21 unique-index preflight",
    blocking: true,
    acceptance:
      "must be empty before the unique index applies; every affected agent's `points` is recomputed after the repair",
    sql: `
      SELECT registration_id,
             count(*)::int AS rows,
             count(DISTINCT (passed, score, points_earned, evaluation_version, school_id, proctor_agent_id))::int AS distinct_verdicts
      FROM evaluation_results
      GROUP BY registration_id
      HAVING count(*) > 1
      ORDER BY rows DESC`,
  },
  {
    n: 2,
    title: "[1b] Cross-post replies",
    feeds: "M11-1b D1 detach, M11-1b D3 fixtures",
    sql: `
      SELECT c.id AS comment_id, c.post_id AS child_post, p.post_id AS parent_post
      FROM comments c
      JOIN comments p ON c.parent_id = p.id
      WHERE c.post_id IS DISTINCT FROM p.post_id`,
  },
  {
    n: 3,
    title: "Case-fold name collisions",
    feeds: "C5 unique lower(name) migration",
    blocking: true,
    acceptance: "must be empty before C5's migration; no safe automatic rule exists, so repair is manual",
    sql: `
      SELECT lower(name) AS folded, count(*)::int AS rows, array_agg(name ORDER BY created_at) AS names
      FROM agents
      GROUP BY lower(name)
      HAVING count(*) > 1`,
  },
  {
    n: 4,
    title: "[1b] Orphaned projections",
    feeds: "M11-1b D1 sweep",
    /**
     * Two corrections, both of which had this report under-counting silently.
     *
     * **The notification-subject predicate matched nothing at all.** It asked for `target ? 'post_id'`,
     * but a notification target is `{type, id}` (`store-types.ts:233`, written by
     * `notifications/db.ts:30`) — there has never been a `post_id` key. The row therefore reported 0
     * regardless of the data, which reads as "clean" rather than "not measured". A post id can also
     * arrive through `metadata`, so both places are checked.
     *
     * **A tombstone is an orphan for this purpose.** C25 made deletion a soft transition, so the
     * parent row still exists and a `NOT EXISTS` test passes — while the projection is exactly the
     * cleanup input M11-1b D1 needs to see. Absent *or* deleted is the condition, and `deleted_at`
     * is probed through `to_jsonb` so this query keeps working against a database where C25's
     * migration has not been applied yet.
     */
    sql: `
      WITH live_post AS (
        SELECT p.id, (to_jsonb(p) ->> 'deleted_at') IS NULL AS live FROM posts p
      )
      SELECT 'activity_events' AS projection, count(*)::int AS rows
      FROM activity_events e
      WHERE e.kind = 'post'
        AND NOT EXISTS (SELECT 1 FROM live_post p WHERE p.id = e.entity_id AND p.live)
      UNION ALL
      SELECT 'activity_events(comment)', count(*)::int
      FROM activity_events e
      WHERE e.kind = 'comment' AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.id = e.entity_id)
      UNION ALL
      SELECT 'activity_contexts', count(*)::int
      FROM activity_contexts ac
      WHERE NOT EXISTS (
        SELECT 1 FROM activity_events e WHERE e.kind = ac.activity_kind AND e.entity_id = ac.activity_id
      )
      UNION ALL
      SELECT 'groups.pinned_post_ids', count(*)::int
      FROM groups g, jsonb_array_elements_text(COALESCE(g.pinned_post_ids, '[]'::jsonb)) AS pinned(post_id)
      WHERE NOT EXISTS (SELECT 1 FROM live_post p WHERE p.id = pinned.post_id AND p.live)
      UNION ALL
      SELECT 'notifications(recipient)', count(*)::int
      FROM notifications n
      WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = n.agent_id)
      UNION ALL
      SELECT 'notifications(subject:target)', count(*)::int
      FROM notifications n
      WHERE n.target ->> 'type' = 'post'
        AND NOT EXISTS (SELECT 1 FROM live_post p WHERE p.id = n.target ->> 'id' AND p.live)
      UNION ALL
      SELECT 'notifications(subject:metadata)', count(*)::int
      FROM notifications n
      WHERE COALESCE(n.metadata, '{}'::jsonb) ? 'post_id'
        AND NOT EXISTS (SELECT 1 FROM live_post p WHERE p.id = n.metadata ->> 'post_id' AND p.live)`,
    /**
     * This report's rows are per-projection *aggregates*, so "N row(s)" would count the fixed number
     * of projections, not the work. It reported "6 row(s)" against a clean database. The summed
     * `rows` column is the number that means something.
     */
    summarise: (rows) => {
      const affected = rows.reduce((total, row) => total + Number(row.rows ?? 0), 0);
      return affected === 0 ? "empty" : `${affected} orphaned projection row(s)`;
    },
  },
  {
    n: 5,
    title: "Message-sequence collisions",
    feeds: "C2 unique (session_id, sequence) constraint",
    blocking: true,
    acceptance: "must be empty before the constraint applies; C2 owns the resequencing repair",
    sql: `
      SELECT session_id, sequence, count(*)::int AS rows
      FROM evaluation_messages
      GROUP BY session_id, sequence
      HAVING count(*) > 1
      ORDER BY rows DESC`,
  },
  {
    n: 6,
    title: "[1b] Terminal registration, no result",
    feeds: "M11-1b D4",
    sql: `
      SELECT r.id, r.agent_id, r.evaluation_id, r.status
      FROM evaluation_registrations r
      WHERE r.status IN ('completed', 'failed')
        AND NOT EXISTS (SELECT 1 FROM evaluation_results res WHERE res.registration_id = r.id)`,
  },
  {
    n: 7,
    title: "[1b] Result with non-terminal registration",
    feeds: "M11-1b D4",
    sql: `
      SELECT res.id AS result_id, r.id AS registration_id, r.status, res.passed
      FROM evaluation_results res
      JOIN evaluation_registrations r ON r.id = res.registration_id
      WHERE r.status IN ('registered', 'in_progress')`,
  },
  {
    n: 8,
    title: "[1b] Active proctor session, terminal registration",
    feeds: "M11-1b D4",
    sql: `
      SELECT s.id AS session_id, r.id AS registration_id, r.status
      FROM evaluation_sessions s
      JOIN evaluation_registrations r ON r.id = s.registration_id
      WHERE s.status = 'active' AND r.status IN ('completed', 'failed', 'cancelled')`,
  },
  {
    n: 9,
    title: "[1b] Terminal certification job, no result",
    feeds: "M11-1b D4",
    sql: `
      SELECT j.id AS job_id, j.registration_id, (j.judge_response IS NOT NULL) AS has_judge_response
      FROM certification_jobs j
      WHERE j.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM evaluation_results res WHERE res.registration_id = j.registration_id)`,
  },
  {
    n: 10,
    title: "Multiple live certification jobs per registration",
    feeds: "C22 partial unique index over live jobs",
    blocking: true,
    acceptance:
      "must be empty before the partial unique index applies; `pending` is in the predicate because that is the state `start` creates",
    sql: `
      SELECT registration_id, count(*)::int AS rows, array_agg(status) AS statuses
      FROM certification_jobs
      WHERE status IN ('pending', 'submitted', 'judging')
      GROUP BY registration_id
      HAVING count(*) > 1
      ORDER BY rows DESC`,
  },
  {
    n: 11,
    title: "[1b] Mis-scoped evaluation school",
    feeds: "M11-1b D4",
    // Parameterised at run time with the evaluation ids each school actually declares on disk.
    // Grouping registrations by their *stored* school answers a different question entirely and
    // reports every ordinary Foundation row as mis-scoped, which is worse than reporting nothing.
    dynamic: "misScopedEvaluationSchool",
  },
  {
    n: 13,
    title: "[1b] Pending-offer collisions and stale pending offers",
    feeds: "M11-1b D6 index migration",
    sql: `
      SELECT agent_id,
             count(*) FILTER (WHERE status = 'pending')::int AS pending_rows,
             count(*) FILTER (WHERE status = 'pending' AND expires_at < now())::int AS stale_pending
      FROM admissions_offers
      GROUP BY agent_id
      HAVING count(*) FILTER (WHERE status = 'pending') > 1
          OR count(*) FILTER (WHERE status = 'pending' AND expires_at < now()) > 0`,
  },
  {
    n: 14,
    title: "Multiple live playground sessions per school",
    feeds: "C23 partial unique index over live sessions",
    blocking: true,
    acceptance:
      "must be empty before the index applies; surplus sessions move to `cancelled` through C3's system-repair transition (never attributed to an agent)",
    sql: `
      SELECT COALESCE(school_id, 'foundation') AS school,
             count(*)::int AS live_rows,
             array_agg(id) AS session_ids
      FROM playground_sessions
      WHERE status IN ('pending', 'active')
      GROUP BY COALESCE(school_id, 'foundation')
      HAVING count(*) > 1`,
  },
];

/**
 * Report 12 is filesystem-derived, not a query: it looks for evaluation *definition* ids (the
 * front-matter `id:`, not the SIP label) declared by more than one school. A non-empty result is
 * expected — Foundation and Humanities both ship `twitter-verification` — and it is what makes
 * `evaluation_definitions.id` an unusable authorization input until M11-1b D4's composite key.
 */
function definitionIdentityCollisions() {
  const schoolsDir = path.join(REPO_ROOT, "schools");
  const byId = new Map();

  for (const school of fs.readdirSync(schoolsDir)) {
    if (school.startsWith("_")) continue;
    const evalDir = path.join(schoolsDir, school, "evaluations");
    if (!fs.existsSync(evalDir)) continue;
    for (const file of fs.readdirSync(evalDir)) {
      if (!file.endsWith(".md")) continue;
      const contents = fs.readFileSync(path.join(evalDir, file), "utf8");
      const match = contents.match(/^id:\s*(.+)$/m);
      if (!match) continue;
      const id = match[1].trim();
      if (!byId.has(id)) byId.set(id, new Set());
      byId.get(id).add(school);
    }
  }

  return [...byId.entries()]
    .filter(([, schools]) => schools.size > 1)
    .map(([id, schools]) => ({ evaluation_id: id, schools: [...schools].sort() }));
}

/**
 * Evaluation ids by school, read from the front matter of schools/<school>/evaluations/<file>.md.
 * The filesystem is the source of truth here — `evaluation_definitions.id` is a bare global
 * primary key, so the table holds whichever school synced last.
 */
function evaluationIdsBySchool() {
  const schoolsDir = path.join(REPO_ROOT, "schools");
  const bySchool = new Map();
  for (const school of fs.readdirSync(schoolsDir)) {
    if (school.startsWith("_")) continue;
    const evalDir = path.join(schoolsDir, school, "evaluations");
    if (!fs.existsSync(evalDir)) continue;
    const ids = [];
    for (const file of fs.readdirSync(evalDir)) {
      if (!file.endsWith(".md")) continue;
      const match = fs.readFileSync(path.join(evalDir, file), "utf8").match(/^id:\s*(.+)$/m);
      if (match) ids.push(match[1].trim());
    }
    bySchool.set(school, ids);
  }
  return bySchool;
}

/**
 * Registrations reading as Foundation whose evaluation id is *not* declared by Foundation.
 *
 * `evaluation_registrations.school_id` defaults to 'foundation' and `registerForEvaluation` never
 * wrote it, so a row reading Foundation is either genuinely Foundation or unknown. The recoverable
 * subset is the one whose evaluation id Foundation does not define at all.
 */
async function misScopedEvaluationSchool(client) {
  const bySchool = evaluationIdsBySchool();
  const foundationIds = bySchool.get("foundation") ?? [];
  const { rows } = await client.query(
    `SELECT COALESCE(school_id, 'foundation') AS stored_school, evaluation_id, count(*)::int AS rows
     FROM evaluation_registrations
     WHERE COALESCE(school_id, 'foundation') = 'foundation'
       AND NOT (evaluation_id = ANY($1::text[]))
     GROUP BY 1, 2
     ORDER BY rows DESC`,
    [foundationIds]
  );
  return rows.map((row) => ({
    ...row,
    declared_by: [...bySchool.entries()]
      .filter(([, ids]) => ids.includes(row.evaluation_id))
      .map(([school]) => school)
      .join(", ") || "no school on disk",
  }));
}

/** `KEY=value` from one .env line, or null for a blank, a comment, or anything malformed. */
function parseEnvLine(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;
  const match = line.match(/^([^=]+)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  return { key: match[1].trim(), value: quoted ? value.slice(1, -1) : value };
}

function loadEnvLocalIfNeeded() {
  if (process.env.POSTGRES_URL || process.env.DATABASE_URL) return;
  const envPath = path.join(REPO_ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split("\n")) {
    const entry = parseEnvLine(rawLine);
    if (entry && !process.env[entry.key]) process.env[entry.key] = entry.value;
  }
}

function renderRows(rows) {
  if (rows.length === 0) return "_empty_\n";
  const columns = Object.keys(rows[0]);
  const head = `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n`;
  const body = rows
    .slice(0, 50)
    .map((row) => `| ${columns.map((c) => JSON.stringify(row[c])).join(" | ")} |`)
    .join("\n");
  const truncated = rows.length > 50 ? `\n\n_(${rows.length - 50} further rows omitted)_` : "";
  return `${head}${body}${truncated}\n`;
}

/**
 * How a report's result reads in the summary.
 *
 * Extracted from `main` so the branch lives where it can be read: a report whose rows are
 * per-bucket aggregates counts *affected rows*, not buckets, and supplies its own summariser.
 */
function reportStatus(report, rows, error) {
  if (error) return "ERROR";
  if (report.summarise) return report.summarise(rows);
  return rows.length === 0 ? "empty" : `${rows.length} row(s)`;
}

/**
 * Replace a Neon endpoint id with a placeholder, keeping the rest of the hostname.
 *
 * `ep-polished-queen-abcd1234-pooler.eu-west-2.aws.neon.tech` → `ep-<masked>.eu-west-2.aws.neon.tech`.
 * A hostname that carries no endpoint id is returned unchanged.
 */
function maskEndpoint(hostname) {
  return hostname.replace(/^ep-[^.]+/, "ep-<masked>");
}

async function main() {
  loadEnvLocalIfNeeded();
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

  const sections = [];
  const summary = [];

  if (!connectionString) {
    sections.push("> **No database configured** — preflights remain the guard. Re-run this report against the target before any migration applies.\n");
  } else {
    const client = new Client({ connectionString });
    await client.connect();
    const { rows: whoami } = await client.query(
      "SELECT current_database() AS db, inet_server_addr()::text AS host, version() AS version"
    );
    // The report is committed to a PUBLIC repository, so the endpoint id is masked: it identifies
    // production infrastructure and nothing in the report needs it. Enough of the hostname survives
    // to tell one environment from another (region and provider), which is all a reader needs.
    sections.push(
      `Target: \`${maskEndpoint(new URL(connectionString).hostname)}/${whoami[0].db}\` — ${whoami[0].version.split(" on ")[0]}\n`
    );

    for (const report of REPORTS) {
      let rows;
      let error = null;
      try {
        rows = report.dynamic === "misScopedEvaluationSchool"
          ? await misScopedEvaluationSchool(client)
          : (await client.query(report.sql)).rows;
      } catch (err) {
        rows = [];
        error = `${err.code}: ${err.message}`;
      }
      const status = reportStatus(report, rows, error);
      summary.push({ report, status, error });
      sections.push(
        `### ${report.n}. ${report.title}\n\n` +
          `- Feeds: ${report.feeds}\n` +
          (report.acceptance ? `- Acceptance: ${report.acceptance}\n` : "") +
          `- Result: **${status}**\n\n` +
          (error ? `\`\`\`\n${error}\n\`\`\`\n` : renderRows(rows))
      );
    }
    await client.end();
  }

  const collisions = definitionIdentityCollisions();
  sections.push(
    `### 12. [1b] Definition-identity collisions\n\n` +
      `- Feeds: M11-1b D4 composite key; C2 fail-closed list\n` +
      `- Acceptance: non-empty is expected (SIP-4); until D4 lands, C2 rejects legacy registrations naming a listed id\n` +
      `- Result: **${collisions.length === 0 ? "empty" : `${collisions.length} id(s)`}**\n\n` +
      renderRows(collisions.map((c) => ({ evaluation_id: c.evaluation_id, schools: c.schools.join(", ") })))
  );

  const blockingSummary = summary
    .filter((s) => s.report.blocking)
    .map((s) => `| ${s.report.n} | ${s.report.title} | ${s.status} |`)
    .join("\n");

  const header =
    `# M11-1 / M11-1b baseline reports\n\n` +
    `Generated by \`node scripts/m11-1-baseline.js\`. This is the complete report list for both\n` +
    `milestones (PLAN_M11_1.md C0.4); no later chunk may add to it implicitly.\n\n` +
    `## M11-1 blocking reports (release gate 4)\n\n` +
    `| # | Report | Status |\n| --- | --- | --- |\n${blockingSummary}\n\n` +
    `## All reports\n\n`;

  const document = header + sections.join("\n");

  const failed = summary.filter((entry) => entry.error);

  if (process.argv.includes("--stdout")) {
    console.log(document);
  } else {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, document);
    console.log(`[baseline] wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
    for (const s of summary.filter((x) => x.report.blocking)) {
      console.log(`[baseline] report ${s.report.n}: ${s.status}`);
    }
  }

  // A report that could not run is not a passing report. Release gate 4 reads this output to
  // decide whether a migration may apply, so an ERROR row that exits 0 would let an index land
  // against data nobody actually checked.
  if (failed.length > 0) {
    console.error(
      `[baseline] FAILED: ${failed.length} report(s) errored — ${failed.map((f) => f.report.n).join(", ")}`
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
