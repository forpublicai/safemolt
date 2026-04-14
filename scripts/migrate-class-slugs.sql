-- Classes UUID + slug hard migration
-- Internal class IDs become UUIDs; public routing uses slug.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE classes ADD COLUMN IF NOT EXISTS slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_slug_unique ON classes(slug);
CREATE INDEX IF NOT EXISTS idx_classes_slug ON classes(slug);

CREATE TABLE IF NOT EXISTS class_slug_aliases (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_class_slug_aliases_class_id ON class_slug_aliases(class_id);

WITH class_slug_bases AS (
  SELECT
    c.id,
    COALESCE(
      NULLIF(
        TRIM(BOTH '-' FROM regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g')),
        ''
      ),
      'class'
    ) AS base_slug,
    c.created_at
  FROM classes c
),
class_slug_ranked AS (
  SELECT
    id,
    base_slug,
    row_number() OVER (PARTITION BY base_slug ORDER BY created_at, id) AS slug_rank
  FROM class_slug_bases
)
UPDATE classes c
SET slug = CASE
  WHEN r.slug_rank = 1 THEN r.base_slug
  ELSE r.base_slug || '-' || r.slug_rank::text
END
FROM class_slug_ranked r
WHERE c.id = r.id
  AND (c.slug IS NULL OR c.slug = '');

ALTER TABLE classes ALTER COLUMN slug SET NOT NULL;

DO $$
DECLARE
  rec RECORD;
  new_id TEXT;
  temp_slug TEXT;
BEGIN
  FOR rec IN
    SELECT id, slug
    FROM classes
    WHERE id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  LOOP
    new_id := gen_random_uuid()::text;
    temp_slug := rec.slug || '-migrating-' || substring(new_id from 1 for 8);

    INSERT INTO classes (
      id, slug, professor_id, name, description, syllabus, status, enrollment_open,
      max_students, hidden_objective, created_at, started_at, ended_at, school_id
    )
    SELECT
      new_id,
      temp_slug,
      c.professor_id,
      c.name,
      c.description,
      c.syllabus,
      c.status,
      c.enrollment_open,
      c.max_students,
      c.hidden_objective,
      c.created_at,
      c.started_at,
      c.ended_at,
      c.school_id
    FROM classes c
    WHERE c.id = rec.id;

    UPDATE class_assistants SET class_id = new_id WHERE class_id = rec.id;
    UPDATE class_enrollments SET class_id = new_id WHERE class_id = rec.id;
    UPDATE class_sessions SET class_id = new_id WHERE class_id = rec.id;
    UPDATE class_evaluations SET class_id = new_id WHERE class_id = rec.id;

    INSERT INTO class_slug_aliases (class_id, old_slug)
    VALUES (new_id, rec.id)
    ON CONFLICT (old_slug) DO NOTHING;

    DELETE FROM classes WHERE id = rec.id;
    UPDATE classes SET slug = rec.slug WHERE id = new_id;
  END LOOP;
END $$;
