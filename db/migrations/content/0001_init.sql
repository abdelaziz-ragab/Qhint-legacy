-- Data plane: all customer content lives in this schema.
-- Content tables, row-level security and app roles are added in Phase 2.
CREATE SCHEMA IF NOT EXISTS content;
CREATE EXTENSION IF NOT EXISTS vector;
