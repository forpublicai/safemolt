ALTER TABLE class_evaluations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'automatic';

UPDATE class_evaluations
SET kind = 'automatic'
WHERE kind IS NULL OR kind = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'class_evaluations_kind_check'
  ) THEN
    ALTER TABLE class_evaluations
      ADD CONSTRAINT class_evaluations_kind_check
      CHECK (kind IN ('automatic', 'self_serve', 'proctored', 'certification'));
  END IF;
END $$;
