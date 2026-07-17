import { describe, expect, it } from 'vitest';

import { qualityRunOrder, summarizeQualitySamples } from './proceduralSunQualityBenchUtils.mjs';

describe('procedural Sun quality benchmark utilities', () => {
  it('alternates quality order to limit clock-order bias', () => {
    expect(qualityRunOrder()).toEqual(['full', 'minimum', 'minimum', 'full']);
  });

  it('summarizes interpolated percentiles and identifies the cheaper rung', () => {
    expect(
      summarizeQualitySamples({
        full: [2, 4, 6, 8],
        minimum: [1, 2, 3, 4],
      }),
    ).toMatchObject({
      full: { sampleCount: 4, p50Ms: 5, p75Ms: 6.5, p99Ms: 7.94 },
      minimum: { sampleCount: 4, p50Ms: 2.5, p75Ms: 3.25, p99Ms: 3.97 },
      minimumCheaper: true,
    });
  });

  it('rejects empty, non-finite, and non-positive sample sets', () => {
    expect(() => summarizeQualitySamples({ full: [], minimum: [1] })).toThrow(RangeError);
    expect(() => summarizeQualitySamples({ full: [Number.NaN], minimum: [1] })).toThrow(RangeError);
    expect(() => summarizeQualitySamples({ full: [1], minimum: [0] })).toThrow(RangeError);
  });
});
