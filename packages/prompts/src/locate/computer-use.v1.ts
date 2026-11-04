/**
 * locate.cu.v1: the same task using Anthropic's computer-use toolset, so the two approaches can be
 * compared in the eval harness. The model is asked to click the target on one screenshot; we
 * never execute the click, we only read where it would click. Answering in text means "none".
 */
import type { LocateResult } from '@qhint/schema';
import type { ContentPart, PromptRequest } from '../content';
import type { LocateInput } from './types';

export const LOCATE_CU_V1 = 'locate.cu.v1';

/** Half-size of the box drawn around the click point, in image pixels. */
export const CU_POINT_BOX = 14;

const SYSTEM = `You help a guidance tool show a user where to click. The screenshot shows the user's screen. Do NOT take any action other than the single click requested below; it will only be used to point at the element, not executed.

If the element for the step is clearly visible and unambiguous, call left_click once at its centre.
Otherwise, do not call any tool. Reply with exactly one line: NONE <reason> <short hint>, where <reason> is one of not_visible, ambiguous, low_confidence, wrong_app. Never guess.`;

export function buildLocateCuV1(input: LocateInput): PromptRequest {
  // The computer-use tool works in a single screen's pixel space: use the screen under the cursor.
  const screen = input.screens[0];
  if (!screen) throw new Error('no screens');
  const { step } = input;
  const target = step.target
    ? `\nTarget: ${step.target.description}${step.target.text ? ` (text "${step.target.text}")` : ''}`
    : '';
  const content: ContentPart[] = [
    { type: 'image', mediaType: 'image/jpeg', data: screen.jpeg, label: screen.label },
    {
      type: 'text',
      text: `App: ${step.app.name}\nStep: ${step.instruction}${target}\nClick the element for this step.`,
    },
  ];
  return {
    promptId: LOCATE_CU_V1,
    system: SYSTEM,
    content,
    maxTokens: 1024,
    tools: [{ type: 'computer_toolset_20260801' }],
    effort: 'low',
  };
}

const REASONS = new Set(['not_visible', 'ambiguous', 'low_confidence', 'wrong_app']);

/** `toolCalls` are the model's tool_use blocks; `text` is its text reply. */
export function interpretLocateCuV1(
  response: { text: string; toolCalls: { name: string; input: unknown }[] },
  input: LocateInput,
): LocateResult {
  const screen = input.screens[0]!;
  const clicks = response.toolCalls.filter((c) => c.name === 'left_click');
  if (clicks.length === 1) {
    const coord = (clicks[0]!.input as { coordinate?: unknown }).coordinate;
    if (
      Array.isArray(coord) &&
      coord.length === 2 &&
      coord.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      const [x, y] = coord as [number, number];
      if (x >= 0 && y >= 0 && x < screen.width && y < screen.height) {
        return {
          kind: 'found',
          screen: screen.label,
          bbox: [
            Math.max(0, x - CU_POINT_BOX),
            Math.max(0, y - CU_POINT_BOX),
            Math.min(screen.width, x + CU_POINT_BOX),
            Math.min(screen.height, y + CU_POINT_BOX),
          ],
          confidence: 'medium', // a point carries no confidence of its own
          label: 'click point',
        };
      }
    }
  }
  const m = /NONE\s+(\w+)\s*(.*)/i.exec(response.text);
  const reason = m && REASONS.has(m[1]!) ? (m[1] as 'not_visible') : 'low_confidence';
  return { kind: 'none', reason, hint: (m?.[2] ?? '').trim().slice(0, 300) };
}
