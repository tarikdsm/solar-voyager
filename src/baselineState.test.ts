import { describe, expect, it } from 'vitest';

import { advanceBaselineAngle } from './baselineState.js';

describe('advanceBaselineAngle', () => {
  it('advances rotation proportionally to elapsed time', () => {
    expect(advanceBaselineAngle(0.5, 250)).toBeCloseTo(0.75, 12);
  });

  it('wraps rotation after a complete turn', () => {
    expect(advanceBaselineAngle(Math.PI * 2 - 0.1, 200)).toBeCloseTo(0.1, 12);
  });
});
