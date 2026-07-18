import { describe, expect, it } from 'vitest';

import { generateGasDetailPair } from './generateGasDetailTextures.mjs';

describe('gas detail texture generator', () => {
  it('is deterministic per seed and emits RGB pairs', () => {
    const first = generateGasDetailPair(599, 32);
    const second = generateGasDetailPair(599, 32);
    expect(first.albedo).toEqual(second.albedo);
    expect(first.normal).toEqual(second.normal);
    expect(first.albedo).toHaveLength(32 * 32 * 3);
    expect(first.normal).toHaveLength(32 * 32 * 3);
  });

  it('changes with the seed while keeping normal channels bounded', () => {
    const jupiter = generateGasDetailPair(599, 32);
    const neptune = generateGasDetailPair(899, 32);
    expect(jupiter.albedo).not.toEqual(neptune.albedo);
    expect(Math.min(...jupiter.normal)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...jupiter.normal)).toBeLessThanOrEqual(255);
  });
});
