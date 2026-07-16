import { describe, expect, it } from 'vitest';

import bodiesDocument from '../../../data/bodies.json';
import { evaluateNBodyAccelerationInto } from '../../../src/sim/propagation/nbodyForces.js';

function requireBody(id: string) {
  const body = bodiesDocument.bodies.find((candidate) => candidate.id === id);
  if (body === undefined) {
    throw new Error(`missing baked body ${id}`);
  }
  return body;
}

describe('Earth-Sun L1 — physics-spec.md §3 / §7.12', () => {
  it('has near-zero normalized acceleration in the circular rotating frame', () => {
    const sun = requireBody('sun');
    const earth = requireBody('earth');
    if (earth.elements === null) {
      throw new Error('Earth must have baked orbital elements');
    }
    const sunMuKm3S2 = sun.muKm3S2;
    const earthMuKm3S2 = earth.muKm3S2;
    const separationKm = earth.elements.semiMajorAxisKm;
    const totalMuKm3S2 = sunMuKm3S2 + earthMuKm3S2;
    const sunXKm = (-separationKm * earthMuKm3S2) / totalMuKm3S2;
    const earthXKm = (separationKm * sunMuKm3S2) / totalMuKm3S2;
    const meanMotionSquaredS2 = totalMuKm3S2 / separationKm ** 3;

    function independentRotatingResidualKmS2(xKm: number): number {
      const sunDxKm = sunXKm - xKm;
      const earthDxKm = earthXKm - xKm;
      const sunAccelerationKmS2 = (sunMuKm3S2 * sunDxKm) / Math.abs(sunDxKm) ** 3;
      const earthAccelerationKmS2 = (earthMuKm3S2 * earthDxKm) / Math.abs(earthDxKm) ** 3;
      return sunAccelerationKmS2 + earthAccelerationKmS2 + meanMotionSquaredS2 * xKm;
    }

    const hillEstimateKm = separationKm * Math.cbrt(earthMuKm3S2 / (3 * sunMuKm3S2));
    let leftXKm = earthXKm - 2 * hillEstimateKm;
    let rightXKm = earthXKm - 0.5 * hillEstimateKm;
    expect(independentRotatingResidualKmS2(leftXKm)).toBeLessThan(0);
    expect(independentRotatingResidualKmS2(rightXKm)).toBeGreaterThan(0);

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const middleXKm = (leftXKm + rightXKm) / 2;
      if (independentRotatingResidualKmS2(middleXKm) < 0) {
        leftXKm = middleXKm;
      } else {
        rightXKm = middleXKm;
      }
    }
    const l1XKm = (leftXKm + rightXKm) / 2;
    const distanceFromEarthKm = earthXKm - l1XKm;
    expect(distanceFromEarthKm).toBeGreaterThan(1_400_000);
    expect(distanceFromEarthKm).toBeLessThan(1_600_000);

    const gravityKmS2 = new Float64Array(3);
    evaluateNBodyAccelerationInto(
      gravityKmS2,
      new Float64Array([l1XKm, 0, 0]),
      new Float64Array([sunMuKm3S2, earthMuKm3S2]),
      new Float64Array([sunXKm, 0, 0, earthXKm, 0, 0]),
    );
    const gravityXKmS2 = gravityKmS2[0] as number;
    const centrifugalXKmS2 = meanMotionSquaredS2 * l1XKm;
    const normalizedResidual =
      Math.abs(gravityXKmS2 + centrifugalXKmS2) /
      Math.max(Math.abs(gravityXKmS2), Math.abs(centrifugalXKmS2));

    process.stdout.write(
      `Earth-Sun L1: ${distanceFromEarthKm.toFixed(3)} km from Earth, residual ${normalizedResidual.toExponential(3)}\n`,
    );
    expect(normalizedResidual).toBeLessThan(1e-10);
    expect(gravityKmS2[1]).toBe(0);
    expect(gravityKmS2[2]).toBe(0);
  });
});
