import { describe, expect, it } from 'vitest';

import { qualityMeasurementPlan } from './gasGiantQualityBenchUtils.mjs';

describe('gas giant quality benchmark measurement plan', () => {
  it('uses comparable GPU samples when timer queries exist', () => {
    expect(qualityMeasurementPlan(true)).toEqual({
      enforceMinimumCheaper: true,
      limitation: null,
      method: 'gpu-timer',
    });
  });

  it('records a CPU frame-work fallback without claiming comparable GPU timing', () => {
    expect(qualityMeasurementPlan(false)).toEqual({
      enforceMinimumCheaper: false,
      limitation: 'EXT_disjoint_timer_query_webgl2 unavailable; recorded CPU frame-work timing.',
      method: 'cpu-frame-work',
    });
  });
});
