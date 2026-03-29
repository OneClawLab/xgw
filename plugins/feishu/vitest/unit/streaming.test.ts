import { describe, it, expect } from 'vitest';
import { mergeStreamingText } from '../../src/streaming.js';

describe('mergeStreamingText', () => {
  it('returns next when prev is empty', () => {
    expect(mergeStreamingText('', 'hello')).toBe('hello');
  });

  it('returns prev when next is empty', () => {
    expect(mergeStreamingText('hello', '')).toBe('hello');
  });

  it('returns next when it starts with prev (accumulating chunks)', () => {
    expect(mergeStreamingText('hel', 'hello world')).toBe('hello world');
  });

  it('returns prev when it already contains next (no regression)', () => {
    expect(mergeStreamingText('hello world', 'hello')).toBe('hello world');
  });

  it('merges partial overlap', () => {
    expect(mergeStreamingText('hello', 'lo world')).toBe('hello world');
  });

  it('appends when no overlap', () => {
    expect(mergeStreamingText('foo', 'bar')).toBe('foobar');
  });

  it('handles undefined prev', () => {
    expect(mergeStreamingText(undefined, 'hello')).toBe('hello');
  });

  it('handles undefined next', () => {
    expect(mergeStreamingText('hello', undefined)).toBe('hello');
  });

  it('returns next when equal', () => {
    expect(mergeStreamingText('same', 'same')).toBe('same');
  });
});
