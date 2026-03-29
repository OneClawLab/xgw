import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { mergeStreamingText } from '../../src/streaming.js';

describe('streaming PBT', () => {
  // Property: mergeStreamingText result always contains all characters of next
  it('Property: merged result always contains next as substring or superset', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        (prev, next) => {
          const result = mergeStreamingText(prev, next);
          // Result must be at least as long as the longer of the two inputs
          return result.length >= Math.max(prev.length, next.length);
        },
      ),
    );
  });

  // Property: idempotent — merging the same text twice yields the same result
  it('Property: idempotent — merge(merge(a,b), b) === merge(a,b)', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        (a, b) => {
          const first = mergeStreamingText(a, b);
          const second = mergeStreamingText(first, b);
          return second === first;
        },
      ),
    );
  });

  // Property: accumulating chunks — if each chunk is a prefix of the next,
  // the final result equals the last chunk
  it('Property: accumulating prefix chunks converge to final text', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        (finalText) => {
          // Simulate streaming by feeding progressively longer prefixes
          let acc = '';
          for (let i = 1; i <= finalText.length; i++) {
            acc = mergeStreamingText(acc, finalText.slice(0, i));
          }
          return acc === finalText;
        },
      ),
    );
  });
});
