/** Kysely table types for the content schema (see db/migrations/content). */
import type { ColumnType, Generated } from 'kysely';

/** Timestamp with a database default: optional on insert, always a Date when read. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface DocumentsTable {
  id: Generated<string>;
  tenant_id: string;
  owner_id: string;
  visibility: Generated<'private' | 'company'>;
  kind: 'doc' | 'video' | 'recording';
  title: string;
  storage_key: string;
  content_type: string;
  size_bytes: ColumnType<string, number, number>;
  status: Generated<'pending_upload' | 'uploaded' | 'processing' | 'ready' | 'failed'>;
  created_at: Timestamp;
}

export interface ProceduresTable {
  id: Generated<string>;
  tenant_id: string;
  owner_id: string;
  visibility: Generated<'private' | 'company'>;
  status: Generated<'draft' | 'in_review' | 'published'>;
  version: Generated<number>;
  source: 'video' | 'doc' | 'recording' | 'generated';
  source_document_id: string | null;
  title: string;
  body: ColumnType<unknown, string, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RunsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  procedure_id: string | null;
  procedure_version: number | null;
  mode: 'guided' | 'live';
  status: Generated<'active' | 'completed' | 'abandoned' | 'stopped_at_gap'>;
  started_at: Timestamp;
  ended_at: Timestamp | null;
}

export interface GapsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  kind:
    'no_procedure' | 'missing_info' | 'vague_step' | 'contradiction' | 'outdated' | 'runner_stuck';
  status: Generated<'open' | 'resolved' | 'dismissed'>;
  question: string | null;
  description: string;
  procedure_id: string | null;
  step_id: string | null;
  created_at: Timestamp;
}

export interface ContentDB {
  'content.documents': DocumentsTable;
  'content.procedures': ProceduresTable;
  'content.runs': RunsTable;
  'content.gaps': GapsTable;
}
