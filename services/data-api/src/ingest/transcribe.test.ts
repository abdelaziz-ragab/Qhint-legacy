import { describe, expect, it } from 'vitest';
import { toSegments } from './transcribe';

describe('toSegments (Google Speech response -> timed transcript)', () => {
  it('times each phrase from its first word', () => {
    expect(
      toSegments({
        results: [
          {
            alternatives: [
              {
                transcript: ' Open the File menu.',
                words: [{ startTime: '1.200s' }, { startTime: '1.500s' }],
              },
            ],
            resultEndTime: '2.900s',
          },
          { alternatives: [{ transcript: '' }], resultEndTime: '3.100s' },
          { alternatives: [{ transcript: 'Then choose Open.' }], resultEndTime: '5s' },
        ],
      }),
    ).toEqual([
      { start: 1.2, end: 2.9, text: 'Open the File menu.' },
      // no word times: starts where the previous phrase ended
      { start: 2.9, end: 5, text: 'Then choose Open.' },
    ]);
  });

  it('shifts times by the chunk’s position in the video', () => {
    expect(
      toSegments({ results: [{ alternatives: [{ transcript: 'Hi' }], resultEndTime: '2s' }] }, 55),
    ).toEqual([{ start: 55, end: 57, text: 'Hi' }]);
  });

  it('handles an empty response', () => {
    expect(toSegments({})).toEqual([]);
  });
});
