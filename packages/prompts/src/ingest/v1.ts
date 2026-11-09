/**
 * ingest.v1: turn a source (screen-recording frames + optional transcript, or a document) into a
 * draft procedure. Strict JSON. Steps the source doesn't make clear are flagged, never invented.
 */
import { AppKind, BBox, StepAction, type Step, type Variable } from '@qhint/schema';
import { z } from 'zod';
import type { ContentPart, PromptRequest } from '../content';

export const INGEST_VIDEO_V1 = 'ingest.video.v1';
export const INGEST_DOC_V1 = 'ingest.doc.v1';

export interface IngestFrame {
  /** "f01", "f02", ... in time order. */
  id: string;
  /** Seconds from the start of the video. */
  t: number;
  width: number;
  height: number;
  jpeg: Buffer;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface IngestVideoInput {
  /** What the uploader called it (a hint, may be empty). */
  title: string;
  frames: IngestFrame[];
  /** Null when the video has no speech (or it couldn't be transcribed). */
  transcript: TranscriptSegment[] | null;
  /** Language to write the guide in. */
  outputLanguage: string;
}

export interface IngestDocInput {
  title: string;
  document: { mediaType: 'application/pdf' | 'text/plain'; data: Buffer };
  outputLanguage: string;
}

const COMMON_RULES = `Write the procedure for someone who has never used this app and doesn't know where anything is. Use small, concrete steps, each one thing the user does: click one control, type into one field, choose one option, press one shortcut. Split compound actions ("open File and choose Save As") into separate steps. Do not include steps that are only narration, setup of the recording, or things the user only looks at.

Start from where a user would actually start. For a website, the first step goes to the page: action navigate, input_text = the full address shown in the browser's address bar (with any parameters such as ?action=edit), or a variable if the address is specific to this recording. Include signing in only as a manual step ("Sign in if you're asked to"), never with credentials.

For each step give:
- instruction: one or two short sentences in {LANG}: what to do, and where on the screen to find it, naming the control exactly as it is labelled (e.g. "Click File in the menu bar at the very top of the screen.", "Click the blue Publish changes button at the top right of the page."). If the control is an icon without a label, say what it looks like and where it is.
- For navigate: the instruction says to click the address bar at the top of the browser window, type the address and press Enter.
- action: click, double_click, type, select (choose from a list or drop-down), shortcut (a key combination; put it in input_text, e.g. "Ctrl+S"), navigate (go to a web address; put it in input_text), manual (something done off-screen or not visible), wait.
- app_name: the application the step happens in, as its user would call it (e.g. "LibreOffice Calc", "Google Chrome", "Moodle (web)"). Use the same name for all steps in the same app.
- target_*: the on-screen element the user acts on, for click, double_click, select and type: target_text = its exact visible label as written on screen (keep the original language and spelling, e.g. "Insert Table…"), target_role = button, menu, menu item, checkbox, radio button, tab, text field, drop-down, link, list item, icon, target_description = one sentence that identifies it for someone looking at the screen ("The Save button at the bottom right of the Export dialog"). neighbors = up to 4 visible labels next to it that help tell it apart.
- input_text: what to type or select, when the step types or chooses something. If the value is specific to this recording and would differ for another person or another time (a file name, a person's name, a title, a date, an amount), do NOT put the value in input_text: create a variable for it (short snake_case name, label, description) and set input_variable to its name. The same applies to targets: if the thing clicked is itself recording-specific (a particular file, person, record or row), set target_text to null, describe it generically in target_description ("The file you want to import, in the file list"), and link the variable through input_variable.
- expected_after: what the user should see once the step is done, so they know it worked (e.g. "A menu opens below File.", "The Insert Table window appears."). Always fill it in.
- clarity: clear, vague (you can tell roughly but not exactly what to do), needs_info (the source depends on information it doesn't give), manual (cannot be guided on screen). note: why, when not clear.

When the source only checks a setting that has a visible control (a checkbox, an option button, a switch), make it a step on that control, not a manual step: instruction "Make sure <label> is ticked." (or "selected", or "not ticked" when it must be off), action click, target_text the control's label, target_role checkbox or radio button. Qhint reads the control's state and moves on by itself when it is already right. Use manual only for checks with no single control (for example "check that the preview shows two columns").

Never copy personal or sensitive data from the source into the procedure (passwords, emails, names of people, account numbers): describe them instead or make them variables.
If the source does not show a procedure at all, set verdict to "not_a_procedure" and return no steps. If it shows only part of one, return what is clear, set verdict to "partial" and explain in problems.
title: a short task name starting with a verb ("Import a CSV file into LibreOffice Calc"). summary: one sentence.
Answer with JSON only, matching the provided schema.`;

const VIDEO_SYSTEM =
  `You turn screen recordings into step-by-step guides that an overlay will show live on the user's screen (a pointer and a ring around the element to click).

You receive frames from the recording in time order. Each frame is labeled with an id (f01, f02, ...), its time in seconds and its pixel size. Frames were taken whenever the screen changed, so consecutive frames usually show the state before and after one action. You may also receive a transcript of the narration with times.

Work out what the user did between frames (which control they clicked, what they typed) from how the screen changed, the mouse pointer, highlights and the narration. The narration explains intent; the frames are the ground truth for what to click.

For every step whose action has an on-screen target, also give:
- frame: the id of the frame showing the screen just BEFORE the action, where the target is visible.
- bbox: a tight box around the target in that frame's pixels [x1, y1, x2, y2]. Box the control itself (the button, the menu item, the field), not a panel or a label next to it. If you cannot box it precisely, set bbox to null (the guide will find it live instead); never guess.

` + COMMON_RULES;

const DOC_SYSTEM =
  `You turn written instructions (an SOP, a how-to, a help page) into step-by-step guides that an overlay will show live on the user's screen.

You receive one document. Follow its procedure. If it describes more than one procedure, take the main one and mention the others in problems. Use the labels the document quotes for buttons, menus and fields as target_text. There are no images: set frame and bbox to null for every step.

` + COMMON_RULES;

const STEP_ACTIONS = StepAction.options;
const CLARITY = ['clear', 'vague', 'needs_info', 'manual'] as const;

export const IngestV1Output = z.object({
  verdict: z.enum(['ok', 'partial', 'not_a_procedure']),
  title: z.string(),
  summary: z.string(),
  apps: z.array(z.object({ name: z.string(), kind: AppKind })),
  variables: z.array(z.object({ name: z.string(), label: z.string(), description: z.string() })),
  steps: z.array(
    z.object({
      instruction: z.string(),
      action: StepAction,
      app_name: z.string(),
      target_text: z.string().nullable(),
      target_role: z.string().nullable(),
      target_description: z.string().nullable(),
      neighbors: z.array(z.string()),
      input_text: z.string().nullable(),
      input_variable: z.string().nullable(),
      expected_after: z.string().nullable(),
      frame: z.string().nullable(),
      bbox: z.array(z.number()).nullable(),
      clarity: z.enum(CLARITY),
      note: z.string().nullable(),
    }),
  ),
  problems: z.array(z.string()),
});
export type IngestV1Output = z.infer<typeof IngestV1Output>;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const str = { type: 'string' };

export const INGEST_V1_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'title', 'summary', 'apps', 'variables', 'steps', 'problems'],
  properties: {
    verdict: { type: 'string', enum: ['ok', 'partial', 'not_a_procedure'] },
    title: str,
    summary: str,
    apps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind'],
        properties: { name: str, kind: { type: 'string', enum: AppKind.options } },
      },
    },
    variables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'label', 'description'],
        properties: { name: str, label: str, description: str },
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'instruction',
          'action',
          'app_name',
          'target_text',
          'target_role',
          'target_description',
          'neighbors',
          'input_text',
          'input_variable',
          'expected_after',
          'frame',
          'bbox',
          'clarity',
          'note',
        ],
        properties: {
          instruction: str,
          action: { type: 'string', enum: STEP_ACTIONS },
          app_name: str,
          target_text: nullable(str),
          target_role: nullable(str),
          target_description: nullable(str),
          neighbors: { type: 'array', items: str },
          input_text: nullable(str),
          input_variable: nullable(str),
          expected_after: nullable(str),
          frame: nullable(str),
          bbox: nullable({ type: 'array', items: { type: 'number' } }),
          clarity: { type: 'string', enum: [...CLARITY] },
          note: nullable(str),
        },
      },
    },
    problems: { type: 'array', items: str },
  },
};

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function buildIngestVideoV1(input: IngestVideoInput): PromptRequest {
  const content: ContentPart[] = [];
  if (input.title.trim())
    content.push({ type: 'text', text: `Uploaded as: "${input.title.trim()}"` });
  for (const f of input.frames) {
    content.push({ type: 'text', text: `${f.id} at ${fmt(f.t)} (${f.width}x${f.height} px):` });
    content.push({ type: 'image', mediaType: 'image/jpeg', data: f.jpeg, label: f.id });
  }
  content.push({
    type: 'text',
    text: input.transcript?.length
      ? `Narration transcript:\n${input.transcript.map((s) => `[${fmt(s.start)}] ${s.text.trim()}`).join('\n')}`
      : 'The recording has no narration.',
    // Frames + transcript are the big, reusable part: cache them for retries and later passes.
    cache: true,
  });
  content.push({ type: 'text', text: 'Build the procedure from this recording.' });
  return {
    promptId: INGEST_VIDEO_V1,
    system: VIDEO_SYSTEM.replace('{LANG}', input.outputLanguage),
    content,
    maxTokens: 16000,
    outputSchema: INGEST_V1_SCHEMA,
    effort: 'medium',
    timeoutMs: 300_000,
  };
}

