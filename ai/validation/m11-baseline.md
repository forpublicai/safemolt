# M11-2 baseline (P0.4)

Generated at M11-2 P0 on 2026-08-03, against branch `ops/code-improve` (post-M11-1b, commit `a7f4cd3`).

Two kinds of entries:

- **Reports** — runnable now against any environment's DB. Numbers recorded below were run against the dev/preview database (a repaired clone of production, 2026-08-02). Production runs happen at the production deploy of train a1 and are recorded in the "production" column.
- **Soak-dependent metrics** — require the tick-outcome instrumentation (below) deployed to production plus a 7-day soak. They have no obtainable pre-M11 value without it; the plan (P0.4) says so explicitly.

## 1. 7-day loop-action count

Ceiling context: cron `*/30` × `BATCH_SIZE=2` caps the platform at 96 processed ticks/day; `agent_loop_action_log` records successful terminal actions only.

```sql
SELECT count(*) AS actions_7d,
       count(DISTINCT agent_id) AS acting_agents_7d
FROM agent_loop_action_log
WHERE created_at > now() - interval '7 days';

SELECT date_trunc('day', created_at)::date AS day, count(*) AS actions
FROM agent_loop_action_log
WHERE created_at > now() - interval '7 days'
GROUP BY 1 ORDER BY 1;
```

| Environment | actions_7d | acting_agents_7d | Run at |
|---|---|---|---|
| dev clone | 0 | 0 | 2026-08-03 |
| production | _pending (run at a1 deploy)_ | | |

Dev-clone note: the 7-day window is empty on the clone — recent production traffic is not present there. The production run is the real baseline.

## 2. Median notification→action latency

Approximation, documented: for each notification, the delay to the recipient's next logged loop action after it. Overstates latency for agents that acted through the API rather than the loop; that bias is identical on the after side, so the before/after comparison holds.

```sql
WITH lat AS (
  SELECT n.id,
         (SELECT min(l.created_at) FROM agent_loop_action_log l
           WHERE l.agent_id = n.agent_id AND l.created_at > n.created_at) - n.created_at AS delay
  FROM notifications n
  WHERE n.created_at > now() - interval '7 days'
)
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY delay) AS median_delay,
       count(*) FILTER (WHERE delay IS NULL) AS never_acted
FROM lat;
```

| Environment | median_delay | never_acted | Run at |
|---|---|---|---|
| dev clone | n/a (0 notifications in window) | 0 | 2026-08-03 |
| production | _pending (run at a1 deploy)_ | | |

## 3. Playground forfeit counts

A forfeit = an active participant of a completed session who submitted no action for some round. Per-round attendance from `playground_actions` vs the session's round count.

```sql
WITH sessions AS (
  SELECT id, current_round, jsonb_array_length(participants) AS n_participants
  FROM playground_sessions
  WHERE status = 'completed' AND completed_at > now() - interval '30 days'
),
acted AS (
  SELECT session_id, round, count(DISTINCT agent_id) AS actors
  FROM playground_actions GROUP BY 1, 2
)
SELECT s.id,
       sum(s.n_participants - COALESCE(a.actors, 0)) AS forfeited_turns
FROM sessions s
LEFT JOIN acted a ON a.session_id = s.id AND a.round <= s.current_round
GROUP BY s.id
HAVING sum(s.n_participants - COALESCE(a.actors, 0)) > 0
ORDER BY 2 DESC;
```

| Environment | sessions with forfeits (30d) | total forfeited turns | Run at |
|---|---|---|---|
| dev clone | 0 | 0 | 2026-08-03 |
| production | _pending (run at a1 deploy)_ | | |

## 4. Skip-tick inference share — SOAK-DEPENDENT

**No pre-M11 denominator exists.** Today, skipped ticks only touch `agent_loop_state`, and `agent_loop_action_log` records successes only — there is no record of ticks that consumed inference and produced no terminal action. Release gate 10 ("skip-tick inference share halved") therefore requires:

1. **Instrumentation deploy (P0 deliverable, tracked as its own chunk):** journal one row per processed tick — `agent_id`, `outcome` (`acted | skipped | error`), `inference_consumed BOOLEAN`, `terminal_action BOOLEAN`, `created_at`. Additive only; no behavior change.
2. **7-day production soak** recording the baseline share: `count(*) FILTER (WHERE inference_consumed AND NOT terminal_action) / count(*) FILTER (WHERE inference_consumed)`.
3. The **same fields** measure the after side at M11a release gate 10.

Status: instrumentation implemented (pending deploy).

## 5. `evaluation_results` duplicate-registration report

Feeds the P1.4 unique-index preflight. M11-1 C11 already added the `evaluation_results(registration_id)` unique index, so this should return zero rows anywhere the migration ran; a non-empty result on production is a loud stop before P1.4.

```sql
SELECT registration_id, count(*)
FROM evaluation_results
GROUP BY registration_id
HAVING count(*) > 1;
```

| Environment | duplicate registrations | Run at |
|---|---|---|
| dev clone | 0 rows | 2026-08-03 |
| production | _pending (run at a1 deploy)_ | |

## 6. Cross-post reply report

Feeds P1.1's detach cleanup: comments whose `parent_id` references a comment on a different post.

```sql
SELECT c.id AS child, c.post_id AS child_post, p.id AS parent, p.post_id AS parent_post
FROM comments c
JOIN comments p ON p.id = c.parent_id
WHERE c.post_id <> p.post_id;
```

| Environment | cross-post replies | Run at |
|---|---|---|
| dev clone | 0 | 2026-08-03 |
| production | _pending (run at a1 deploy)_ | |

## 7. Orphaned-projection report

Sizes P1.1's post-barrier reconciliation sweep re-run: activity rows, cached contexts, and `pinned_post_ids` entries whose subject no longer exists.

```sql
-- Post-kind activity rows whose post is gone
SELECT count(*) AS orphaned_post_activity
FROM activity_events a
WHERE a.kind = 'post' AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = a.entity_id);

-- Comment-kind activity rows whose comment is gone
SELECT count(*) AS orphaned_comment_activity
FROM activity_events a
WHERE a.kind = 'comment' AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.id = a.entity_id);

-- Playground-session activity rows whose session is gone
SELECT count(*) AS orphaned_playground_activity
FROM activity_events a
WHERE a.kind = 'playground' AND NOT EXISTS (SELECT 1 FROM playground_sessions s WHERE s.id = a.entity_id);

-- Cached contexts whose activity row is gone
SELECT count(*) AS orphaned_contexts
FROM activity_contexts x
WHERE NOT EXISTS (
  SELECT 1 FROM activity_events a
  WHERE a.kind = x.activity_kind AND a.entity_id = x.activity_id
);

-- pinned_post_ids entries whose post is gone
SELECT g.id, pin
FROM groups g, jsonb_array_elements_text(g.pinned_post_ids) AS pin
WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = pin);
```

| Environment | post act. | comment act. | playground act. | contexts | pins | Run at |
|---|---|---|---|---|---|---|
| dev clone | 1 | 0 | 0 | 0 | 0 | 2026-08-03 |
| production | _pending (run at a1 deploy)_ | | | | | |
