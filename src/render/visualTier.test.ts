import { describe, expect, it } from 'vitest';

import { apparentMagnitude, projectedDiameterPx, selectVisualTier } from './visualTier.js';

describe('projectedDiameterPx', () => {
  it('is monotonic as the camera approaches and saturates at a surface crossing', () => {
    const far = projectedDiameterPx(6_371, 149_597_870.7, 1_080, Math.PI / 3);
    const near = projectedDiameterPx(6_371, 6_771, 1_080, Math.PI / 3);
    const inside = projectedDiameterPx(6_371, 0, 1_080, Math.PI / 3);

    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far);
    expect(inside).toBeGreaterThan(near);
    expect(inside).toBeCloseTo(3_240, 10);
  });

  it.each([
    [-1, 1, 1_080, Math.PI / 3],
    [1, -1, 1_080, Math.PI / 3],
    [1, 1, 0, Math.PI / 3],
    [1, 1, 1_080, 0],
    [1, 1, 1_080, Math.PI],
  ])('rejects invalid setup input %#', (radius, distance, height, fov) => {
    expect(() => projectedDiameterPx(radius, distance, height, fov)).toThrow(RangeError);
  });
});

describe('selectVisualTier', () => {
  it('uses the exact point/sphere hysteresis boundaries', () => {
    expect(selectVisualTier(1, 1.79)).toBe(1);
    expect(selectVisualTier(1, 1.8)).toBe(2);
    expect(selectVisualTier(2, 1.2)).toBe(2);
    expect(selectVisualTier(2, 1.19)).toBe(1);
  });

  it('uses the exact sphere/model hysteresis boundaries', () => {
    expect(selectVisualTier(2, 239.99)).toBe(2);
    expect(selectVisualTier(2, 240)).toBe(3);
    expect(selectVisualTier(3, 160)).toBe(3);
    expect(selectVisualTier(3, 159.99)).toBe(2);
  });

  it('permits direct jumps after a large camera step', () => {
    expect(selectVisualTier(1, 240)).toBe(3);
    expect(selectVisualTier(3, 1.19)).toBe(1);
  });

  it('rejects invalid tiers and diameters', () => {
    expect(() => selectVisualTier(0 as 1, 1)).toThrow(RangeError);
    expect(() => selectVisualTier(1, Number.NaN)).toThrow(RangeError);
    expect(() => selectVisualTier(1, -1)).toThrow(RangeError);
  });
});

describe('apparentMagnitude', () => {
  const AU_KM = 149_597_870.7;
  const positionsKm = new Float64Array([0, 0, 0, AU_KM, 0, 0]);

  it('dims a reflected body monotonically with observer distance at full phase', () => {
    const near = apparentMagnitude(1, 0, 6_371, 0.434, positionsKm, {
      x: AU_KM - 1_000_000,
      y: 0,
      z: 0,
    });
    const far = apparentMagnitude(1, 0, 6_371, 0.434, positionsKm, {
      x: AU_KM - 2_000_000,
      y: 0,
      z: 0,
    });

    expect(Number.isFinite(near)).toBe(true);
    expect(far).toBeGreaterThan(near);
  });

  it('returns finite values at the body centre, solar centre, and zero phase', () => {
    expect(
      Number.isFinite(
        apparentMagnitude(1, 0, 6_371, 0.434, positionsKm, {
          x: AU_KM,
          y: 0,
          z: 0,
        }),
      ),
    ).toBe(true);
    expect(
      Number.isFinite(apparentMagnitude(0, 0, 696_340, 1, positionsKm, { x: 0, y: 0, z: 0 })),
    ).toBe(true);
    expect(
      Number.isFinite(
        apparentMagnitude(1, 0, 6_371, 0.434, positionsKm, {
          x: AU_KM + 1_000_000,
          y: 0,
          z: 0,
        }),
      ),
    ).toBe(true);
  });

  it('rejects invalid packed indices and photometric properties', () => {
    expect(() => apparentMagnitude(2, 0, 1, 0.5, positionsKm, { x: 0, y: 0, z: 0 })).toThrow(
      RangeError,
    );
    expect(() => apparentMagnitude(1, 0, 0, 0.5, positionsKm, { x: 0, y: 0, z: 0 })).toThrow(
      RangeError,
    );
    expect(() => apparentMagnitude(1, 0, 1, -0.1, positionsKm, { x: 0, y: 0, z: 0 })).toThrow(
      RangeError,
    );
  });
});
