import { describe, expect, it } from 'vitest';

import { AU_KM, SPEED_OF_LIGHT_KM_S } from './constants.js';

describe('body-independent constants — physics-spec.md §1', () => {
  it('uses the exact astronomical unit in kilometers', () => {
    expect(AU_KM).toBe(149_597_870.7);
  });

  it('uses the exact speed of light in kilometers per second', () => {
    expect(SPEED_OF_LIGHT_KM_S).toBe(299_792.458);
  });
});
