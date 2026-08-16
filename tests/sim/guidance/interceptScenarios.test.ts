import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../../src/core/constants.js';
import {
  createCompiledRails,
  createInterceptSolution,
  solveInterceptInto,
  type ArrivalIntent,
  type CompiledRails,
  type InterceptSolution,
} from '../../../src/sim/guidance/constantAccelIntercept.js';
import {
  compileRailsCatalog,
  evaluateRailsInto,
  type RailsBodyInput,
} from '../../../src/sim/propagation/rails.js';
import { createNewGameLeoState } from '../../../src/sim/ship/initialState.js';
import {
  RELATIVISTIC_STATE_DIMENSION,
  STATE_RX,
  STATE_RY,
  STATE_RZ,
  STATE_UX,
  STATE_UY,
  STATE_UZ,
} from '../../../src/sim/ship/relativity.js';
import { DEFAULT_VESSEL } from '../../../src/sim/ship/vessel.js';
import { flyInterceptProfile } from './profileHarness.js';

interface CatalogFile {
  readonly bodies: readonly (RailsBodyInput & { readonly meanRadiusKm: number })[];
}

const catalogFile = JSON.parse(
  readFileSync(new URL('../../../data/bodies.json', import.meta.url), 'utf8'),
) as CatalogFile;
const catalog = compileRailsCatalog(catalogFile.bodies);
const rails: CompiledRails = createCompiledRails(catalog);

const ALPHA_MS2 = DEFAULT_VESSEL.alphaMaxMS2;
const EARTH_MEAN_RADIUS_KM = 6_371.0084;
const LEO_ALTITUDE_KM = 400;
const ACCEPTANCE_ITERATION_LIMIT = 12;
const ACCEPTANCE_MISS_FRACTION = 1e-3;
const SOLAR_RADIUS_KM = 695_700;

function bodyIndex(bodyId: string): number {
  const index = catalog.bodyIds.indexOf(bodyId);
  if (index < 0) throw new Error(`unknown body: ${bodyId}`);
  return index;
}

/** Ring-aware stand-off altitudes: 1.2 x outer ring radius, physics-spec §8.5. */
const RING_OUTER_RADIUS_KM: Readonly<Record<string, number>> = {
  jupiter: 270_000,
  saturn: 140_612,
  uranus: 106_200,
  neptune: 62_940.5,
};

function altitudeForRingedGiantKm(bodyId: string): number {
  const outerKm = RING_OUTER_RADIUS_KM[bodyId] as number;
  return 1.2 * outerKm - (catalog.collisionRadiiKm[bodyIndex(bodyId)] as number);
}

/** A 400 km circular orbit over Earth's north ecliptic pole (high-inclination start). */
function createPolarLeoState(): Float64Array {
  evaluateRailsInto(rails.scratchState, catalog, 0, rails.scratchWorkspace);
  const offset = bodyIndex('earth') * 3;
  const earthXKm = rails.scratchState.positionsKm[offset] as number;
  const earthYKm = rails.scratchState.positionsKm[offset + 1] as number;
  const earthZKm = rails.scratchState.positionsKm[offset + 2] as number;
  const radiusKm = EARTH_MEAN_RADIUS_KM + LEO_ALTITUDE_KM;
  const circularKmS = Math.sqrt((catalog.muKm3S2[bodyIndex('earth')] as number) / radiusKm);
  const planarKm = Math.hypot(earthXKm, earthYKm);
  const velocityXKmS =
    (rails.scratchState.velocitiesKmS[offset] as number) + (earthXKm / planarKm) * circularKmS;
  const velocityYKmS =
    (rails.scratchState.velocitiesKmS[offset + 1] as number) + (earthYKm / planarKm) * circularKmS;
  const velocityZKmS = rails.scratchState.velocitiesKmS[offset + 2] as number;
  const speedKmS = Math.hypot(velocityXKmS, velocityYKmS, velocityZKmS);
  const gamma = 1 / Math.sqrt(1 - (speedKmS / SPEED_OF_LIGHT_KM_S) ** 2);

  const state = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
  state[STATE_RX] = earthXKm;
  state[STATE_RY] = earthYKm;
  state[STATE_RZ] = earthZKm + radiusKm;
  state[STATE_UX] = gamma * velocityXKmS;
  state[STATE_UY] = gamma * velocityYKmS;
  state[STATE_UZ] = gamma * velocityZKmS;
  return state;
}

