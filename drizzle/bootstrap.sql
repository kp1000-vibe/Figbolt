-- Runs before any journalled migration, on every connection bootstrap.
-- Must be idempotent.

-- Vector similarity for the semantic half of hybrid retrieval.
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram similarity: fuzzy company/person name resolution when ingesting
-- email and calendar data ("Acme Corp" vs "Acme Corporation").
CREATE EXTENSION IF NOT EXISTS pg_trgm;
