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
import { matchTarget, normalizeName, type AxMatch } from './match';
import type { AxElement } from './types';

export interface StepStatus {
  match: AxMatch | null;
  satisfied: boolean;
}

export interface Progress {
  steps: StepStatus[];
  /** First visible, unsatisfied step; null when none is on screen. */
  current: number | null;
}

const CHECKBOX_ROLES = new Set(['AXCheckBox', 'CheckBox']);

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
function ownState(step: Step, m: AxMatch): boolean | null {
  const v = m.element.value;
  if (step.action === 'type') {
    if (typeof step.input !== 'string' || v === undefined) return null;
    return sameValue(v, step.input);
  }
  if (CHECKBOX_ROLES.has(m.element.role) && (v === '0' || v === '1')) {
    return (v === '1') === wantsTicked(step);
  }
  return null;
}

/**
 * @param doneByUser steps the user finished in ways state can't show (typed into a field with no
 *   readable value, pressed Skip/Next).
 */
export function assessProgress(
  steps: Step[],
  elements: AxElement[],
  doneByUser: ReadonlySet<number> = new Set(),
): Progress {
  const matches = steps.map((s) => matchTarget(s, elements));
  const status: StepStatus[] = steps.map((step, i) => {
    const m = matches[i]!;
    if (doneByUser.has(i)) return { match: m, satisfied: true };
    if (!m) return { match: null, satisfied: false };
    const own = ownState(step, m);
    if (own !== null) return { match: m, satisfied: own };
    // Plain clicks: done once something from a later step has appeared.
    return { match: m, satisfied: matches.slice(i + 1).some((x) => x !== null) };
  });
  const current = status.findIndex((s) => s.match && !s.satisfied);
  return { steps: status, current: current === -1 ? null : current };
}

/** Steps before `index` that are on screen but not done (e.g. Header left unticked). */
export function skippedBefore(p: Progress, index: number, steps: Step[]): string[] {
  return p.steps
    .slice(0, index)
    .map((s, i) => (s.match && !s.satisfied ? steps[i]!.instruction : null))
    .filter((x): x is string => x !== null);
}