/** Distance from the flown endpoint to the aim point the solution promised. */
function arrivalMissKm(
  finalState: Float64Array,
  solution: InterceptSolution,
  targetIndex: number,
  startSimTimeSec: number,
): number {
  evaluateRailsInto(
    rails.scratchState,
    catalog,
    startSimTimeSec + solution.totalCoordSec,
    rails.scratchWorkspace,
  );
  const offset = targetIndex * 3;
  return Math.hypot(
    (finalState[STATE_RX] as number) -
      ((rails.scratchState.positionsKm[offset] as number) -
        solution.arrivalRadiusKm * (solution.aimUnit[0] as number)),
    (finalState[STATE_RY] as number) -
      ((rails.scratchState.positionsKm[offset + 1] as number) -
        solution.arrivalRadiusKm * (solution.aimUnit[1] as number)),
    (finalState[STATE_RZ] as number) -
      ((rails.scratchState.positionsKm[offset + 2] as number) -
        solution.arrivalRadiusKm * (solution.aimUnit[2] as number)),
  );
}

interface Route {
  readonly label: string;
  readonly bodyId: string;
  readonly arrival: ArrivalIntent;
  readonly altitudeKm: number;
  readonly polarStart: boolean;
  readonly expectedDays: readonly [number, number];
}

const ROUTES: readonly Route[] = [
  {
    label: 'LEO -> Moon (orbit)',
    bodyId: 'moon',
    arrival: 'orbit',
    altitudeKm: 0,
    polarStart: false,
    expectedDays: [0.03, 0.06],
  },
  {
    label: 'LEO -> Mars (orbit)',
    bodyId: 'mars',
    arrival: 'orbit',
    altitudeKm: 0,
    polarStart: false,
    expectedDays: [1.0, 1.8],
  },
  {
    label: 'LEO -> Jupiter (outside the rings)',
    bodyId: 'jupiter',
    arrival: 'orbit',
    altitudeKm: altitudeForRingedGiantKm('jupiter'),
    polarStart: false,
    expectedDays: [1.5, 2.3],
  },
  {
    label: 'LEO -> Neptune (outside the rings)',
    bodyId: 'neptune',
    arrival: 'orbit',
    altitudeKm: altitudeForRingedGiantKm('neptune'),
    polarStart: false,
    expectedDays: [4.5, 5.5],
  },
  {
    label: 'LEO -> Sun polar flyby (25 solar radii)',
    bodyId: 'sun',
    arrival: 'flyby',
    altitudeKm: 25 * SOLAR_RADIUS_KM - SOLAR_RADIUS_KM,
    polarStart: true,
    expectedDays: [0.6, 1.2],
  },
];

