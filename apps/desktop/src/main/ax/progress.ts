/**
 * Where is the user in the procedure? Worked out from the app's current state, not from the
 * order of their clicks, so going fast, out of order, or backwards can't confuse it. Pure.
 *
 * For each step: is its target on screen, and is it already satisfied?
 * - type steps: the field already holds the text;
 * - checkbox steps: the box is already ticked (or unticked, if the step says so);
 * - other clicks: a later step's target has appeared (the menu opened, the dialog appeared).
 * The current step is the first one whose target is on screen and that isn't satisfied yet.
 */
import type { Step } from '@qhint/schema';
import { matchTarget, normalizeName, targetNames, type AxMatch } from './match';
import type { AxElement } from './types';

export interface StepStatus {
  match: AxMatch | null;
  satisfied: boolean;
}

export interface Progress {
  steps: StepStatus[];
  /** The step the user is on; null when nothing from the guide is on screen. */
  current: number | null;
  /**
   * True when `current` is a checkpoint: a step the app's state can't confirm (an unlabelled
   * control, a manual step). The guide shows it and waits for the user to do it.
   */
  checkpoint: boolean;
}

const CHECKABLE_ACTIONS = new Set(['click', 'double_click', 'select', 'type']);

/** Can the app's state show this step being done (via a named element, or the page address)? */
export function checkable(step: Step): boolean {
  if (step.action === 'navigate') return typeof step.input === 'string' && !!toUrl(step.input);
  return CHECKABLE_ACTIONS.has(step.action) && targetNames(step).length > 0;
}

function toUrl(s: string): URL | null {
  const t = s.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
}

/**
 * Is the browser on the page a "go to" step wants? Same site (ignoring "www.") and path; any
 * query values the step names (e.g. ?veaction=edit) must be there too. Fragments don't matter.
 */
export function sameAddress(actual: string, wanted: string): boolean {
  const a = toUrl(actual);
  const w = toUrl(wanted);
  if (!a || !w) return false;
  const host = (u: URL) => u.hostname.replace(/^www\./, '').toLowerCase();
  const path = (u: URL) => decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/';
  if (host(a) !== host(w) || path(a) !== path(w)) return false;
  for (const [k, v] of w.searchParams) if (a.searchParams.get(k) !== v) return false;
  return true;
}

const CHECKBOX_ROLES = new Set(['AXCheckBox', 'CheckBox']);
const RADIO_ROLES = new Set(['AXRadioButton', 'RadioButton']);

/** What a checkbox step wants: ticked, unless it says to clear it. */
export function wantsTicked(step: Step): boolean {
  return !/\b(untick|uncheck|clear|turn off|disable|deselect|switch off)\b/i.test(
    `${step.instruction} ${step.expectedAfter ?? ''}`,
  );
}

function sameValue(actual: string, wanted: string): boolean {
  const a = normalizeName(actual);
  const w = normalizeName(wanted);
  if (a === w) return true;
  const na = Number(a.replace(',', '.'));
  const nw = Number(w.replace(',', '.'));
  return a !== '' && Number.isFinite(na) && Number.isFinite(nw) && na === nw;
}

/** Is this step already done, judging only by its own element? null = can't tell from state. */
function ownState(step: Step, m: AxMatch, pages: string[]): boolean | null {
  if (step.action === 'navigate') {
    return (
      typeof step.input === 'string' && pages.some((u) => sameAddress(u, step.input as string))
    );
  }
  const v = m.element.value;
  if (step.action === 'type') {
    if (typeof step.input !== 'string' || v === undefined) return null;
    return sameValue(v, step.input);
  }
  if (CHECKBOX_ROLES.has(m.element.role) && (v === '0' || v === '1')) {
    return (v === '1') === wantsTicked(step);
  }
  // An option button is done once it's the selected one.
  if (RADIO_ROLES.has(m.element.role) && (v === '0' || v === '1')) return v === '1';
  return null;
}

/** Identity of an on-screen element, to tell "already there" from "newly appeared". */
export function elementKey(m: AxMatch): string {
  const e = m.element;
  return [e.role, e.title ?? '', e.window, Math.round(e.x), Math.round(e.y)].join('|');
}

/** For each step, which element matched it when the guide started (if any). */
export function baselineOf(steps: Step[], elements: AxElement[]): Map<number, string> {
  const out = new Map<number, string>();
  steps.forEach((s, i) => {
    const m = matchTarget(s, elements);
    if (m) out.set(i, elementKey(m));
  });
  return out;
}

export interface ProgressContext {
  /** Steps the user finished in ways state can't show (typed into a field with no readable value, pressed Skip/Next). */
  doneByUser?: ReadonlySet<number>;
  /**
   * Elements already on screen when the guide started. Beyond the step being shown, such an
   * element is not evidence of progress (e.g. a toolbar "Open" button that is always there,
   * versus the "Open" button of the file dialog the user has just opened).
   */
  baseline?: ReadonlyMap<number, string>;
  /** The step currently shown; steps up to it may match elements that were there all along. */
  shown?: number;
}

export function assessProgress(
  steps: Step[],
  elements: AxElement[],
  context: ProgressContext | ReadonlySet<number> = {},
): Progress {
  const ctx: ProgressContext =
    context instanceof Set ? { doneByUser: context } : (context as ProgressContext);
  const doneByUser = ctx.doneByUser ?? new Set<number>();
  const pages = elements.flatMap((e) => (e.url ? [e.url] : []));
  const shown = ctx.shown ?? 0;
  const matches = steps.map((s, i) => {
    const m = matchTarget(s, elements);
    if (!m || i <= shown || !ctx.baseline) return m;
    // Ahead of where the guide is: only something that newly appeared counts.
    return ctx.baseline.get(i) === elementKey(m) ? null : m;
  });
  const status: StepStatus[] = steps.map((step, i) => {
    const m = matches[i]!;
    if (doneByUser.has(i)) return { match: m, satisfied: true };
    if (!m) return { match: null, satisfied: false };
    const own = ownState(step, m, pages);
    if (own !== null) return { match: m, satisfied: own };
    // Plain clicks: done once something from a later step has appeared.
    return { match: m, satisfied: matches.slice(i + 1).some((x) => x !== null) };
  });
  const visible = status.findIndex((s) => s.match && !s.satisfied);
  // A step state can't confirm, before where the user appears to be, must be done first.
  const gate = steps.findIndex((s, i) => !doneByUser.has(i) && !checkable(s));
  if (gate !== -1 && (visible === -1 || gate <= visible)) {
    // ...unless the user is still before it (a visible, unfinished step comes earlier).
    return { steps: status, current: gate, checkpoint: true };
  }
  return { steps: status, current: visible === -1 ? null : visible, checkpoint: false };
}

/** Steps before `index` that are on screen but not done (e.g. Header left unticked). */
export function skippedBefore(p: Progress, index: number, steps: Step[]): string[] {
  return p.steps
    .slice(0, index)
    .map((s, i) => (s.match && !s.satisfied ? steps[i]!.instruction : null))
    .filter((x): x is string => x !== null);
}
