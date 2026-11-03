import { z } from 'zod';
import { Id, LocalId, Timestamp } from './common';

export const RunMode = z.enum(['guided', 'live']);
export type RunMode = z.infer<typeof RunMode>;

export const RunStatus = z.enum(['active', 'completed', 'abandoned', 'stopped_at_gap']);
export type RunStatus = z.infer<typeof RunStatus>;

export const Run = z.object({
  id: Id,
  tenantId: Id,
  userId: Id,
  /** Absent for live-mode runs over a document without a procedure. */
  procedureId: Id.optional(),
  procedureVersion: z.int().min(1).optional(),
  mode: RunMode,
  status: RunStatus,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
});
export type Run = z.infer<typeof Run>;

export const StepOutcome = z.enum(['done', 'skipped', 'stuck', 'gap', 'abandoned']);
export type StepOutcome = z.infer<typeof StepOutcome>;

/** How the step was confirmed complete. */
export const AdvanceMethod = z.enum(['manual', 'verified']);
export type AdvanceMethod = z.infer<typeof AdvanceMethod>;

/** Where the highlight came from (none = text-only guidance). */
export const LocateSource = z.enum(['cache', 'model', 'none']);
export type LocateSource = z.infer<typeof LocateSource>;

export const StepResult = z.object({
  runId: Id,
  stepId: LocalId,
  outcome: StepOutcome,
  advance: AdvanceMethod.optional(),
  locateSource: LocateSource,
  attempts: z.int().min(0),
  durationMs: z.int().min(0),
  finishedAt: Timestamp,
});
export type StepResult = z.infer<typeof StepResult>;
