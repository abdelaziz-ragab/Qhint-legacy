import { describe, expect, it } from 'vitest';
import { formatAccelerator, hotkeyCandidates, registerFirstAvailable } from './hotkey';

describe('hotkey', () => {
  it('uses platform-specific defaults', () => {
    expect(hotkeyCandidates('darwin')[0]).toBe('Control+Shift+Space');
    expect(hotkeyCandidates('win32')[0]).toBe('Control+Alt+Space');
  });

  it('never proposes known-conflicting combos', () => {
    expect(hotkeyCandidates('darwin')).not.toContain('Command+Shift+Space');
    expect(hotkeyCandidates('darwin')).not.toContain('Control+Alt+Space');
    expect(hotkeyCandidates('win32')).not.toContain('Control+Shift+Space');
  });

  it('falls back when the first combo is taken', () => {
    const taken = new Set(['Control+Alt+Space']);
    const r = registerFirstAvailable(hotkeyCandidates('win32'), (a) => !taken.has(a));
    expect(r).toEqual({ accelerator: 'Control+Alt+Shift+Space', isFallback: true });
  });

  it('returns null when everything is taken', () => {
    expect(registerFirstAvailable(hotkeyCandidates('darwin'), () => false)).toBeNull();
  });

  it('formats for menus', () => {
    expect(formatAccelerator('Control+Shift+Space', 'darwin')).toBe('⌃⇧Space');
    expect(formatAccelerator('Control+Alt+Space', 'win32')).toBe('Ctrl+Alt+Space');
  });
});
