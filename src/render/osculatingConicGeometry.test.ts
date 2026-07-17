import { describe, expect, it } from 'vitest';

import {
  createCartesianState,
  createOrbitalConversionScratch,
  elementsToStateInto,
  type OrbitalElements,
} from '../sim/bodies/orbitalElements.js';
import type { OsculatingElementsSnapshot } from '../sim/simulationSnapshot.js';
import {
  MAX_OSCULATING_CONIC_SEGMENTS,
  writeOsculatingConicPointsInto,
} from './osculatingConicGeometry.js';

function snapshotElements(
  semiMajorAxisKm: number,
  eccentricity: number,
): OsculatingElementsSnapshot {
  const periapsisRadiusKm = semiMajorAxisKm * (1 - eccentricity);
  return {
    valid: true,
    semiMajorAxisKm,
    eccentricity,
    inclinationRad: 0.7,
    longitudeAscendingNodeRad: 1.2,
    argumentPeriapsisRad: 0.4,
    trueAnomalyRad: 0,
    periapsisRadiusKm,
    apoapsisRadiusKm:
      eccentricity < 1 ? semiMajorAxisKm * (1 + eccentricity) : Number.POSITIVE_INFINITY,
    periodSec: eccentricity < 1 ? 1 : Number.POSITIVE_INFINITY,
  };
}

function ellipticMeanAnomalyFromTrue(trueAnomalyRad: number, eccentricity: number): number {
  const eccentricAnomalyRad =
    2 *
    Math.atan2(
      Math.sqrt(1 - eccentricity) * Math.sin(trueAnomalyRad / 2),
      Math.sqrt(1 + eccentricity) * Math.cos(trueAnomalyRad / 2),
    );
  return eccentricAnomalyRad - eccentricity * Math.sin(eccentricAnomalyRad);
}

describe('osculating conic sampling — physics-spec.md §6', () => {
  it('matches the canonical Cartesian converter for a rotated ellipse', () => {
    const elements = snapshotElements(18_000, 0.4);
    const output = new Float64Array((MAX_OSCULATING_CONIC_SEGMENTS + 1) * 3);

    const pointCount = writeOsculatingConicPointsInto(output, elements);

    expect(pointCount).toBe(129);
    const pointIndex = 32;
    const trueAnomalyRad = -Math.PI / 2;
    const canonicalElements: OrbitalElements = {
      semiMajorAxisKm: elements.semiMajorAxisKm,
      eccentricity: elements.eccentricity,
      inclinationRad: elements.inclinationRad,
      longitudeAscendingNodeRad: elements.longitudeAscendingNodeRad,
      argumentPeriapsisRad: elements.argumentPeriapsisRad,
      meanAnomalyRad: ellipticMeanAnomalyFromTrue(trueAnomalyRad, elements.eccentricity),
    };
    const canonicalState = elementsToStateInto(
      createCartesianState(),
      canonicalElements,
      398_600.4418,
      createOrbitalConversionScratch(),
    );
    const offset = pointIndex * 3;
    expect(output[offset]).toBeCloseTo(canonicalState.positionKm.x, 8);
    expect(output[offset + 1]).toBeCloseTo(canonicalState.positionKm.y, 8);
    expect(output[offset + 2]).toBeCloseTo(canonicalState.positionKm.z, 8);
    expect(output[0]).toBeCloseTo(output[(pointCount - 1) * 3] as number, 10);
    expect(output[1]).toBeCloseTo(output[(pointCount - 1) * 3 + 1] as number, 10);
    expect(output[2]).toBeCloseTo(output[(pointCount - 1) * 3 + 2] as number, 10);
  });

  it('writes a finite open hyperbola without joining its endpoints', () => {
    const elements = snapshotElements(-14_000, 1.5);
    const output = new Float64Array((MAX_OSCULATING_CONIC_SEGMENTS + 1) * 3);

    const pointCount = writeOsculatingConicPointsInto(output, elements);

    expect(pointCount).toBe(257);
    for (let index = 0; index < pointCount * 3; index += 1) {
      expect(Number.isFinite(output[index])).toBe(true);
    }
    const lastOffset = (pointCount - 1) * 3;
    expect(
      Math.hypot(
        (output[0] as number) - (output[lastOffset] as number),
        (output[1] as number) - (output[lastOffset + 1] as number),
        (output[2] as number) - (output[lastOffset + 2] as number),
      ),
    ).toBeGreaterThan(elements.periapsisRadiusKm);
  });

  it('hides invalid and parabolic solutions and rejects undersized storage', () => {
    const invalid = snapshotElements(18_000, 0.2);
    invalid.valid = false;
    const parabolic = snapshotElements(18_000, 1);
    const output = new Float64Array((MAX_OSCULATING_CONIC_SEGMENTS + 1) * 3);

    expect(writeOsculatingConicPointsInto(output, invalid)).toBe(0);
    expect(writeOsculatingConicPointsInto(output, parabolic)).toBe(0);
    expect(() =>
      writeOsculatingConicPointsInto(new Float64Array(3), snapshotElements(1, 0)),
    ).toThrow(RangeError);
  });
});
