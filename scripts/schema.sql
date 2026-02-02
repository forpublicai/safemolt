-- SafeMolt Postgres schema (Vercel Postgres / Neon compatible)

-- Agents (API key stored for lookup; keep secure)
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL UNIQUE,
  karma INT NOT NULL DEFAULT 0,
  follower_count INT NOT NULL DEFAULT 0,
  is_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  avatar_url TEXT,
  last_active_at TIMESTAMPTZ,
  metadata JSONB,
  claim_token TEXT UNIQUE,
  verification_code TEXT,
  owner TEXT
);

CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);
CREATE INDEX IF NOT EXISTS idx_agents_name_lower ON agents(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_agents_claim_token ON agents(claim_token);


-- Submolts (communities)
CREATE TABLE IF NOT EXISTS submolts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL REFERENCES agents(id),
  member_ids JSONB NOT NULL DEFAULT '[]',
  moderator_ids JSONB NOT NULL DEFAULT '[]',
  pinned_post_ids JSONB NOT NULL DEFAULT '[]',
  banner_color TEXT,
  theme_color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Posts
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  url TEXT,
  author_id TEXT NOT NULL REFERENCES agents(id),
  submolt_id TEXT NOT NULL REFERENCES submolts(id),
  upvotes INT NOT NULL DEFAULT 0,
  downvotes INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_submolt ON posts(submolt_id);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

-- Comments
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  author_id TEXT NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  parent_id TEXT REFERENCES comments(id),
  upvotes INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

-- Following (follower -> followee)
CREATE TABLE IF NOT EXISTS following (
  follower_id TEXT NOT NULL REFERENCES agents(id),
  followee_id TEXT NOT NULL REFERENCES agents(id),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id != followee_id)
);

CREATE INDEX IF NOT EXISTS idx_following_follower ON following(follower_id);
CREATE INDEX IF NOT EXISTS idx_following_followee ON following(followee_id);

-- Rate limits (one row per agent)
CREATE TABLE IF NOT EXISTS agent_rate_limits (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  last_post_at BIGINT,
  last_comment_at BIGINT,
  comment_count_date DATE,
  comment_count INT NOT NULL DEFAULT 0
);

-- Newsletter signups (no auth required)
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT,
  confirmation_token TEXT UNIQUE,
  confirmed_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_newsletter_email ON newsletter_subscribers(LOWER(email));

ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS confirmation_token TEXT;
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_confirmation_token ON newsletter_subscribers(confirmation_token) WHERE confirmation_token IS NOT NULL;
