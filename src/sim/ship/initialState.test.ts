import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import {
  compileRailsCatalog,
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
} from '../propagation/rails.js';
import { coordinateVelocityInto } from './relativity.js';
import { createNewGameLeoState } from './initialState.js';

const EARTH_MU_KM3_S2 = 398_600.435507;
const EARTH_RADIUS_KM = 6_371.0084;
const LEO_ALTITUDE_KM = 400;

function createCatalog() {
  return compileRailsCatalog([
    { id: 'sun', parentId: null, muKm3S2: 132_712_440_041.9394, elements: null },
    {
      id: 'earth',
      parentId: 'sun',
      muKm3S2: EARTH_MU_KM3_S2,
      elements: {
        semiMajorAxisKm: 149_597_870.7,
        eccentricity: 0,
        inclinationRad: 0,
        longitudeAscendingNodeRad: 0,
        argumentPeriapsisRad: 0,
        meanAnomalyRad: 0,
      },
    },
  ]);
}

describe('createNewGameLeoState', () => {
  it('adds prograde circular LEO velocity to Earth full rails velocity', () => {
    const catalog = createCatalog();
    const rails = createRailsState(catalog);
    evaluateRailsInto(rails, catalog, 0, createRailsWorkspace());

    const state = createNewGameLeoState(
      catalog,
      catalog.bodyIds.indexOf('earth'),
      EARTH_RADIUS_KM,
      LEO_ALTITUDE_KM,
    );
    const coordinateVelocityKmS = new Float64Array(3);
    coordinateVelocityInto(
      coordinateVelocityKmS,
      state[3] as number,
      state[4] as number,
      state[5] as number,
    );

    const earthOffset = 3;
    const earthXKm = rails.positionsKm[earthOffset] as number;
    const earthYKm = rails.positionsKm[earthOffset + 1] as number;
    const earthZKm = rails.positionsKm[earthOffset + 2] as number;
    const earthVxKmS = rails.velocitiesKmS[earthOffset] as number;
    const earthVyKmS = rails.velocitiesKmS[earthOffset + 1] as number;
    const earthVzKmS = rails.velocitiesKmS[earthOffset + 2] as number;
    const earthDistanceKm = Math.hypot(earthXKm, earthYKm, earthZKm);
    const radialX = earthXKm / earthDistanceKm;
    const radialY = earthYKm / earthDistanceKm;
    const radialZ = earthZKm / earthDistanceKm;
    const radiusKm = EARTH_RADIUS_KM + LEO_ALTITUDE_KM;

    expect(state[0]).toBeCloseTo(earthXKm + radialX * radiusKm, 8);
    expect(state[1]).toBeCloseTo(earthYKm + radialY * radiusKm, 8);
    expect(state[2]).toBeCloseTo(earthZKm + radialZ * radiusKm, 8);
    expect(state[6]).toBe(0);

    const relativeVx = (coordinateVelocityKmS[0] as number) - earthVxKmS;
    const relativeVy = (coordinateVelocityKmS[1] as number) - earthVyKmS;
    const relativeVz = (coordinateVelocityKmS[2] as number) - earthVzKmS;
    const circularSpeedKmS = Math.sqrt(EARTH_MU_KM3_S2 / radiusKm);
    expect(Math.hypot(relativeVx, relativeVy, relativeVz)).toBeCloseTo(circularSpeedKmS, 12);
    expect(relativeVx * radialX + relativeVy * radialY + relativeVz * radialZ).toBeCloseTo(0, 12);
    expect(
      Math.hypot(
        coordinateVelocityKmS[0] as number,
        coordinateVelocityKmS[1] as number,
        coordinateVelocityKmS[2] as number,
      ),
    ).toBeGreaterThan(29);
    expect(Math.hypot(state[3] as number, state[4] as number, state[5] as number)).toBeLessThan(
      SPEED_OF_LIGHT_KM_S,
    );
  });

  it('rejects an invalid Earth selection and superluminal initial velocity', () => {
    const catalog = createCatalog();
    expect(() => createNewGameLeoState(catalog, -1, EARTH_RADIUS_KM, LEO_ALTITUDE_KM)).toThrow(
      /Earth index/u,
    );
    expect(() => createNewGameLeoState(catalog, 1, EARTH_RADIUS_KM, -EARTH_RADIUS_KM)).toThrow(
      /orbit radius/u,
    );
  });
});
