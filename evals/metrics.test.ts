import { describe, it, expect } from 'vitest';
import { recallAtK, percentile, p50, p95 } from './metrics';

describe('recallAtK', () => {
  it('returns 1 when the relevant set is empty (vacuously satisfied)', () => {
    expect(recallAtK([], [])).toBe(1);
    expect(recallAtK([1, 2], [])).toBe(1);
  });

  it('returns 1 when all relevant ids are retrieved', () => {
    expect(recallAtK([1, 2, 3], [1, 2])).toBe(1);
    expect(recallAtK([3, 1, 2], [1, 2, 3])).toBe(1);
  });

  it('returns the correct fraction when some are retrieved', () => {
    expect(recallAtK([1, 4], [1, 2, 3])).toBeCloseTo(1 / 3);
    expect(recallAtK([1, 2, 4, 5], [1, 2, 3])).toBeCloseTo(2 / 3);
  });

  it('returns 0 when no relevant ids are retrieved', () => {
    expect(recallAtK([4, 5, 6], [1, 2, 3])).toBe(0);
  });

  it('ignores irrelevant retrieved ids', () => {
    expect(recallAtK([1, 2, 99], [1, 2])).toBe(1);
  });
});

describe('percentile', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('returns the single value for a length-1 array', () => {
    expect(percentile([42], 0.5)).toBe(42);
  });

  it('p50 picks the middle value (odd length)', () => {
    expect(p50([1, 2, 3, 4, 5])).toBe(3);
  });

  it('p50 picks the upper-middle value (even length, no interpolation)', () => {
    expect(p50([1, 2, 3, 4])).toBe(3);
  });

  it('p95 picks near-max for length-10', () => {
    expect(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
  });

  it('does not mutate the input array', () => {
    const input = [3, 1, 2];
    p50(input);
    expect(input).toEqual([3, 1, 2]);
  });
});
