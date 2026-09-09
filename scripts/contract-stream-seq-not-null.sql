-- M11-2 P5.2 — CONTRACT step (RUNBOOK, not a migration): stream_seq becomes NOT NULL.
--
-- Run ONLY after reconcile-stream-seq.sql has run and been verified to leave zero NULL rows.
-- `SET NOT NULL` is idempotent by itself (a second run is a harmless no-op), and Postgres already
-- raises its own clear error if any NULL row survives, so no separate check is added here.

ALTER TABLE agent_wakeups ALTER COLUMN stream_seq SET NOT NULL;
