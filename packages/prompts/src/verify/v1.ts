/**
 * verify.v1: did the user complete this step? Compares screenshots from before and after their
 * action against the step's expected result. Biased toward "not_done" when unsure, but it is only
 * consulted when the next step's target can't be found, so a doubtful answer never blocks a
 * guide that is visibly progressing.
 */
import { VerifyResult } from '@qhint/schema';
import type { Step } from '@qhint/schema';
import type { ContentPart, PromptRequest, ScreenImage } from '../content';

export const VERIFY_V1 = 'verify.v1';

const SYSTEM = `You check whether a user completed one step of a guided procedure on their computer.

You get screenshots from BEFORE and AFTER the user acted, the step's instruction, and what the screen should show after the step (the expected result).

Answer:
- "done" only if the AFTER screenshots clearly show the expected result (or something equivalent).
- "not_done" if the expected result is not visible, or you cannot tell. When unsure, answer not_done.
- "off_track" if the AFTER screenshots show the user went somewhere clearly unrelated (a different app, an error, a wrong dialog).

explanation: one short sentence for the user (under 20 words), e.g. "The Table menu didn't open." Do not repeat names, emails or numbers from the screen.

Answer with JSON only, matching the provided schema.`;

export const VERIFY_V1_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'explanation'],
  properties: {
    status: { type: 'string', enum: ['done', 'not_done', 'off_track'] },
    explanation: { type: 'string' },
  },
};

export interface VerifyInput {
  step: Pick<Step, 'instruction' | 'action' | 'input' | 'app' | 'expectedAfter'>;
  before: ScreenImage[];
  after: ScreenImage[];
}

export function buildVerifyV1(input: VerifyInput): PromptRequest {
  const content: ContentPart[] = [];
  const add = (when: string, screens: ScreenImage[]) => {
    for (const s of screens) {
      content.push({ type: 'text', text: `${when} ${s.label} (${s.width}x${s.height} px):` });
      content.push({
        type: 'image',
        mediaType: 'image/jpeg',
        data: s.jpeg,
        label: `${when}-${s.label}`,
      });
    }
  };
  add('BEFORE', input.before);
  add('AFTER', input.after);
  const { step } = input;
  content.push({
    type: 'text',
    text: [
      `App: ${step.app.name}`,
      `Instruction: ${step.instruction}`,
      `Action: ${step.action}${typeof step.input === 'string' ? ` "${step.input}"` : ''}`,
      `Expected result: ${step.expectedAfter ?? 'The instruction has been carried out.'}`,
    ].join('\n'),
  });
  return {
    promptId: VERIFY_V1,
    system: SYSTEM,
    content,
    maxTokens: 512,
    outputSchema: VERIFY_V1_SCHEMA,
    effort: 'low',
  };
}

/** Anything unusable counts as "not_done" (we never assume success). */
export function interpretVerifyV1(output: unknown): VerifyResult {
  const parsed = VerifyResult.safeParse(output);
  if (!parsed.success) return { status: 'not_done', explanation: '' };
  return { status: parsed.data.status, explanation: parsed.data.explanation.slice(0, 300) };
}
