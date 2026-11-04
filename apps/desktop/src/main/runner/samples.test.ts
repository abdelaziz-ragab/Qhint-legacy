import { describe, expect, it } from 'vitest';
import { SAMPLE_PROCEDURES } from './samples';

describe('sample procedures', () => {
  it('the LibreOffice procedure is valid and has 5 steps with targets', () => {
    const p = SAMPLE_PROCEDURES['libreoffice-insert-table'];
    expect(p.steps).toHaveLength(5);
    expect(p.steps.every((s) => s.target)).toBe(true);
    expect(p.steps[2]).toMatchObject({ action: 'type', input: '4' });
  });
});
