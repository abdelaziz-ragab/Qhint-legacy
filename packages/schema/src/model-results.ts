/**
 * Shapes returned by model calls. Every model response is parsed with one of these;
 * anything that fails to parse is treated as a "none"/"not sure" outcome, never guessed at.
 * A "none" result is a valid success.
 */
import { z } from 'zod';
import { BBox, Id, LocalId } from './common';

// ---------- locate ----------

export const LocateFound = z.object({
  kind: z.literal('found'),
  /** Label of the screenshot the box refers to, as given in the prompt. */
  screen: LocalId,
  bbox: BBox,
  confidence: z.enum(['high', 'medium']),
  label: z.string().max(300),
});

export const LocateNone = z.object({
  kind: z.literal('none'),
  reason: z.enum(['not_visible', 'ambiguous', 'low_confidence', 'wrong_app']),
  hint: z.string().max(1000),
});

export const LocateResult = z.discriminatedUnion('kind', [LocateFound, LocateNone]);
export type LocateResult = z.infer<typeof LocateResult>;

// ---------- verify ----------

export const VerifyResult = z.object({
  status: z.enum(['done', 'not_done', 'off_track']),
  explanation: z.string().max(1000),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

// ---------- assess ----------

export const StepClarity = z.enum([
  'clear',
  'vague',
  'needs_info',
  'manual',
  'contradiction',
  'outdated',
]);
export type StepClarity = z.infer<typeof StepClarity>;

export const AssessStep = z.object({
  stepId: LocalId,
  clarity: StepClarity,
  note: z.string().max(1000),
});

export const AssessGap = z.object({
  stepId: LocalId.optional(),
  description: z.string().min(1).max(1000),
});

export const AssessResult = z
  .object({
    verdict: z.enum(['ready', 'usable_with_gaps', 'not_enough']),
    procedureId: Id.optional(),
    steps: z.array(AssessStep),
    gaps: z.array(AssessGap),
    missing: z.string().max(2000).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.verdict !== 'not_enough' && !r.procedureId) {
      ctx.addIssue({
        code: 'custom',
        path: ['procedureId'],
        message: `verdict "${r.verdict}" requires procedureId`,
      });
    }
    if (r.verdict === 'usable_with_gaps' && r.gaps.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['gaps'],
        message: 'verdict "usable_with_gaps" requires at least one gap',
      });
    }
    if (r.verdict === 'not_enough' && !r.missing) {
      ctx.addIssue({
        code: 'custom',
        path: ['missing'],
        message: 'verdict "not_enough" requires "missing"',
      });
    }
  });
export type AssessResult = z.infer<typeof AssessResult>;
