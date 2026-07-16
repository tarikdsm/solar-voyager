import { describe, expect, it } from 'vitest';

import { evaluateNBodyAccelerationInto } from './nbodyForces.js';

const EARTH_MU_KM3_S2 = 398_600.435507;

describe('n-body gravity field — physics-spec.md §3', () => {
  it('matches analytic single-body inverse-square acceleration', () => {
    const radiusKm = 7_000;
    const output = new Float64Array(3);

    const returned = evaluateNBodyAccelerationInto(
      output,
      new Float64Array([radiusKm, 0, 0]),
      new Float64Array([EARTH_MU_KM3_S2]),
      new Float64Array([0, 0, 0]),
    );

    const expectedXKmS2 = -EARTH_MU_KM3_S2 / radiusKm ** 2;
    const relativeError = Math.abs(((output[0] as number) - expectedXKmS2) / expectedXKmS2);
    expect(returned).toBe(output);
    expect(relativeError).toBeLessThan(1e-14);
    expect(output[1]).toBe(0);
    expect(output[2]).toBe(0);
  });

  it('uses the normalized relative direction for a three-dimensional point', () => {
    const point = new Float64Array([4_000, -5_000, 6_000]);
    const bodyPosition = new Float64Array([-1_000, 2_000, 3_000]);
    const output = new Float64Array(3);
    const dxKm = (bodyPosition[0] as number) - (point[0] as number);
    const dyKm = (bodyPosition[1] as number) - (point[1] as number);
    const dzKm = (bodyPosition[2] as number) - (point[2] as number);
    const distanceKm = Math.hypot(dxKm, dyKm, dzKm);
    const factorS2 = EARTH_MU_KM3_S2 / distanceKm ** 3;

    evaluateNBodyAccelerationInto(output, point, new Float64Array([EARTH_MU_KM3_S2]), bodyPosition);

    expect(output[0]).toBeCloseTo(dxKm * factorS2, 15);
    expect(output[1]).toBeCloseTo(dyKm * factorS2, 15);
    expect(output[2]).toBeCloseTo(dzKm * factorS2, 15);
  });

  it('sums every body and preserves symmetric cancellation', () => {
    const output = new Float64Array(3);

    evaluateNBodyAccelerationInto(
      output,
      new Float64Array([0, 0, 0]),
      new Float64Array([10, 10, 5]),
      new Float64Array([-2, 0, 0, 2, 0, 0, 0, 3, 0]),
    );

    expect(output[0]).toBe(0);
    expect(output[1]).toBeCloseTo(5 / 9, 15);
    expect(output[2]).toBe(0);
  });

  it('overwrites output with zero for an empty field', () => {
    const output = new Float64Array([1, 2, 3]);

    evaluateNBodyAccelerationInto(
      output,
      new Float64Array([4, 5, 6]),
      new Float64Array(0),
      new Float64Array(0),
    );

    expect([...output]).toEqual([0, 0, 0]);
  });

  it('allows output to alias the point array', () => {
    const pointAndOutput = new Float64Array([7_000, 0, 0]);
    const expectedXKmS2 = -EARTH_MU_KM3_S2 / 7_000 ** 2;

    evaluateNBodyAccelerationInto(
      pointAndOutput,
      pointAndOutput,
      new Float64Array([EARTH_MU_KM3_S2]),
      new Float64Array([0, 0, 0]),
    );

    expect(pointAndOutput[0]).toBeCloseTo(expectedXKmS2, 15);
    expect(pointAndOutput[1]).toBe(0);
    expect(pointAndOutput[2]).toBe(0);
  });

  it('returns explicit NaN acceleration at a point-mass singularity', () => {
    const output = new Float64Array(3);

    evaluateNBodyAccelerationInto(
      output,
      new Float64Array([1, 2, 3]),
      new Float64Array([1, 2]),
      new Float64Array([0, 0, 0, 1, 2, 3]),
    );

    expect([...output].every(Number.isNaN)).toBe(true);
  });

  it('rejects invalid point, output, and packed-body array lengths', () => {
    expect(() =>
      evaluateNBodyAccelerationInto(
        new Float64Array(2),
        new Float64Array(3),
        new Float64Array(0),
        new Float64Array(0),
      ),
    ).toThrow(/output must contain at least 3 components/u);
    expect(() =>
      evaluateNBodyAccelerationInto(
        new Float64Array(3),
        new Float64Array(2),
        new Float64Array(0),
        new Float64Array(0),
      ),
    ).toThrow(/point must contain at least 3 components/u);
    expect(() =>
      evaluateNBodyAccelerationInto(
        new Float64Array(3),
        new Float64Array(3),
        new Float64Array(2),
        new Float64Array(3),
      ),
    ).toThrow(/body positions must contain 6 components/u);
  });
});
