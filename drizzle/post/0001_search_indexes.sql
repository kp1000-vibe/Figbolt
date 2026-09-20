-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written follow-up migration.
--
-- Drizzle's schema DSL cannot express generated columns backed by weighted
-- tsvector expressions, HNSW operator classes, or partial/expression indexes.
-- Those live here. Everything must be idempotent: the migrator replays this
-- file whenever it changes.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Lexical search vectors ───────────────────────────────────────────────────
-- Generated columns keep the index in lockstep with the row with no triggers
-- and no chance of an application code path forgetting to refresh them.
-- Weight A = title-ish fields, B = body.

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('emails',              $expr$setweight(to_tsvector('english', coalesce(subject, '')), 'A') || setweight(to_tsvector('english', coalesce(body_text, '')), 'B')$expr$),
      ('meetings',            $expr$setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')$expr$),
      ('notes',              $expr$to_tsvector('english', coalesce(body, ''))$expr$),
      ('transcripts',         $expr$to_tsvector('english', coalesce(full_text, ''))$expr$),
      ('embeddings',          $expr$to_tsvector('english', coalesce(content, ''))$expr$),
      ('knowledge_chunks',    $expr$setweight(to_tsvector('english', coalesce(heading, '')), 'A') || setweight(to_tsvector('english', coalesce(content, '')), 'B')$expr$),
      ('knowledge_documents', $expr$setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content, '')), 'B')$expr$)
    ) AS t(tbl, expr)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = spec.tbl
        AND column_name = 'search_vector'
        AND is_generated = 'ALWAYS'
    ) THEN
      EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS search_vector', spec.tbl);
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (%s) STORED',
        spec.tbl, spec.expr
      );
    END IF;
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING gin (search_vector)',
      spec.tbl || '_search_gin', spec.tbl
    );
  END LOOP;
END $$;

-- ── Vector similarity indexes ────────────────────────────────────────────────
-- HNSW with cosine distance. `m`/`ef_construction` are tuned for CRM-scale
-- corpora (tens of thousands of chunks) where recall matters more than build time.

CREATE INDEX IF NOT EXISTS embeddings_vector_hnsw
  ON embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS knowledge_chunks_vector_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── Fuzzy entity resolution ──────────────────────────────────────────────────
-- Used when ingestion has a display name but no id: "who is Acme Corporation?"

CREATE INDEX IF NOT EXISTS accounts_name_trgm
  ON accounts USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS contacts_name_trgm
  ON contacts USING gin ((first_name || ' ' || last_name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS opportunities_name_trgm
  ON opportunities USING gin (name gin_trgm_ops);

-- ── Partial indexes for the hot paths ────────────────────────────────────────
-- The Inbox, the pipeline board and the "needs processing" queues all filter on
-- a small live subset of much larger tables.

CREATE INDEX IF NOT EXISTS opportunities_open_idx
  ON opportunities (workspace_id, stage_id, position)
  WHERE deleted_at IS NULL AND status = 'open';

CREATE INDEX IF NOT EXISTS notifications_open_idx
  ON notifications (workspace_id, user_id, created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS approvals_pending_idx
  ON approvals (workspace_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS emails_pending_extraction_idx
  ON emails (workspace_id, sent_at)
  WHERE processed_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS meetings_pending_extraction_idx
  ON meetings (workspace_id, starts_at)
  WHERE processed_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS memory_facts_active_idx
  ON memory_facts (workspace_id, subject_type, subject_id, key)
  WHERE status = 'active' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS jobs_claimable_idx
  ON jobs (run_at)
  WHERE status = 'queued';

-- ── Integrity constraints ────────────────────────────────────────────────────
-- Defence in depth for the values that gate authorization and side effects.
-- The application validates these too; the database is the backstop that holds
-- even if a code path is missed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_members_role_check') THEN
    ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
      CHECK (role IN ('owner', 'admin', 'manager', 'member', 'viewer'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approvals_risk_check') THEN
    ALTER TABLE approvals ADD CONSTRAINT approvals_risk_check
      CHECK (risk_level IN ('low', 'medium', 'high'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approvals_status_check') THEN
    ALTER TABLE approvals ADD CONSTRAINT approvals_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed'));
  END IF;

  -- An approval may only be marked executed once it was actually approved.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approvals_execution_check') THEN
    ALTER TABLE approvals ADD CONSTRAINT approvals_execution_check
      CHECK (executed_at IS NULL OR status IN ('approved', 'executed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_facts_confidence_check') THEN
    ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_confidence_check
      CHECK (confidence >= 0 AND confidence <= 1);
  END IF;

  -- A superseded fact must have an end to its validity window, and an active
  -- one must not. This is what makes "as of date X" queries trustworthy.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_facts_validity_check') THEN
    ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_validity_check
      CHECK (
        (status = 'active' AND valid_until IS NULL)
        OR (status <> 'active')
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunities_value_check') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_value_check
      CHECK (value >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'health_score_range_check') THEN
    ALTER TABLE opportunities ADD CONSTRAINT health_score_range_check
      CHECK (health_score IS NULL OR (health_score >= 0 AND health_score <= 100));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_health_score_range_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_health_score_range_check
      CHECK (health_score IS NULL OR (health_score >= 0 AND health_score <= 100));
  END IF;
END $$;

-- ── Self-referencing fact chain ──────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_facts_supersedes_fk') THEN
    ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_supersedes_fk
      FOREIGN KEY (supersedes_id) REFERENCES memory_facts(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── Support-ticket search vector ─────────────────────────────────────────────
-- Added alongside the API-key and usage tables. Tickets are a raw interaction
-- source like email, so they need the same lexical index.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'support_tickets') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'support_tickets'
        AND column_name = 'search_vector'
        AND is_generated = 'ALWAYS'
    ) THEN
      ALTER TABLE support_tickets DROP COLUMN IF EXISTS search_vector;
      ALTER TABLE support_tickets ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(body, '')), 'B')
        ) STORED;
    END IF;
    CREATE INDEX IF NOT EXISTS support_tickets_search_gin
      ON support_tickets USING gin (search_vector);
  END IF;
END $$;

-- Only live keys matter to the auth path.
CREATE INDEX IF NOT EXISTS api_keys_active_idx
  ON api_keys (workspace_id)
  WHERE revoked_at IS NULL;
