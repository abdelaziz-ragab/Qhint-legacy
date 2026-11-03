import { describe, expect, it } from 'vitest';
import type { DisplayGeometry } from '../coords/coords';
import { matchSourcesToDisplays, type SourceInfo } from './match-sources';

const d = (id: number, x: number, w: number, h: number): DisplayGeometry => ({
  id,
  bounds: { x, y: 0, width: w, height: h },
  workArea: { x, y: 0, width: w, height: h },
  scaleFactor: 1,
});
const src = (id: string, displayId: string, w: number, h: number): SourceInfo => ({
  id,
  displayId,
  thumbnailSize: { width: w, height: h },
});

describe('matchSourcesToDisplays', () => {
  it('matches by display_id when available', () => {
    const displays = [d(10, 0, 1920, 1080), d(20, 1920, 1920, 1080)];
    const sources = [src('screen:1:0', '20', 1280, 720), src('screen:0:0', '10', 1280, 720)];
    expect(matchSourcesToDisplays(sources, displays)).toEqual([
      { displayId: 10, sourceId: 'screen:0:0', method: 'id' },
      { displayId: 20, sourceId: 'screen:1:0', method: 'id' },
    ]);
  });

  it('falls back to shape when display_id is empty and shapes differ', () => {
    const displays = [d(10, 0, 1920, 1080), d(20, 1920, 1080, 1920)];
    const sources = [src('screen:0:0', '', 720, 1280), src('screen:1:0', '', 1280, 720)];
    const m = matchSourcesToDisplays(sources, displays);
    expect(m).toContainEqual({ displayId: 10, sourceId: 'screen:1:0', method: 'shape' });
    expect(m).toContainEqual({ displayId: 20, sourceId: 'screen:0:0', method: 'shape' });
  });

  it('pairs identical shapes by order when counts line up', () => {
    const displays = [d(20, 1920, 1920, 1080), d(10, 0, 1920, 1080)];
    const sources = [src('screen:1:0', '', 1280, 720), src('screen:0:0', '', 1280, 720)];
    expect(matchSourcesToDisplays(sources, displays)).toEqual([
      { displayId: 10, sourceId: 'screen:0:0', method: 'shape' },
      { displayId: 20, sourceId: 'screen:1:0', method: 'shape' },
    ]);
  });

  it('mixes id matches with shape fallback', () => {
    const displays = [d(10, 0, 1920, 1080), d(20, 1920, 1080, 1920)];
    const sources = [src('screen:0:0', '10', 1280, 720), src('screen:1:0', '', 720, 1280)];
    expect(matchSourcesToDisplays(sources, displays)).toEqual([
      { displayId: 10, sourceId: 'screen:0:0', method: 'id' },
      { displayId: 20, sourceId: 'screen:1:0', method: 'shape' },
    ]);
  });

  it('leaves a display out rather than guessing', () => {
    const displays = [d(10, 0, 1920, 1080)];
    const sources = [src('screen:0:0', '', 720, 1280)];
    expect(matchSourcesToDisplays(sources, displays)).toEqual([]);
  });

  it('does not reuse a source', () => {
    const displays = [d(10, 0, 1920, 1080), d(20, 1920, 1920, 1080)];
    const sources = [src('screen:0:0', '10', 1280, 720)];
    expect(matchSourcesToDisplays(sources, displays)).toEqual([
      { displayId: 10, sourceId: 'screen:0:0', method: 'id' },
    ]);
  });
});
