import { describe, expect, it } from 'vitest';

import { compileRailsCatalog } from '../propagation/rails.js';
import { selectDominantBodyIndexWithHysteresis } from './dominantBody.js';

function catalog() {
  return compileRailsCatalog([
    { id: 'sun', parentId: null, muKm3S2: 100, soiRadiusKm: null, elements: null },
    {
      id: 'planet',
      parentId: 'sun',
      muKm3S2: 1,
      soiRadiusKm: 10,
      elements: {
        semiMajorAxisKm: 100,
        eccentricity: 0,
        inclinationRad: 0,
        longitudeAscendingNodeRad: 0,
        argumentPeriapsisRad: 0,
        meanAnomalyRad: 0,
      },
    },
  ]);
}

function shipAt(xKm: number): Float64Array {
  return new Float64Array([xKm, 0, 0]);
}

const BODY_POSITIONS_KM = new Float64Array([0, 0, 0, 100, 0, 0]);

describe('dominant body hysteresis — physics-spec.md §6', () => {
  it('enters a child only inside 0.9 SOI with a ten-percent gravity lead', () => {
    const compiled = catalog();

    expect(selectDominantBodyIndexWithHysteresis(shipAt(108), BODY_POSITIONS_KM, compiled, 0)).toBe(
      1,
    );
    expect(
      selectDominantBodyIndexWithHysteresis(shipAt(91.1), BODY_POSITIONS_KM, compiled, 0),
    ).toBe(0);
  });

  it('retains a child until it exits 1.1 SOI before returning to the parent', () => {
    const compiled = catalog();

    expect(
      selectDominantBodyIndexWithHysteresis(shipAt(89.5), BODY_POSITIONS_KM, compiled, 1),
    ).toBe(1);
    expect(
      selectDominantBodyIndexWithHysteresis(shipAt(88.9), BODY_POSITIONS_KM, compiled, 1),
    ).toBe(0);
  });

  it('uses the raw maximum-gravity body without prior ownership', () => {
    expect(
      selectDominantBodyIndexWithHysteresis(shipAt(108), BODY_POSITIONS_KM, catalog(), -1),
    ).toBe(1);
  });
});