export function buildIngestDocV1(input: IngestDocInput): PromptRequest {
  const content: ContentPart[] = [
    {
      type: 'document',
      mediaType: input.document.mediaType,
      data: input.document.data,
      ...(input.title.trim() ? { title: input.title.trim().slice(0, 200) } : {}),
      cache: true,
    },
    { type: 'text', text: 'Build the procedure from this document.' },
  ];
  return {
    promptId: INGEST_DOC_V1,
    system: DOC_SYSTEM.replace('{LANG}', input.outputLanguage),
    content,
    maxTokens: 16000,
    outputSchema: INGEST_V1_SCHEMA,
    effort: 'medium',
    timeoutMs: 300_000,
  };
}

// ---------------------------------------------------------------- interpretation

/** Where a step's target was seen in the source video (for the example crop). */
export interface StepSighting {
  stepId: string;
  frameId: string;
  bbox: BBox;
}

export interface IngestDraft {
  verdict: IngestV1Output['verdict'];
  title: string;
  summary: string;
  apps: { name: string; kind: z.infer<typeof AppKind> }[];
  variables: Variable[];
  steps: Step[];
  sightings: StepSighting[];
  /** Steps the source doesn't make clear (shown to the author for review). */
  flagged: { stepId: string; clarity: string; note: string }[];
  problems: string[];
}

