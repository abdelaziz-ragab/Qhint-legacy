/**
 * locate.v1: find the UI element for one procedure step on labeled screenshots.
 * Returns strict JSON; "none" is a normal, expected answer. A wrong box is worse than none.
 */
import { BBox, LocateResult } from '@qhint/schema';
import { z } from 'zod';
import type { ContentPart, PromptRequest } from '../content';
import type { LocateInput } from './types';

export const LOCATE_V1 = 'locate.v1';

const SYSTEM = `You locate user-interface elements on screenshots for a step-by-step guidance tool.

You receive one or more screenshots, each labeled (screen_1, screen_2, ...) with its pixel size, and one procedure step: the instruction, the action, the app, and a description of the target element.

Find the single element the user must interact with for this step and return a tight bounding box around it, in that screenshot's own pixel coordinates (x1, y1 = top-left; x2, y2 = bottom-right; x2 > x1, y2 > y1).

Rules:
- Only answer "found" if you can see the element clearly and it unambiguously matches the description. Use its visible text, role (button, menu item, field, checkbox, tab, link) and neighbours to decide.
- Box the interactive control itself: the button, field, checkbox or menu item, not a surrounding panel or a nearby label. For a text field, box the input area. For a checkbox, box the box and its label together.
- If the element is not visible on any screenshot (for example, a menu that must be opened first, or it is scrolled out of view), answer "none" with reason "not_visible" and a short hint about what the user should do first.
- If an unrelated pop-up (a tip of the day, a notification, an update prompt) is in front and hides or blocks the target, answer "none" with reason "not_visible" and a hint telling the user to close it, naming its button (for example "Close the Tip of the Day dialog (OK)").
- If two or more elements match equally well, answer "none" with reason "ambiguous".
- If the screenshots do not show the app named in the step, answer "none" with reason "wrong_app" and a hint naming the app to open.
- If you are unsure for any other reason, answer "none" with reason "low_confidence". Never guess: a wrong box is worse than no box.
- confidence "high" means you are certain; "medium" means very likely but not certain.
- hint and label must be short (under 15 words) and must not repeat sensitive on-screen data such as names, emails or numbers.

Answer with JSON only, matching the provided schema. For "found", set reason and hint to null. For "none", set screen, bbox, confidence and label to null.`;

/** Flat shape the model fills in (simpler and more robust than a union for constrained output). */
export const LocateV1Output = z.object({
  kind: z.enum(['found', 'none']),
  screen: z.string().nullable(),
  bbox: z.array(z.number()).nullable(),
  confidence: z.enum(['high', 'medium']).nullable(),
  label: z.string().nullable(),
  reason: z.enum(['not_visible', 'ambiguous', 'low_confidence', 'wrong_app']).nullable(),
  hint: z.string().nullable(),
});
export type LocateV1Output = z.infer<typeof LocateV1Output>;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

export const LOCATE_V1_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'screen', 'bbox', 'confidence', 'label', 'reason', 'hint'],
  properties: {
    kind: { type: 'string', enum: ['found', 'none'] },
    screen: nullable({ type: 'string' }),
    bbox: nullable({ type: 'array', items: { type: 'number' } }),
    confidence: nullable({ type: 'string', enum: ['high', 'medium'] }),
    label: nullable({ type: 'string' }),
    reason: nullable({
      type: 'string',
      enum: ['not_visible', 'ambiguous', 'low_confidence', 'wrong_app'],
    }),
    hint: nullable({ type: 'string' }),
  },
};

function describeStep(input: LocateInput): string {
  const { step } = input;
  const t = step.target;
  const lines = [
    `App: ${step.app.name} (${step.app.kind})${step.app.windowTitleHint ? `, window title like "${step.app.windowTitleHint}"` : ''}`,
    `Instruction: ${step.instruction}`,
    `Action: ${step.action}`,
  ];
  if (t) {
    lines.push(`Target: ${t.description}`);
    if (t.text) lines.push(`Target text: "${t.text}"`);
    if (t.role) lines.push(`Target role: ${t.role}`);
    if (t.neighbors.length) lines.push(`Nearby: ${t.neighbors.join('; ')}`);
  }
  return lines.join('\n');
}

export function buildLocateV1(input: LocateInput): PromptRequest {
  const content: ContentPart[] = [];
  for (const s of input.screens) {
    content.push({ type: 'text', text: `${s.label} (${s.width}x${s.height} px):` });
    content.push({ type: 'image', mediaType: 'image/jpeg', data: s.jpeg, label: s.label });
  }
  if (input.exemplar) {
    content.push({
      type: 'text',
      text: 'Example of what the target looked like before (for reference only; locate it on the screenshots above):',
    });
    content.push({ type: 'image', mediaType: 'image/jpeg', data: input.exemplar.jpeg });
  }
  content.push({ type: 'text', text: `Step:\n${describeStep(input)}` });
  return {
    promptId: LOCATE_V1,
    system: SYSTEM,
    content,
    maxTokens: 1024,
    outputSchema: LOCATE_V1_SCHEMA,
    effort: 'low',
  };
}

/**
 * Turn the model's answer into a LocateResult, rejecting anything inconsistent: unknown screen,
 * malformed box, or a box outside the screenshot all become "none / low_confidence".
 */
export function interpretLocateV1(output: unknown, input: LocateInput): LocateResult {
  const fallback = (hint = ''): LocateResult => ({ kind: 'none', reason: 'low_confidence', hint });
  const parsed = LocateV1Output.safeParse(output);
  if (!parsed.success) return fallback();
  const o = parsed.data;

  if (o.kind === 'none') {
    return {
      kind: 'none',
      reason: o.reason ?? 'low_confidence',
      hint: (o.hint ?? '').slice(0, 300),
    };
  }
  const screen = input.screens.find((s) => s.label === o.screen);
  const bbox = BBox.safeParse(o.bbox);
  if (!screen || !bbox.success || !o.confidence) return fallback();
  const [x1, y1, x2, y2] = bbox.data;
  if (x2 > screen.width || y2 > screen.height) return fallback();
  // A "box" covering most of the screen isn't a pointer to one element.
  if ((x2 - x1) * (y2 - y1) > 0.25 * screen.width * screen.height) return fallback();
  return LocateResult.parse({
    kind: 'found',
    screen: screen.label,
    bbox: [x1, y1, x2, y2],
    confidence: o.confidence,
    label: (o.label ?? '').slice(0, 300),
  });
}
