-- Professor-to-human-user linking migration
-- Allows human users to be associated with professor accounts
-- so they can manage classes from the dashboard UI

ALTER TABLE professors ADD COLUMN IF NOT EXISTS human_user_id TEXT REFERENCES human_users(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_professors_human_user ON professors(human_user_id) WHERE human_user_id IS NOT NULL;