const TARGETED = new Set(['click', 'double_click', 'select', 'type']);
const clip = (s: string | null | undefined, n: number) => (s ?? '').trim().slice(0, n);
const VAR_RX = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Turn the model's answer into valid steps. Anything inconsistent is repaired conservatively
 * (a click with no usable target becomes a manual step; a box outside its frame is dropped) and
 * reported in `flagged`, never silently invented.
 */
export function interpretIngestV1(
  output: unknown,
  frames: Pick<IngestFrame, 'id' | 'width' | 'height' | 't'>[] = [],
): IngestDraft | null {
  const parsed = IngestV1Output.safeParse(output);
  if (!parsed.success) return null;
  const o = parsed.data;

  const variables: Variable[] = [];
  for (const v of o.variables) {
    if (!VAR_RX.test(v.name) || variables.some((x) => x.name === v.name)) continue;
    variables.push({
      name: v.name,
      label: clip(v.label, 200) || v.name,
      ...(v.description.trim() ? { description: clip(v.description, 1000) } : {}),
    });
  }
  const varNames = new Set(variables.map((v) => v.name));
  const appKinds = new Map(o.apps.map((a) => [a.name, a.kind]));
  const frameById = new Map(frames.map((f) => [f.id, f]));

  const steps: Step[] = [];
  const sightings: StepSighting[] = [];
  const flagged: IngestDraft['flagged'] = [];
  for (const s of o.steps) {
    const id = `s${steps.length + 1}`;
    const instruction = clip(s.instruction, 2000);
    if (!instruction) continue;
    let action = s.action;
    const targetDescription = clip(s.target_description, 1000);
    const needsTarget = TARGETED.has(action);
    if (needsTarget && !targetDescription && action !== 'type') {
      action = 'manual';
      flagged.push({
        stepId: id,
        clarity: 'vague',
        note: 'No clear on-screen target in the source.',
      });
    }
    const appName = clip(s.app_name, 200) || o.apps[0]?.name || 'Unknown app';
    const input =
      s.input_variable && varNames.has(s.input_variable)
        ? { var: s.input_variable }
        : s.input_text?.trim()
          ? clip(s.input_text, 500)
          : undefined;
    const target =
      targetDescription && action !== 'manual' && action !== 'wait'
        ? {
            description: targetDescription,
            ...(s.target_text?.trim() ? { text: clip(s.target_text, 500) } : {}),
            ...(s.target_role?.trim() ? { role: clip(s.target_role, 100) } : {}),
            neighbors: s.neighbors
              .map((n) => clip(n, 500))
              .filter(Boolean)
              .slice(0, 20),
          }
        : undefined;
    const frame = s.frame ? frameById.get(s.frame) : undefined;
    steps.push({
      id,
      instruction,
      app: { name: appName, kind: appKinds.get(appName) ?? o.apps[0]?.kind ?? 'native' },
      action,
      ...(input !== undefined ? { input } : {}),
      ...(target ? { target } : {}),
      ...(s.expected_after?.trim() ? { expectedAfter: clip(s.expected_after, 2000) } : {}),
      optional: false,
      ...(frame ? { sourceTimestamp: frame.t } : {}),
    });
    if (s.clarity !== 'clear') {
      flagged.push({ stepId: id, clarity: s.clarity, note: clip(s.note, 500) });
    }
    // Keep the box only if it is a sane box inside that frame and not most of the screen.
    if (target && frame && s.bbox) {
      const box = BBox.safeParse(s.bbox);
      if (box.success) {
        const [x1, y1, x2, y2] = box.data;
        const inside = x2 <= frame.width && y2 <= frame.height;
        const small = (x2 - x1) * (y2 - y1) <= 0.25 * frame.width * frame.height;
        if (inside && small) sightings.push({ stepId: id, frameId: frame.id, bbox: box.data });
      }
    }
  }

  return {
    verdict: steps.length === 0 ? 'not_a_procedure' : o.verdict,
    title: clip(o.title, 300) || 'Untitled guide',
    summary: clip(o.summary, 1000),
    apps: o.apps
      .filter((a) => a.name.trim())
      .map((a) => ({ name: clip(a.name, 200), kind: a.kind })),
    variables,
    steps,
    sightings,
    flagged,
    problems: o.problems
      .map((p) => clip(p, 500))
      .filter(Boolean)
      .slice(0, 20),
  };
}