describe('constant-acceleration intercept scenarios — physics-spec §8.4', () => {
  const leoState = createNewGameLeoState(
    catalog,
    bodyIndex('earth'),
    EARTH_MEAN_RADIUS_KM,
    LEO_ALTITUDE_KM,
  );
  const polarState = createPolarLeoState();

  for (const route of ROUTES) {
    it(`${route.label} converges and arrives`, () => {
      const shipState = route.polarStart ? polarState : leoState;
      const targetIndex = bodyIndex(route.bodyId);
      const solution = createInterceptSolution();

      solveInterceptInto(
        solution,
        shipState,
        rails,
        targetIndex,
        ALPHA_MS2,
        route.arrival,
        route.altitudeKm,
        0,
      );

      expect(solution.ok).toBe(true);
      expect(solution.iterations).toBeLessThanOrEqual(ACCEPTANCE_ITERATION_LIMIT);
      expect(solution.flipAtCoordSec).toBe(solution.totalCoordSec / 2);
      expect(solution.totalProperSec).toBeLessThan(solution.totalCoordSec);
      expect(solution.peakBeta).toBeGreaterThan(0);
      expect(solution.peakBeta).toBeLessThan(1);
      expect(Math.hypot(...solution.aimUnit)).toBeCloseTo(1, 15);

      const days = solution.totalCoordSec / 86_400;
      expect(days).toBeGreaterThan(route.expectedDays[0]);
      expect(days).toBeLessThan(route.expectedDays[1]);

      const finalState = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
      expect(flyInterceptProfile(finalState, shipState, solution, ALPHA_MS2, 0, 1)).toBe(true);

      // Drift-frame trip length, d = 2(c²/α)(γ_peak−1), in the rationalised form
      // that keeps its digits for the shallow Moon hop as well as the Neptune run.
      const depth = ((ALPHA_MS2 / 1_000) * solution.flipAtCoordSec) / SPEED_OF_LIGHT_KM_S;
      const flownDistanceKm =
        ((2 * SPEED_OF_LIGHT_KM_S * SPEED_OF_LIGHT_KM_S) / (ALPHA_MS2 / 1_000)) *
        ((depth * depth) / (1 + Math.hypot(1, depth)));
      expect(arrivalMissKm(finalState, solution, targetIndex, 0)).toBeLessThan(
        ACCEPTANCE_MISS_FRACTION * flownDistanceKm,
      );
    });
  }

  it('the Sun-polar flyby arrives above the ecliptic-north hemisphere it departed from', () => {
    const targetIndex = bodyIndex('sun');
    const solution = createInterceptSolution();
    solveInterceptInto(
      solution,
      polarState,
      rails,
      targetIndex,
      ALPHA_MS2,
      'flyby',
      24 * SOLAR_RADIUS_KM,
      0,
    );
    expect(solution.ok).toBe(true);
    const finalState = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    expect(flyInterceptProfile(finalState, polarState, solution, ALPHA_MS2, 0, 1)).toBe(true);
    const arrivalRadiusKm = Math.hypot(
      finalState[STATE_RX] as number,
      finalState[STATE_RY] as number,
      finalState[STATE_RZ] as number,
    );
    expect(Math.abs(arrivalRadiusKm / (25 * SOLAR_RADIUS_KM) - 1)).toBeLessThan(1e-5);
  });

  it('rejects a mid-cruise re-solve rather than returning a spurious fly-past root', () => {
    const targetIndex = bodyIndex('neptune');
    const departure = createInterceptSolution();
    solveInterceptInto(
      departure,
      leoState,
      rails,
      targetIndex,
      ALPHA_MS2,
      'orbit',
      altitudeForRingedGiantKm('neptune'),
      0,
    );
    expect(departure.ok).toBe(true);

    const midCruise = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const reSolved = createInterceptSolution();
    for (const fraction of [0.25, 0.5, 0.75, 0.9]) {
      expect(flyInterceptProfile(midCruise, leoState, departure, ALPHA_MS2, 0, fraction)).toBe(
        true,
      );
      const celerityKmS = Math.hypot(
        midCruise[STATE_UX] as number,
        midCruise[STATE_UY] as number,
        midCruise[STATE_UZ] as number,
      );
      expect(celerityKmS).toBeGreaterThan(1_000);

      solveInterceptInto(
        reSolved,
        midCruise,
        rails,
        targetIndex,
        ALPHA_MS2,
        'orbit',
        altitudeForRingedGiantKm('neptune'),
        departure.totalCoordSec * fraction,
      );
      expect(reSolved.ok).toBe(false);
    }
  });

  it('an early re-solve, while still slow, still converges', () => {
    const targetIndex = bodyIndex('jupiter');
    const altitudeKm = altitudeForRingedGiantKm('jupiter');
    const departure = createInterceptSolution();
    solveInterceptInto(departure, leoState, rails, targetIndex, ALPHA_MS2, 'orbit', altitudeKm, 0);
    expect(departure.ok).toBe(true);

    const early = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    expect(flyInterceptProfile(early, leoState, departure, ALPHA_MS2, 0, 0.002)).toBe(true);
    const reSolved = createInterceptSolution();
    solveInterceptInto(
      reSolved,
      early,
      rails,
      targetIndex,
      ALPHA_MS2,
      'orbit',
      altitudeKm,
      departure.totalCoordSec * 0.002,
    );
    expect(reSolved.ok).toBe(true);
    expect(reSolved.iterations).toBeLessThanOrEqual(ACCEPTANCE_ITERATION_LIMIT);
  });
});
