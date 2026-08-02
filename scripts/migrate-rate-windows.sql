-- M11-1 C13a: durable rate windows for the three unauthenticated, cost-bearing endpoints.
--
-- The activity-context and newsletter-subscribe limiters were process-local maps, so every
-- serverless instance handed out a fresh allowance and concurrent requests to different instances
-- bypassed them entirely; agent registration had no limiter at all and sends a claim email per
-- unique name. `rate_windows` is the shared fixed-window counter all three key into (via
-- src/lib/store/rate-windows/), incremented by one conditional upsert whose zero-row outcome IS
-- the denial.
--
-- `confirmation_sent_at` is the newsletter resend CAS column: the subscribe upsert only rotates a
-- pending row's token and re-sends when this stamp is NULL or older than the resend window, which
-- is what makes "at most one confirmation mail per window" a property of the statement rather
-- than of request timing.
--
-- Idempotent (Locked decision 5): re-running is the recovery path.

CREATE TABLE IF NOT EXISTS rate_windows (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ;

-- Existing rows predate the stamp. Leaving them NULL is correct — NULL means "no send recorded",
-- so the next admitted resubscribe may rotate-and-send once and then stamps the column.

-- Postconditions: assert the exact shapes later statements depend on, rolling the file back (and
-- recording nothing) if any is missing. `CREATE TABLE IF NOT EXISTS` is a no-op against a
-- pre-existing table, so the column TYPES are asserted too (M11-1b review B5): a stray
-- `count TEXT` would pass a name-only check and then fail at `count + 1` in the store.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND i.indrelid = 'public.rate_windows'::regclass
      AND i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['key', 'window_start']
  ) THEN
    RAISE EXCEPTION 'C13a postcondition failed: rate_windows primary key (key, window_start) is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rate_windows'
      AND column_name = 'key' AND data_type = 'text' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rate_windows'
      AND column_name = 'window_start' AND data_type = 'timestamp with time zone'
      AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    -- Nullability AND the zero default: the conditional upsert increments an existing row and
    -- inserts a fresh window otherwise, so a nullable `count` would make `count + 1` evaluate to
    -- NULL and silently stop counting — a rate limiter that never fires. Both halves of the key
    -- must be NOT NULL or the primary key cannot serve as the window identity.
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rate_windows'
      AND column_name = 'count' AND data_type = 'integer'
      AND is_nullable = 'NO' AND column_default = '0'
  ) THEN
    RAISE EXCEPTION 'C13a postcondition failed: rate_windows columns are not (key TEXT NOT NULL, window_start TIMESTAMPTZ NOT NULL, count INTEGER NOT NULL DEFAULT 0)';
  END IF;

  IF NOT EXISTS (
    -- Nullable with no default: NULL is the "no confirmation mail sent yet" state the resend CAS
    -- tests against. A NOT NULL or defaulted column would mark every existing subscriber as
    -- already mailed and suppress their first confirmation.
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'newsletter_subscribers'
      AND column_name = 'confirmation_sent_at' AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'C13a postcondition failed: newsletter_subscribers.confirmation_sent_at is missing or is not nullable-with-no-default';
  END IF;
END
$$;
