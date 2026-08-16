import { describe, expect, it } from 'vitest';

import { BUDGET_LIMITS } from '../checks/assetBudgets.mjs';
import { CATEGORY_CONFIG, SURFACE_DETAIL_CONFIG, assetByteBudget, triangleLimitFor } from './config.mjs';

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

describe('small-body budgets', () => {
  it('caps asteroids and comets at 5,000 triangles', () => {
    expect(CATEGORY_CONFIG.asteroids.triangleLimit).toBe(5_000);
    expect(CATEGORY_CONFIG.comets.triangleLimit).toBe(5_000);
    for (const id of ['vesta', 'pallas', 'hygiea', 'eros', 'bennu', 'ryugu']) {
      expect(triangleLimitFor('asteroids', id)).toBe(5_000);
    }
    for (const id of ['1p', '67p']) {
      expect(triangleLimitFor('comets', id)).toBe(5_000);
    }
  });

  it('agrees with the published-manifest triangle gate', () => {
    expect(BUDGET_LIMITS.smallModelTriangles).toBe(CATEGORY_CONFIG.asteroids.triangleLimit);
    expect(BUDGET_LIMITS.smallModelTriangles).toBe(CATEGORY_CONFIG.comets.triangleLimit);
  });

  it('keeps small bodies inside the 1 MiB per-body byte budget', () => {
    expect(assetByteBudget('asteroids', 'eros')).toBe(1024 * 1024);
    expect(assetByteBudget('comets', '67p')).toBe(1024 * 1024);
  });
});
