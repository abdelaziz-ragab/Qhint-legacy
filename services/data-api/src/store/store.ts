/**
 * THE data-plane store: the only way any code reads or writes customer content. Every method
 * takes the TenantContext derived from the verified login token; there is no way to pass a
 * tenant id from anywhere else. Implementations must enforce scoping in the database itself
 * (row-level security), not just in application code.
 */
import type { Procedure, ProcedureSource, Step } from '@qhint/schema';
import type { TenantContext } from './tenant-tx';

export type { TenantContext };

export interface ProcedureSummary {
  id: string;
  title: string;
  visibility: Procedure['visibility'];
  status: Procedure['status'];
  version: number;
  source: ProcedureSource;
  ownerId: string;
  updatedAt: string;
}

export interface NewProcedure {
  title: string;
  source: ProcedureSource;
  sourceDocumentId?: string;
  apps: Procedure['apps'];
  variables: Procedure['variables'];
  steps: Step[];
}

export type ProcedureScope = 'mine' | 'company' | 'review';

export interface DocumentRecord {
  id: string;
  kind: 'doc' | 'video' | 'recording';
  title: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  status: 'pending_upload' | 'uploaded' | 'processing' | 'ready' | 'failed';
  ownerId: string;
  createdAt: string;
}

export interface NewDocument {
  kind: DocumentRecord['kind'];
  title: string;
  contentType: string;
  sizeBytes: number;
}

export interface GapRecord {
  id: string;
  kind: string;
  status: string;
  question: string | null;
  description: string;
  procedureId: string | null;
  stepId: string | null;
  userId: string;
  createdAt: string;
}

export interface NewGap {
  kind: GapRecord['kind'];
  question?: string;
  description: string;
  procedureId?: string;
  stepId?: string;
}

export interface DataPlaneStore {
  procedures: {
    list(ctx: TenantContext, scope: ProcedureScope): Promise<ProcedureSummary[]>;
    /** Null when it doesn't exist or isn't visible to this user (indistinguishable on purpose). */
    get(ctx: TenantContext, id: string): Promise<Procedure | null>;
    create(ctx: TenantContext, input: NewProcedure): Promise<Procedure>;
    /** Owner sends a private procedure to admins ("suggest for company library"). */
    submitForReview(ctx: TenantContext, id: string): Promise<boolean>;
    /** Admin publishes to the company library. */
    publish(ctx: TenantContext, id: string): Promise<boolean>;
  };
  documents: {
    /** Registers an upload; the storage key is always under the caller's tenant prefix. */
    create(ctx: TenantContext, input: NewDocument): Promise<DocumentRecord>;
    get(ctx: TenantContext, id: string): Promise<DocumentRecord | null>;
    markUploaded(ctx: TenantContext, id: string): Promise<boolean>;
  };
  gaps: {
    create(ctx: TenantContext, input: NewGap): Promise<GapRecord>;
    list(ctx: TenantContext): Promise<GapRecord[]>;
  };
}
