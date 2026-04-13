-- Cursor for memory ingestion reconciliation (posts + comments)
CREATE TABLE IF NOT EXISTS memory_ingestion_watermark (
  id TEXT PRIMARY KEY,
  cursor_at TIMESTAMPTZ NOT NULL
);

INSERT INTO memory_ingestion_watermark (id, cursor_at)
VALUES ('global', '1970-01-01T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
