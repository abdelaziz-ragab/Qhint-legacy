/**
 * Find a step's target among accessibility elements. Pure; no Electron.
 *
 * Only exact name matches count, and the answer must be unambiguous: a wrong pointer is worse
 * than none, so anything unclear returns null and the guide falls back to the screenshot model.
 */
import type { Step } from '@qhint/schema';
import type { Rect } from '../../shared/geometry';
import type { AxElement } from './types';

const MENU_BAR_ITEM = ['AXMenuBarItem', 'MenuBarItem'];
const MENU_ITEM = ['AXMenuItem', 'MenuItem'];
const CHECKBOX = ['AXCheckBox', 'CheckBox'];
const RADIO = ['AXRadioButton', 'RadioButton'];
const TAB = ['AXRadioButton', 'AXTab', 'TabItem'];
const BUTTON = ['AXButton', 'AXMenuButton', 'AXPopUpButton', 'Button', 'SplitButton'];
const LINK = ['AXLink', 'Hyperlink'];
const POPUP = ['AXPopUpButton', 'AXComboBox', 'ComboBox'];
/** Editable fields. AXUnknown covers custom spin fields (e.g. LibreOffice's), which still carry a title. */
const FIELD = [
  'AXTextField',
  'AXTextArea',
  'AXComboBox',
  'AXIncrementor',
  'AXUnknown',
  'Edit',
  'Spinner',
  'ComboBox',
  'Document',
];
const INTERACTIVE = [
  ...new Set([
    ...MENU_BAR_ITEM,
    ...MENU_ITEM,
    ...CHECKBOX,
    ...RADIO,
    ...TAB,
    ...BUTTON,
    ...LINK,
    ...POPUP,
    ...FIELD,
  ]),
];

/** Which element roles a step's target can be. */
export function allowedRoles(step: Step): string[] {
  if (step.action === 'type') return FIELD;
  const role = (step.target?.role ?? '').toLowerCase();
  if (/menu\s*item|menu\s*entry|menu\s*option/.test(role)) return MENU_ITEM;
  if (/spin|field|text\s*box|input|edit/.test(role)) return FIELD;
  if (/check\s*box/.test(role)) return CHECKBOX;
  if (/radio/.test(role)) return RADIO;
  if (/\btab\b/.test(role)) return TAB;
  if (/drop.?down|combo|select|pop.?up|list\s*box/.test(role)) return POPUP;
  if (/menu/.test(role)) return MENU_BAR_ITEM;
  if (/link/.test(role)) return LINK;
  if (/button/.test(role)) return BUTTON;
  return INTERACTIVE;
}

/** Compare names the way a person reads them: case, ellipses, colons and mnemonics ignored. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…|\.\.\./g, '')
    .replace(/&(?=\S)/g, '')
    .replace(/[:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The visible text to look for: target.text, else a quoted name in the description. */
export function targetNames(step: Step): string[] {
  const t = step.target;
  if (!t) return [];
  if (t.text?.trim()) return [normalizeName(t.text)];
  const quoted = [...t.description.matchAll(/["“]([^"”]{1,80})["”]/g)].map((m) =>
    normalizeName(m[1]!),
  );
  return [...new Set(quoted)].filter(Boolean);
}

function names(e: AxElement): string[] {
  return [e.title, e.description, e.label]
    .filter((n): n is string => !!n)
    .map(normalizeName)
    .filter(Boolean);
}

const center = (e: AxElement) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });
const rectOf = (e: AxElement): Rect => ({ x: e.x, y: e.y, width: e.w, height: e.h });

/** A field with no name of its own, labelled by static text just left of it or just above it. */
function labelledFields(label: string, elements: AxElement[], roles: string[]): AxElement[] {
  const texts = elements.filter(
    (e) => /StaticText|Text$/.test(e.role) && e.value && normalizeName(e.value) === label,
  );
  const out: AxElement[] = [];
  for (const t of texts) {
    const tc = center(t);
    const nearest = elements
      .filter((e) => roles.includes(e.role) && e.window === t.window && names(e).length === 0)
      .map((e) => {
        const c = center(e);
        const rightOf = e.x >= t.x + t.w - 4 && Math.abs(c.y - tc.y) <= Math.max(e.h, t.h) / 2;
        const below = e.y >= t.y + t.h - 4 && e.y - (t.y + t.h) < 40 && Math.abs(e.x - t.x) < 40;
        const d = Math.hypot(c.x - tc.x, c.y - tc.y);
        return { e, ok: (rightOf || below) && d < 320, d };
      })
      .filter((c) => c.ok)
      .sort((a, b) => a.d - b.d)[0];
    if (nearest) out.push(nearest.e);
  }
  return out;
}

/** How many of the step's neighbors appear by name close to this element. */
function neighborScore(e: AxElement, neighbors: string[], elements: AxElement[]): number {
  if (neighbors.length === 0) return 0;
  const c = center(e);
  const wanted = new Set(neighbors.map(normalizeName));
  const seen = new Set<string>();
  for (const other of elements) {
    if (other === e || other.window !== e.window) continue;
    const oc = center(other);
    if (Math.hypot(oc.x - c.x, oc.y - c.y) > 400) continue;
    for (const n of [...names(other), ...(other.value ? [normalizeName(other.value)] : [])]) {
      if (wanted.has(n)) seen.add(n);
    }
  }
  return seen.size;
}

export interface AxMatch {
  element: AxElement;
  rect: Rect;
}

/** Find the step's target; null when it isn't there or isn't clear-cut. */
export function matchTarget(step: Step, elements: AxElement[]): AxMatch | null {
  if (!step.target || step.action === 'manual' || step.action === 'wait') return null;
  const wanted = targetNames(step);
  if (wanted.length === 0) return null;
  const roles = allowedRoles(step);
  const usable = elements.filter((e) => e.enabled !== false && e.w >= 4 && e.h >= 4);

  let candidates = usable.filter(
    (e) => roles.includes(e.role) && names(e).some((n) => wanted.includes(n)),
  );
  if (candidates.length === 0 && roles === FIELD) {
    candidates = wanted.flatMap((w) => labelledFields(w, usable, roles));
  }
  if (candidates.length === 0) return null;

  // Prefer what the user is looking at: open menus, then windows front to back. The menu bar is
  // always there, so it only wins when nothing else matches.
  const rank = (e: AxElement) =>
    MENU_BAR_ITEM.includes(e.role) ? 1000 : e.window === -1 ? -1 : e.window;
  const best = Math.min(...candidates.map(rank));
  candidates = candidates.filter((e) => rank(e) === best);

  if (candidates.length > 1) {
    const scored = candidates.map((e) => ({
      e,
      s: neighborScore(e, step.target!.neighbors ?? [], usable),
    }));
    const top = Math.max(...scored.map((x) => x.s));
    const winners = scored.filter((x) => x.s === top);
    if (top === 0 || winners.length !== 1) return null;
    candidates = [winners[0]!.e];
  }
  const element = candidates[0]!;
  return { element, rect: rectOf(element) };
}
