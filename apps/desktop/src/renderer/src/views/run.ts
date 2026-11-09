import { errorText } from '../labels';

/**
 * Start a guide right away. Steps that depend on the user (e.g. "type the text you want")
 * are explained when they come up, so nothing is asked beforehand.
 */
export async function runGuide(id: string, onError: (msg: string) => void): Promise<void> {
  const r = await window.qhint.guides.run(id, {});
  if (!r.ok) onError(errorText(r.error));
}

const SEEN_KEY = 'qhint.seen';

/** Guides the user has opened at least once (to mark new ones). */
export function seenGuides(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function markSeen(id: string): void {
  const seen = seenGuides();
  if (seen.has(id)) return;
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, id].slice(-500)));
}
