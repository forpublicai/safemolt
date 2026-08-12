-- M11-2 u4-prep — shadow-soak report: is the shadow comparison clean enough to flip?
--
-- Pure SQL, read-only, psql-runnable against production. Rationale and review history live in
-- `ai/validation/m11-inventory.md` Sec.8 ("Soak report").
--
-- **THE COMPARISON IS NOT MADE HERE.** It is made at DRAIN TIME by the consumer dispatcher
-- (`src/lib/events/consumers/dispatch.ts` + `legacy-compare.ts`) and stamped on the shadow row:
-- `legacy_match` is
-- `matched | legacy_missing | payload_mismatch | superseded | unverifiable | compare_error`, with the
-- differing paths in `legacy_detail`. That is where the event, the intended payload and a
-- freshly-committed legacy twin are all in hand. This script AGGREGATES stamps; it never
-- reconstructs an expected key from live state. It owns only the arms no drain can stamp: a keyed
-- legacy row with no shadow twin (`legacy_only`) and the malformed-row buckets on both sides.
--
-- PRECONDITIONS: `migrate-m11-events.sql`, `migrate-m11-consumers.sql`, `migrate-m11-shadow-compare.sql`.
--
-- OUTPUT (one result set, ordered by section/consumer/kind/effect_key): `summary` — one row per
-- (consumer, kind) in `expected_pairs`, ALWAYS present, `note` carrying that pair's verdict, plus
-- two `(any)` rows totalling the malformed shadow and legacy rows; then the keys behind every
-- ANOMALY count — `payload_mismatch`, `legacy_missing`, `compare_error`, `not_stamped`,
-- `legacy_only_key`, `invalid_legacy_row`, `invalid_shadow_row`. `matched`, `superseded` and
-- `unverifiable` have no detail rows: none of them names anything to go and look at.
--
-- VERDICT RULE: a `compare`-family row is soak-clean when `matched > 0` AND `payload_mismatch =
-- legacy_missing = compare_error = not_stamped = legacy_only = uncorrelatable = 0`. The soak is
-- clean only when EVERY `compare` row meets that bar AND both `(any)` rows are zero. `superseded` is
-- NOT in that list and is not an anomaly — see below. Nothing else here is a tolerated residual:
--   * `legacy_missing` is stamped only when `describe` produced an effect, the twin read re-locked
--     the same subject and found it alive, and no NEWER event owns the row — so the stamp means the
--     legacy writer's row was absent for this event anyway. An anomaly, not a create-then-delete.
--   * `superseded` means the legacy row at a reusable key (`follow`, `group_join`, the six playground
--     lifecycle kinds sharing `playground_session:{id}`) carries a LATER event's `source_event_id`.
--     Routine, correct behavior on both sides: the inline upsert replaces the row on every write, so
--     an event drained after the next write can only see the newer one, and the durable evidence
--     that the two writers agreed is the monotonic watermark itself. Every inline write is
--     statement-atomic with its event, so superseded is safe: it can only mean a later event rewrote
--     the reusable key. It is counted and shown, never
--     added to `anomalies`, and it is not `comparable` either — a window that produced ONLY
--     superseded rows for a pair reads `no_data`, because nothing in it diffed a payload.
--   * `not_stamped` (NULL) means a pre-amendment build drained that event inside the window. Extend
--     the soak past that deploy; those rows can never be classified retroactively.
--   * `uncorrelatable` (a legacy row with NULL `dedup_key`/`source_event_id`) is a stamping
--     regression in-window: the transitional inline writers key every row they write. Pre-barrier
--     rollout residuals are excluded by the window itself.
-- `ingest` rows stamp `unverifiable` (the legacy effect lives in an external vector provider with no
-- Postgres table) and are EXCLUDED from the verdict; closing that needs a provider-backed export, a
-- named backlog item. `deletion` rows are key-only — gone on both sides before the event drains — so
-- they stamp `unverifiable` too and gate on the both-orders convergence tests
-- (`m11-2-u2-legacy-parity.test.ts`), not on this report.
--
-- COVERAGE: `expected_pairs` is a static copy of the three consumers' `shadow` manifest entries,
-- cross-checked against the real manifests by `m11-2-u4prep-soak-report.test.ts`. A newly-shadowed
-- kind needs a row here (and in `kind_map`/`notif_type_map` if its legacy side is keyable) before it
-- appears; a well-formed shadow row naming a pair absent from `expected_pairs` lands in
-- `invalid_shadow` rather than vanishing through every downstream filter.
--
-- u3e (P1.4, evaluations + agent lifecycle) added TEN kinds and **no rows here**, which is a state
-- rather than an omission: nine are history-only on every consumer, and `evaluation.completed`
-- ships `legacy` on activity-trail because both of its inline trail writers are structurally unable
-- to stamp `source_event_id` (one is a batch element of the D4 completion transaction, the other
-- runs after `completeVetting`'s batch commits), so there is nothing to order a comparison by. When
-- that kind flips to `shadow` it needs a `('activity-trail', 'evaluation.completed', 'compare')`
-- pair here AND an `('evaluation.completed', 'evaluation_result')` entry in `kind_map` — its legacy
-- side IS keyable (`activity_events.kind = 'evaluation_result'`, subject = the result id).

-- ==================== Operator-parameterized soak window ====================
-- Default: 3 days back. Override with a TIMESTAMP LITERAL, never a SQL expression:
--   psql -v soak_start=2026-07-01T00:00:00Z -f scripts/soak-shadow-report.sql
-- `:'soak_start'` interpolates as a quoted literal, so the value is data and can never be executed;
-- the default lives in the `params` CTE below rather than in the psql variable.
\if :{?soak_start}
\else
\set soak_start ''
\endif

WITH
params AS (
  -- `NULLIF` before the cast, never a `CASE` around it: Postgres constant-folds a literal cast at
  -- PLAN time, so `CASE WHEN … ELSE ''::timestamptz END` raises 22007 on the default branch even
  -- though that branch is never taken. `NULLIF('', '')` casts a NULL instead, which is legal.
  SELECT COALESCE(NULLIF(:'soak_start', '')::timestamptz, now() - interval '3 days') AS soak_start
),
expected_pairs(consumer, event_kind, family) AS (
  -- 'compare' = a stamped payload diff is expected, 'deletion' = key-only, 'ingest' = volume-only.
  VALUES
    ('activity-trail', 'post.created', 'compare'),
    ('activity-trail', 'comment.created', 'compare'),
    ('activity-trail', 'agent.followed', 'compare'),
    ('activity-trail', 'group.joined', 'compare'),
    -- u3d (P1.4): the playground family. Six kinds share ONE projection — the session's trail row,
    -- which the legacy writer rebuilds from the live session whatever moved it — and the seventh
    -- keys on the action row. All seven are 'compare' rather than 'deletion': since M11-1 C3 neither
    -- cancellation nor expiry deletes anything, both transition the session to `cancelled` and the
    -- upsert's title and `metadata.status` carry that word.
    ('activity-trail', 'playground.session_created', 'compare'),
    ('activity-trail', 'playground.session_joined', 'compare'),
    ('activity-trail', 'playground.participant_affiliation_updated', 'compare'),
    ('activity-trail', 'playground.action_submitted', 'compare'),
    ('activity-trail', 'playground.session_completed', 'compare'),
    ('activity-trail', 'playground.session_cancelled', 'compare'),
    ('activity-trail', 'playground.session_expired', 'compare'),
    ('activity-trail', 'post.deleted', 'deletion'),
    ('notifications', 'comment.created', 'compare'),
    ('notifications', 'agent.followed', 'compare'),
    ('notifications', 'post.deleted', 'deletion'),
    ('memory-ingest', 'post.created', 'ingest'),
    ('memory-ingest', 'comment.created', 'ingest'),
    ('memory-ingest', 'post.deleted', 'ingest')
),
kind_map(event_kind, activity_kind) AS (
  VALUES ('post.created', 'post'), ('comment.created', 'comment'), ('agent.followed', 'follow'),
         ('group.joined', 'group_join'),
         -- Six-to-one on purpose: every session-lifecycle kind writes the SAME `playground_session`
         -- row, so the legacy side is keyable for all of them by the same activity kind.
         ('playground.session_created', 'playground_session'),
         ('playground.session_joined', 'playground_session'),
         ('playground.participant_affiliation_updated', 'playground_session'),
         ('playground.session_completed', 'playground_session'),
         ('playground.session_cancelled', 'playground_session'),
         ('playground.session_expired', 'playground_session'),
         ('playground.action_submitted', 'playground_action')
),
notif_type_map(notif_type, event_kind) AS (
  VALUES ('comment_on_my_post', 'comment.created'), ('reply_to_my_comment', 'comment.created'),
         ('new_follower', 'agent.followed')
),
-- The stamp vocabulary, kept identical to `LEGACY_MATCH_VALUES` in
-- `src/lib/events/consumers/legacy-compare.ts` by `m11-2-u4prep-soak-report.test.ts`: a value this
-- list does not know lands in `invalid_shadow` as `unknown_stamp:<value>`, so a newer build's
-- vocabulary is loud rather than silently absorbed into a clean total.
stamp_vocabulary(value) AS (
  VALUES ('matched'), ('legacy_missing'), ('payload_mismatch'), ('superseded'), ('unverifiable'),
         ('compare_error')
),

-- Every WELL-FORMED, EXPECTED shadow row in the window, windowed by the PRODUCING EVENT's clock —
-- never the row's own `created_at`, which is drain time and can straddle the window on one side.
shadow_rows AS (
  SELECT s.consumer, s.event_id, s.effect_key, s.legacy_match, s.legacy_detail, e.kind AS event_kind
  FROM event_consumer_shadow s
  JOIN events e ON e.id = s.event_id
  JOIN expected_pairs ep ON ep.consumer = s.consumer AND ep.event_kind = e.kind
  CROSS JOIN params
  WHERE e.created_at >= params.soak_start
    AND s.consumer IS NOT NULL AND s.effect_key IS NOT NULL AND s.payload IS NOT NULL
    -- An unrecognized stamp (a newer build's vocabulary) is NOT counted here; `invalid_shadow`
    -- claims it, so it can never be silently absorbed into a clean total.
    AND (s.legacy_match IS NULL OR s.legacy_match IN (SELECT value FROM stamp_vocabulary))
),
stamp_agg AS (
  SELECT consumer, event_kind,
    count(*) AS shadow_total,
    count(*) FILTER (WHERE legacy_match = 'matched') AS matched,
    count(*) FILTER (WHERE legacy_match = 'payload_mismatch') AS payload_mismatch,
    count(*) FILTER (WHERE legacy_match = 'legacy_missing') AS legacy_missing,
    count(*) FILTER (WHERE legacy_match = 'compare_error') AS compare_error,
    count(*) FILTER (WHERE legacy_match = 'superseded') AS superseded,
    count(*) FILTER (WHERE legacy_match = 'unverifiable') AS unverifiable,
    count(*) FILTER (WHERE legacy_match IS NULL) AS not_stamped
  FROM shadow_rows GROUP BY consumer, event_kind
),

-- Malformed or unexpected SHADOW rows, tagged with WHY. Windowed by the producing event's clock
-- whenever one resolves; the row's own clock is the fallback only when there is no event to anchor.
invalid_shadow AS (
  SELECT s.id, s.consumer, s.event_id, s.effect_key, 'null_field' AS reason
  FROM event_consumer_shadow s LEFT JOIN events e ON e.id = s.event_id CROSS JOIN params
  WHERE (s.consumer IS NULL OR s.event_id IS NULL OR s.effect_key IS NULL OR s.payload IS NULL)
    AND COALESCE(e.created_at, s.created_at) >= params.soak_start
  UNION ALL
  SELECT s.id, s.consumer, s.event_id, s.effect_key, 'orphan_event_id'
  FROM event_consumer_shadow s CROSS JOIN params
  WHERE s.consumer IS NOT NULL AND s.event_id IS NOT NULL AND s.effect_key IS NOT NULL AND s.payload IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = s.event_id)
    AND s.created_at >= params.soak_start
  UNION ALL
  SELECT s.id, s.consumer, s.event_id, s.effect_key, 'unexpected_pair:' || s.consumer || ':' || e.kind
  FROM event_consumer_shadow s JOIN events e ON e.id = s.event_id CROSS JOIN params
  WHERE s.consumer IS NOT NULL AND s.effect_key IS NOT NULL AND s.payload IS NOT NULL
    AND e.created_at >= params.soak_start
    AND NOT EXISTS (SELECT 1 FROM expected_pairs ep WHERE ep.consumer = s.consumer AND ep.event_kind = e.kind)
  UNION ALL
  SELECT s.id, s.consumer, s.event_id, s.effect_key, 'unknown_stamp:' || s.legacy_match
  FROM event_consumer_shadow s JOIN events e ON e.id = s.event_id
  JOIN expected_pairs ep ON ep.consumer = s.consumer AND ep.event_kind = e.kind
  CROSS JOIN params
  WHERE s.effect_key IS NOT NULL AND s.payload IS NOT NULL AND e.created_at >= params.soak_start
    AND s.legacy_match IS NOT NULL AND s.legacy_match NOT IN (SELECT value FROM stamp_vocabulary)
),

-- ---- The legacy side: only what a drain cannot stamp ----
-- **The event-id suffix parse is GUARDED.** `dedup_key` is `{type}:{recipient}:{event_id}` in plain
-- TEXT written by two writers, and an unguarded `::bigint` cast raises 22P02 and takes the WHOLE
-- report down over one malformed row. A `CASE` on `~ '^[0-9]+$'` yields NULL instead, the LEFT JOIN
-- keeps the row, and it lands in `invalid_legacy`, where it is verdict-bearing.
notif_legacy AS (
  SELECT n.dedup_key AS effect_key, tm.event_kind, n.created_at AS row_created_at,
    CASE WHEN reverse(split_part(reverse(n.dedup_key), ':', 1)) ~ '^[0-9]+$'
         THEN reverse(split_part(reverse(n.dedup_key), ':', 1))::bigint END AS suffix_event_id
  FROM notifications n JOIN notif_type_map tm ON tm.notif_type = n.type
  WHERE n.dedup_key IS NOT NULL
),
notif_legacy_events AS (
  SELECT l.*, e.id AS event_id, e.created_at AS event_created_at
  FROM notif_legacy l LEFT JOIN events e ON e.id = l.suffix_event_id
),
-- **ONE ROW PER LEGACY ROW, never one per mapped kind.** `kind_map` is six-to-one for the playground
-- family, so joining it here fanned a single `playground_session` row out to six kinds and let one
-- missing shadow twin increment `legacy_only` on all six — turning five `no_data` pairs into
-- anomalies over one row. The row's own activity kind is carried instead, and the EVENT's actual kind
-- is resolved beside it; `legacy_only_keys` joins `kind_map` afterwards, on the pair, which is what
-- collapses the fan-out to the one kind that actually produced the row.
act_legacy AS (
  SELECT (a.kind || ':' || a.entity_id) AS effect_key, a.kind AS activity_kind, a.source_event_id,
    a.occurred_at AS row_occurred_at
  FROM activity_events a
  WHERE a.source_event_id IS NOT NULL
    AND a.kind IN (SELECT activity_kind FROM kind_map)
),
act_legacy_events AS (
  SELECT l.*, e.id AS event_id, e.kind AS event_kind, e.created_at AS event_created_at
  FROM act_legacy l LEFT JOIN events e ON e.id = l.source_event_id
),
legacy_only_keys AS (
  SELECT 'notifications'::text AS consumer, l.event_kind, l.effect_key
  FROM notif_legacy_events l CROSS JOIN params
  WHERE l.event_id IS NOT NULL AND l.event_created_at >= params.soak_start
    AND NOT EXISTS (
      SELECT 1 FROM shadow_rows s
      WHERE s.consumer = 'notifications' AND s.effect_key = l.effect_key
    )
  UNION ALL
  -- The shadow twin must name the SAME source event: every activity natural key is reusable in
  -- place (re-follow, leave-then-rejoin), so a shadow row from an earlier write is not this row's.
  --
  -- The `kind_map` join is on the PAIR — the event's own kind and the row's activity kind — so a
  -- `playground_session` row is attributed to the one lifecycle kind whose event actually wrote it,
  -- and a `source_event_id` naming an event of an unrelated kind matches nothing here rather than
  -- being counted against a kind that never touched the row.
  SELECT 'activity-trail'::text, l.event_kind, l.effect_key
  FROM act_legacy_events l
  JOIN kind_map km ON km.event_kind = l.event_kind AND km.activity_kind = l.activity_kind
  CROSS JOIN params
  WHERE l.event_id IS NOT NULL AND l.event_created_at >= params.soak_start
    AND NOT EXISTS (
      SELECT 1 FROM shadow_rows s
      WHERE s.consumer = 'activity-trail' AND s.effect_key = l.effect_key
        AND s.event_id = l.source_event_id
    )
),
invalid_legacy AS (
  SELECT 'notifications'::text AS consumer, l.event_kind, l.effect_key,
    CASE WHEN l.suffix_event_id IS NULL THEN 'unparseable_event_id_suffix'
         ELSE 'dedup_key names no event' END AS reason
  FROM notif_legacy_events l CROSS JOIN params
  WHERE l.event_id IS NULL AND l.row_created_at >= params.soak_start
  UNION ALL
  -- No event resolved, so there is no event KIND to report — NULL rather than the mapped kind, which
  -- for a `playground_session` row would have been six guesses at a kind nothing can name.
  SELECT 'activity-trail'::text, NULL::text, l.effect_key, 'source_event_id names no event'
  FROM act_legacy_events l CROSS JOIN params
  WHERE l.event_id IS NULL AND l.row_occurred_at >= params.soak_start
),
-- A legacy row with NO key at all. `occurred_at`, not `created_at`, on the activity side: the upsert
-- refreshes the former on every write and never touches the latter.
--
-- The activity arm still fans out through `kind_map`, and deliberately: a row with no
-- `source_event_id` names no event and therefore no kind, so there is nothing to attribute it to.
-- Every mapped kind is charged, which blocks the flip for all of them — the safe direction, and the
-- reason this is not the `legacy_only` fan-out the same map used to cause.
uncorrelatable_agg AS (
  SELECT 'notifications'::text AS consumer, tm.event_kind, count(*) AS uncorrelatable
  FROM notifications n JOIN notif_type_map tm ON tm.notif_type = n.type CROSS JOIN params
  WHERE n.dedup_key IS NULL AND n.created_at >= params.soak_start
  GROUP BY tm.event_kind
  UNION ALL
  SELECT 'activity-trail', km.event_kind, count(*)
  FROM activity_events a JOIN kind_map km ON km.activity_kind = a.kind CROSS JOIN params
  WHERE a.source_event_id IS NULL AND a.occurred_at >= params.soak_start
  GROUP BY km.event_kind
),
legacy_only_agg AS (
  SELECT consumer, event_kind, count(*) AS legacy_only FROM legacy_only_keys GROUP BY consumer, event_kind
),

-- ==================== The pair matrix: ALWAYS one row per expected pair ====================
pair_summary AS (
  SELECT ep.consumer, ep.event_kind, ep.family,
    COALESCE(sa.shadow_total, 0) AS shadow_total,
    COALESCE(sa.matched, 0) AS matched,
    COALESCE(sa.payload_mismatch, 0) AS payload_mismatch,
    COALESCE(sa.legacy_missing, 0) AS legacy_missing,
    COALESCE(sa.compare_error, 0) AS compare_error,
    COALESCE(sa.superseded, 0) AS superseded,
    COALESCE(sa.unverifiable, 0) AS unverifiable,
    COALESCE(sa.not_stamped, 0) AS not_stamped,
    COALESCE(lo.legacy_only, 0) AS legacy_only,
    COALESCE(ua.uncorrelatable, 0) AS uncorrelatable
  FROM expected_pairs ep
  LEFT JOIN stamp_agg sa ON sa.consumer = ep.consumer AND sa.event_kind = ep.event_kind
  LEFT JOIN legacy_only_agg lo ON lo.consumer = ep.consumer AND lo.event_kind = ep.event_kind
  LEFT JOIN uncorrelatable_agg ua ON ua.consumer = ep.consumer AND ua.event_kind = ep.event_kind
),
pair_verdict AS (
  -- `superseded` is in NEITHER total, and that is the whole point of the stamp: it is not an
  -- anomaly (both writers behaved correctly), and it is not a comparison either (no payload was
  -- diffed), so it can neither fail a pair nor make an uncompared window look clean.
  SELECT p.*, (p.matched + p.payload_mismatch + p.legacy_missing + p.compare_error) AS comparable,
    (p.payload_mismatch + p.legacy_missing + p.compare_error + p.not_stamped
       + p.legacy_only + p.uncorrelatable) AS anomalies
  FROM pair_summary p
)

-- The verdict columns are BLANKED for a compare pair with nothing comparable and no anomaly: a `0`
-- there must never look like the `0` a clean comparison produces. The volume columns stay visible.
SELECT 'summary'::text AS section, event_kind AS kind, consumer, NULL::text AS effect_key,
  shadow_total,
  CASE WHEN family = 'compare' AND (comparable > 0 OR anomalies > 0) THEN matched END AS matched,
  CASE WHEN family = 'compare' AND (comparable > 0 OR anomalies > 0) THEN payload_mismatch END AS payload_mismatch,
  CASE WHEN family = 'compare' AND (comparable > 0 OR anomalies > 0) THEN legacy_missing END AS legacy_missing,
  CASE WHEN family = 'compare' AND (comparable > 0 OR anomalies > 0) THEN compare_error END AS compare_error,
  superseded, unverifiable, not_stamped, legacy_only, uncorrelatable,
  CASE
    WHEN family = 'ingest' THEN
      'unverifiable: legacy is an external vector store, not SQL-visible — shadow volume only, EXCLUDED from any flip-clean conclusion'
    WHEN family = 'deletion' THEN
      'deletion kind: key-only, stamped unverifiable (the rows are gone on both sides before the event drains); the flip gates on the both-orders convergence tests, not this report'
    WHEN comparable = 0 AND anomalies = 0 AND superseded > 0 THEN
      'no_data (superseded only): ' || superseded || ' effect(s) whose legacy row a LATER event had already rewritten — correct on both sides, but nothing here diffed a payload'
    WHEN comparable = 0 AND anomalies = 0 THEN
      'no_data: nothing comparable in this window for this (consumer, kind) — absence is not evidence of a clean soak'
    WHEN anomalies > 0 THEN
      'ANOMALIES: payload_mismatch=' || payload_mismatch || ' legacy_missing=' || legacy_missing ||
      ' compare_error=' || compare_error || ' not_stamped=' || not_stamped ||
      ' legacy_only=' || legacy_only || ' uncorrelatable=' || uncorrelatable ||
      ' — NOT flip-clean; see the detail rows'
    ELSE 'clean: ' || matched || ' matched, ' || superseded || ' superseded, no anomalies in this window'
  END AS note
FROM pair_verdict

UNION ALL
SELECT 'summary', NULL, '(any)', NULL, (SELECT count(*) FROM invalid_shadow),
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'malformed or unexpected event_consumer_shadow rows (NULL field, orphaned event_id, an unexpected (consumer, kind), or an unrecognized legacy_match); MUST be zero — see invalid_shadow_row'

UNION ALL
SELECT 'summary', NULL, '(any)', NULL, (SELECT count(*) FROM invalid_legacy),
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'legacy rows whose key names no event (unparseable suffix, or an id no event row carries); MUST be zero — see invalid_legacy_row'

-- One detail row per stamped ANOMALY, and the SECTION IS THE STAMP — `payload_mismatch`,
-- `legacy_missing`, `compare_error`, or `not_stamped` for the pre-amendment NULL. `matched`,
-- `superseded` and `unverifiable` have no detail rows: none of them names anything to go and look
-- at, and a `superseded` list would be one line per routine re-write of a reused key.
UNION ALL
SELECT COALESCE(legacy_match, 'not_stamped'), event_kind, consumer, effect_key,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'event_id=' || event_id::text || ' detail=' || COALESCE(legacy_detail::text, '(null)')
FROM shadow_rows
WHERE legacy_match IS NULL OR legacy_match IN ('payload_mismatch', 'legacy_missing', 'compare_error')

UNION ALL
SELECT 'legacy_only_key', event_kind, consumer, effect_key, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'a keyed legacy row whose producing event is in the window with NO shadow twin — nothing ran to compare it'
FROM legacy_only_keys

UNION ALL
SELECT 'invalid_legacy_row', event_kind, consumer, effect_key, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'reason=' || reason
FROM invalid_legacy

UNION ALL
SELECT 'invalid_shadow_row', NULL, COALESCE(consumer, '(null)'), COALESCE(effect_key, '(null)'),
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'reason=' || reason || ' shadow_row_id=' || id::text || ' event_id=' || COALESCE(event_id::text, '(null)')
FROM invalid_shadow

ORDER BY section, consumer, kind, effect_key;
