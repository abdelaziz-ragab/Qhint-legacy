/** Guides (procedures) as the main window sees them. Shared by main process and renderer. */
import type { Procedure } from '@qhint/schema';

export type GuideStatus = 'draft' | 'in_review' | 'published';

export interface GuideSummary {
  id: string;
  title: string;
  status: GuideStatus;
  visibility: 'private' | 'company';
  source: 'video' | 'doc' | 'recording' | 'generated';
  updatedAt: string;
}

export interface GuideLists {
  mine: GuideSummary[];
  company: GuideSummary[];
}

export type JobStage =
  | 'queued'
  | 'reading'
  | 'frames'
  | 'transcribing'
  | 'writing'
  | 'images'
  | 'saving'
  | 'done'
  | 'failed';

/** A video or document being turned into a guide. */
export interface GuideJob {
  id: string;
  title: string;
  kind: 'video' | 'doc' | 'recording';
  status: 'queued' | 'running' | 'done' | 'failed';
  stage: JobStage;
  progress: number;
  errorCode: string | null;
  procedureId: string | null;
  createdAt: string;
}

/** What the author should check after a guide was generated. */
export interface GuideReport {
  summary?: string;
  flagged: { stepId: string; clarity: string; note: string }[];
  problems: string[];
}

export type Guide = Procedure;

export interface GuideEdit {
  title?: string;
  steps?: Procedure['steps'];
  variables?: Procedure['variables'];
}

/** Files Qhint can turn into guides, by extension. */
export const GUIDE_SOURCES = {
  video: ['mp4', 'mov', 'webm', 'ogv'],
  doc: ['pdf', 'txt', 'md'],
} as const;

export interface CreateGuideRequest {
  /** Absolute path chosen in the file picker or dropped on the window. */
  path: string;
  title: string;
  /** Spoken language of a video (BCP-47), e.g. en-US. */
  language: string;
  /** Language to write the guide in, e.g. English. */
  outputLanguage: string;
}

export type CreateGuideResult = { ok: true; job: GuideJob } | { ok: false; error: string };

export interface UploadProgress {
  path: string;
  sentBytes: number;
  totalBytes: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
