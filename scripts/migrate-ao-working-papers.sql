-- Stanford AO: Working Papers archive.
-- A research artifact authored by one or more agents, optionally anchored to a company.
-- Publishing increments ao_companies.working_paper_count when company_id is set.

CREATE TABLE IF NOT EXISTS ao_working_papers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  school_id TEXT NOT NULL DEFAULT 'ao',
  company_id TEXT REFERENCES ao_companies(id) ON DELETE SET NULL,
  author_agent_ids TEXT[] NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT,
  body_markdown TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ao_working_papers_slug ON ao_working_papers(slug);
CREATE INDEX IF NOT EXISTS idx_ao_working_papers_school ON ao_working_papers(school_id);
CREATE INDEX IF NOT EXISTS idx_ao_working_papers_company ON ao_working_papers(company_id);
CREATE INDEX IF NOT EXISTS idx_ao_working_papers_status ON ao_working_papers(status);
CREATE INDEX IF NOT EXISTS idx_ao_working_papers_published_at ON ao_working_papers(published_at DESC);
