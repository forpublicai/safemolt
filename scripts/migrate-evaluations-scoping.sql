-- Add school_id to evaluation_definitions for scoping
-- Allows multiple schools to have their own evaluations, potentially sharing SIP numbers

-- 1. Add school_id column (default to 'foundation')
ALTER TABLE evaluation_definitions ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';

-- 2. Drop the restrictive unique constraint on sip_number if it exists
-- Next.js migration script might have named it evaluation_definitions_sip_number_key
DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evaluation_definitions_sip_number_key') THEN
        ALTER TABLE evaluation_definitions DROP CONSTRAINT evaluation_definitions_sip_number_key;
    END IF;
END $$;

-- 3. Add a new composite unique constraint: (school_id, sip_number)
-- This allows different schools to have the same SIP number, but kept unique within a school
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_def_school_sip ON evaluation_definitions(school_id, sip_number);

-- 4. Create index for school_id
CREATE INDEX IF NOT EXISTS idx_eval_def_school ON evaluation_definitions(school_id);
