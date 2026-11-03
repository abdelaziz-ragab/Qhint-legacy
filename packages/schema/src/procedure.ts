import { z } from 'zod';
import { AppKind, BBox, Id, LocalId } from './common';

export const Visibility = z.enum(['private', 'company']);
export type Visibility = z.infer<typeof Visibility>;

export const ProcedureStatus = z.enum(['draft', 'in_review', 'published']);
export type ProcedureStatus = z.infer<typeof ProcedureStatus>;

export const ProcedureSource = z.enum(['video', 'doc', 'recording', 'generated']);
export type ProcedureSource = z.infer<typeof ProcedureSource>;

export const StepAction = z.enum([
  'click',
  'double_click',
  'type',
  'select',
  'shortcut',
  'navigate',
  'manual',
  'wait',
]);
export type StepAction = z.infer<typeof StepAction>;

/** Actions that point at an on-screen element and therefore need a target. */
export const TARGETED_ACTIONS: ReadonlySet<StepAction> = new Set([
  'click',
  'double_click',
  'select',
]);

export const VariableName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'must start with a letter; letters, digits, _ only');

export const Variable = z.object({
  name: VariableName,
  label: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});
export type Variable = z.infer<typeof Variable>;

/** Either a literal value to type/select, or a reference to a procedure variable. */
export const StepInput = z.union([z.string(), z.object({ var: VariableName })]);
export type StepInput = z.infer<typeof StepInput>;

export const StepApp = z.object({
  name: z.string().min(1).max(200),
  kind: AppKind,
  windowTitleHint: z.string().max(500).optional(),
});
export type StepApp = z.infer<typeof StepApp>;

export const Exemplar = z.object({
  /** Storage object key (never a URL; signed URLs are minted on demand). */
  imageRef: z.string().min(1).max(1024),
  /** Target location inside the exemplar image, in that image's pixels. */
  bbox: BBox,
});
export type Exemplar = z.infer<typeof Exemplar>;

export const Target = z.object({
  description: z.string().min(1).max(1000),
  text: z.string().max(500).optional(),
  role: z.string().max(100).optional(),
  neighbors: z.array(z.string().max(500)).max(20).default([]),
  exemplar: Exemplar.optional(),
});
export type Target = z.infer<typeof Target>;

export const Step = z
  .object({
    id: LocalId,
    instruction: z.string().min(1).max(2000),
    app: StepApp,
    action: StepAction,
    input: StepInput.optional(),
    target: Target.optional(),
    expectedAfter: z.string().max(2000).optional(),
    optional: z.boolean().default(false),
    /** Seconds from the start of the source video, when generated from one. */
    sourceTimestamp: z.number().nonnegative().optional(),
  })
  .superRefine((step, ctx) => {
    if (TARGETED_ACTIONS.has(step.action) && !step.target) {
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: `action "${step.action}" requires a target`,
      });
    }
  });
export type Step = z.infer<typeof Step>;

export const ProcedureApp = z.object({
  name: z.string().min(1).max(200),
  kind: AppKind,
});
export type ProcedureApp = z.infer<typeof ProcedureApp>;

export const Procedure = z
  .object({
    id: Id,
    tenantId: Id,
    ownerId: Id,
    visibility: Visibility,
    status: ProcedureStatus,
    version: z.int().min(1),
    source: ProcedureSource,
    title: z.string().min(1).max(300),
    apps: z.array(ProcedureApp).default([]),
    variables: z.array(Variable).default([]),
    steps: z.array(Step).min(1),
  })
  .superRefine((proc, ctx) => {
    const stepIds = new Set<string>();
    proc.steps.forEach((step, i) => {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'id'],
          message: `duplicate step id "${step.id}"`,
        });
      }
      stepIds.add(step.id);
    });

    const varNames = new Set<string>();
    proc.variables.forEach((v, i) => {
      if (varNames.has(v.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['variables', i, 'name'],
          message: `duplicate variable "${v.name}"`,
        });
      }
      varNames.add(v.name);
    });

    proc.steps.forEach((step, i) => {
      if (step.input && typeof step.input === 'object' && !varNames.has(step.input.var)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'input', 'var'],
          message: `unknown variable "${step.input.var}"`,
        });
      }
    });
  });
export type Procedure = z.infer<typeof Procedure>;
