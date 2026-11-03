import { describe, expect, it } from 'vitest';
import { drawRingIcon } from './tray-icon';

const alphaAt = (icon: ReturnType<typeof drawRingIcon>, x: number, y: number) =>
  icon.pixels[(y * icon.size + x) * 4 + 3]!;

describe('drawRingIcon', () => {
  it.each([16, 24, 32])('produces a %ipx bitmap', (size) => {
    const icon = drawRingIcon(size, 'template');
    expect(icon.pixels.length).toBe(size * size * 4);
  });

  it('template: opaque centre dot, transparent corners and gap', () => {
    const icon = drawRingIcon(32, 'template');
    expect(alphaAt(icon, 16, 16)).toBeGreaterThan(200); // dot
    expect(alphaAt(icon, 0, 0)).toBe(0); // corner
    expect(alphaAt(icon, 16, 10)).toBe(0); // gap between dot and ring
    expect(alphaAt(icon, 16, 2)).toBeGreaterThan(100); // ring
  });

  it('template pixels are pure black + alpha', () => {
    const icon = drawRingIcon(16, 'template');
    for (let i = 0; i < icon.pixels.length; i += 4) {
      expect(icon.pixels[i]).toBe(0);
    }
  });

  it('light-on-dark: dark disc behind the mark', () => {
    const icon = drawRingIcon(32, 'light-on-dark');
    expect(alphaAt(icon, 16, 10)).toBe(255); // disc fills the gap
    expect(icon.pixels[(10 * 32 + 16) * 4]).toBeLessThan(64); // and it's dark there
    expect(icon.pixels[(16 * 32 + 16) * 4]).toBeGreaterThan(200); // white dot
  });
});
