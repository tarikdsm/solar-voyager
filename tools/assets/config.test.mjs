import { describe, expect, it } from 'vitest';

import { SURFACE_DETAIL_CONFIG } from './config.mjs';

describe('asset detail metadata', () => {
  it('defines deterministic scale and seed for every ringed giant', () => {
    expect(SURFACE_DETAIL_CONFIG).toMatchObject({
      jupiter: { tilesPerEquator: 32, seed: 599 },
      saturn: { tilesPerEquator: 32, seed: 699 },
      uranus: { tilesPerEquator: 32, seed: 799 },
      neptune: { tilesPerEquator: 32, seed: 899 },
    });
  });
});
