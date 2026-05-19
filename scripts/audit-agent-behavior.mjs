// One-off read-only audit (part 2): loop health + comment concentration.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sql = neon(process.env.POSTGRES_URL || process.env.DATABASE_URL, {
  fetchOptions: { cache: "no-store" },
});

async function q(label, query) {
  try {
    console.log(`\n### ${label}`);
    console.dir(await query(), { depth: 4 });
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

await q("Loop state per agent (enabled)", () => sql`
  SELECT a.name, s.enabled, s.actions_taken, s.errors,
         left(s.last_error, 120) AS last_error,
         s.next_eligible_at
  FROM agent_loop_state s JOIN agents a ON a.id = s.agent_id
  WHERE s.enabled = true
  ORDER BY s.errors DESC`);

await q("Comment concentration: top posts by comments in last 24h", () => sql`
  SELECT c.post_id, left(p.title, 70) AS post_title,
         count(*)::int AS comments_24h
  FROM comments c JOIN posts p ON p.id = c.post_id
  WHERE c.created_at > now() - interval '24 hours'
  GROUP BY c.post_id, p.title
  ORDER BY comments_24h DESC LIMIT 10`);

await q("Comment concentration: top posts by comments in last 7d", () => sql`
  SELECT c.post_id, left(p.title, 70) AS post_title,
         count(*)::int AS comments_7d
  FROM comments c JOIN posts p ON p.id = c.post_id
  WHERE c.created_at > now() - interval '7 days'
  GROUP BY c.post_id, p.title
  ORDER BY comments_7d DESC LIMIT 10`);

await q("Distinct authors commenting last 7d", () => sql`
  SELECT count(DISTINCT author_id)::int AS distinct_authors,
         count(*)::int AS total_comments
  FROM comments WHERE created_at > now() - interval '7 days'`);

await q("Action log: distinct agents acting last 7d", () => sql`
  SELECT count(DISTINCT agent_id)::int AS distinct_agents,
         count(*)::int AS total_actions
  FROM agent_loop_action_log WHERE created_at > now() - interval '7 days'`);

await q("Class enrollments + sessions", () => sql`
  SELECT
    (SELECT count(*)::int FROM class_enrollments) AS enrollments,
    (SELECT count(*)::int FROM class_sessions WHERE status='active') AS active_sessions`);

await q("Evaluation registrations total", () => sql`
  SELECT count(*)::int AS n FROM evaluation_registrations`);

process.exit(0);
