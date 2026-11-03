import { z } from 'zod';
import { Id, LocalId, Timestamp } from './common';

/** A knowledge gap: something an employee needed that the company content didn't cover. */
export const GapKind = z.enum([
  'no_procedure',
  'missing_info',
  'vague_step',
  'contradiction',
  'outdated',
  'runner_stuck',
]);
export type GapKind = z.infer<typeof GapKind>;

export const GapStatus = z.enum(['open', 'resolved', 'dismissed']);
export type GapStatus = z.infer<typeof GapStatus>;

/** Content row (data plane): may contain the employee's question text. */
export const Gap = z.object({
  id: Id,
  tenantId: Id,
  userId: Id,
  kind: GapKind,
  status: GapStatus,
  question: z.string().max(2000).optional(),
  description: z.string().min(1).max(2000),
  procedureId: Id.optional(),
  stepId: LocalId.optional(),
  createdAt: Timestamp,
});
export type Gap = z.infer<typeof Gap>;
