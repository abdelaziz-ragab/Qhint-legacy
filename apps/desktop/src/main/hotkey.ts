/** Global hotkey selection. Pure; the register function is injected. */

export function hotkeyCandidates(platform: NodeJS.Platform): string[] {
  // macOS: Ctrl+Space / Ctrl+Option+Space switch input sources, Cmd+Shift+Space is taken.
  // Windows: Ctrl+Shift+Space is used by 1Password and Excel; Alt+Space opens the window menu.
  return platform === 'darwin'
    ? ['Control+Shift+Space', 'Control+Alt+Shift+Space']
    : ['Control+Alt+Space', 'Control+Alt+Shift+Space'];
}

/** Display form for menus: "⌃⇧Space" on macOS, "Ctrl+Alt+Space" elsewhere. */
export function formatAccelerator(accelerator: string, platform: NodeJS.Platform): string {
  if (platform !== 'darwin') return accelerator.replace('Control', 'Ctrl');
  const symbols: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
  return accelerator
    .split('+')
    .map((k) => symbols[k] ?? k)
    .join('');
}

/** Registers the first candidate that the OS accepts; null if all are taken. */
export function registerFirstAvailable(
  candidates: string[],
  register: (accelerator: string) => boolean,
): { accelerator: string; isFallback: boolean } | null {
  for (const [i, accelerator] of candidates.entries()) {
    if (register(accelerator)) return { accelerator, isFallback: i > 0 };
  }
  return null;
}
