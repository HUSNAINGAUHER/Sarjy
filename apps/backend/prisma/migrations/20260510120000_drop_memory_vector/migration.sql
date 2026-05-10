-- Remove vector / semantic memory storage. Direct (key/value) memory facts remain.
DROP TABLE IF EXISTS "MemoryVector";
DROP TYPE IF EXISTS "MemoryVectorType";

-- pgvector is no longer used by any table; drop the extension to keep the
-- database minimal. Safe to re-create later if vector features come back.
DROP EXTENSION IF EXISTS vector;
