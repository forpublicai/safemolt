-- Evaluation definitions: `adapted_from` provenance column.
--
-- `syncEvaluationsToDb` has written `adapted_from` since the SIP frontmatter gained it, but no
-- migration ever added the column: existing databases carry it from a hand edit, and a fresh one
-- (schema.sql plus every migration) failed the whole sync. The failure was invisible while the
-- sync ran in src/instrumentation.ts, which logs and continues; it now runs as a build step
-- (scripts/sync-evaluations.ts) that fails loudly, so the column must exist before it runs.

ALTER TABLE evaluation_definitions ADD COLUMN IF NOT EXISTS adapted_from TEXT;
