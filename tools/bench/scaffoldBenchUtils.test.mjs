import { describe, expect, it } from 'vitest';

import { percentile } from './scaffoldBenchUtils.mjs';

describe('percentile', () => {
  it('interpolates between adjacent sorted samples', () => {
    expect(percentile([10, 20, 30, 40], 0.75)).toBe(32.5);
  });

  it('rejects an empty sample set', () => {
    expect(() => percentile([], 0.5)).toThrow('without frame samples');
  });
});
