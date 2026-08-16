import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../../src/core/constants.js';
import {
  brachistochroneHalfCoordSec,
  createCompiledRails,
  createInterceptSolution,
  MAX_INTERCEPT_ITERATIONS,
  ORBIT_ARRIVAL_RADIUS_FACTOR,
  solveInterceptInto,
  type CompiledRails,
} from '../../../src/sim/guidance/constantAccelIntercept.js';
import { compileRailsCatalog } from '../../../src/sim/propagation/rails.js';
import {
  RELATIVISTIC_STATE_DIMENSION,
  STATE_RX,
  STATE_RY,
  STATE_RZ,
  STATE_TAU,
  STATE_UX,
  STATE_UY,
  STATE_UZ,
} from '../../../src/sim/ship/relativity.js';
import { flyInterceptProfile } from './profileHarness.js';

const ALPHA_MS2 = 98.0665;
const ALPHA_KM_S2 = ALPHA_MS2 / 1_000;
const ANCHOR_RADIUS_KM = 1_000;
const c = SPEED_OF_LIGHT_KM_S;

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected));
}

/** One root body at the frame origin: a target that never moves. */
function staticRails(meanRadiusKm = ANCHOR_RADIUS_KM): CompiledRails {
  return createCompiledRails(
    compileRailsCatalog([
      { id: 'anchor', parentId: null, muKm3S2: 1_000, elements: null, meanRadiusKm },
    ]),
  );
}

/** The same anchor with no catalogued radius, so no stand-off can be derived. */
function sizelessRails(): CompiledRails {
  return createCompiledRails(
    compileRailsCatalog([{ id: 'anchor', parentId: null, muKm3S2: 1_000, elements: null }]),
  );
}

function shipAt(distanceKm: number, velocityKmS: readonly [number, number, number]): Float64Array {
  const state = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
  const speedKmS = Math.hypot(...velocityKmS);
  const gamma = 1 / Math.sqrt(1 - (speedKmS / c) ** 2);
  state[STATE_RX] = distanceKm;
  state[STATE_UX] = gamma * velocityKmS[0];
  state[STATE_UY] = gamma * velocityKmS[1];
  state[STATE_UZ] = gamma * velocityKmS[2];
  return state;
}

describe('brachistochrone half-time — physics-spec §8.2', () => {
  it('inverts the hyperbolic distance relation exactly', () => {
    for (const distanceKm of [1e3, 1e6, 1e9, 1e12, 1e15]) {
      const halfSec = brachistochroneHalfCoordSec(distanceKm, ALPHA_MS2);
      // Rationalised inverse of d/2 = (c²/α)(√(1+x²)−1): the textbook form cancels
      // catastrophically for shallow trips, where x is ~1e-5 and the bracket is ~1e-10.
      const x = (ALPHA_KM_S2 * halfSec) / c;
      const reconstructedKm = ((c * c) / ALPHA_KM_S2) * ((x * x) / (1 + Math.hypot(1, x)));
      expect(relativeError(reconstructedKm, distanceKm / 2)).toBeLessThan(1e-12);
    }
  });

  it('exceeds the Newtonian √(d/α) by exactly the leading relativistic term', () => {
    // T_h = √(d/α)·√(1 + k/2) with k = αd/(2c²), so the excess is k/4 to first order.
    for (const distanceKm of [1e5, 1e8, 1e10]) {
      const newtonianSec = Math.sqrt(distanceKm / ALPHA_KM_S2);
      const halfSec = brachistochroneHalfCoordSec(distanceKm, ALPHA_MS2);
      const relativisticDepth = (ALPHA_KM_S2 * distanceKm) / (2 * c * c);
      expect(halfSec).toBeGreaterThan(newtonianSec);
      expect(
        relativeError(halfSec, newtonianSec * Math.sqrt(1 + relativisticDepth / 2)),
      ).toBeLessThan(1e-15);
      // The k/4 first-order term, correct up to the O(k²) it omits.
      expect(Math.abs((halfSec / newtonianSec - 1) / (relativisticDepth / 4) - 1)).toBeLessThan(
        relativisticDepth,
      );
    }
  });

  it('approaches the photon limit d/(2c) from above at extreme depth', () => {
    const distanceKm = 1e22;
    const halfSec = brachistochroneHalfCoordSec(distanceKm, ALPHA_MS2);
    expect(halfSec).toBeGreaterThan(distanceKm / (2 * c));
    expect(relativeError(halfSec, distanceKm / (2 * c))).toBeLessThan(1e-3);
  });

  it('rejects non-physical arguments', () => {
    expect(brachistochroneHalfCoordSec(0, ALPHA_MS2)).toBe(0);
    expect(brachistochroneHalfCoordSec(-1, ALPHA_MS2)).toBeNaN();
    expect(brachistochroneHalfCoordSec(1e6, 0)).toBeNaN();
    expect(brachistochroneHalfCoordSec(Number.NaN, ALPHA_MS2)).toBeNaN();
  });
});

describe('one-dimensional intercept vs closed-form hyperbolic motion — physics-spec §8.1–§8.2', () => {
  // Peak Lorentz factor 2 (beta = √3/2): k = α·d/(2c²) = 1.
  const distanceKm = (2 * c * c) / ALPHA_KM_S2;
  const rails = staticRails();
  const ship = shipAt(distanceKm + ANCHOR_RADIUS_KM, [0, 0, 0]);
  const solution = createInterceptSolution();
  solveInterceptInto(solution, ship, rails, 0, ALPHA_MS2, 'flyby', 0, 0);

  const expectedHalfSec = (c / ALPHA_KM_S2) * Math.sqrt(3);
  const expectedProperSec = ((2 * c) / ALPHA_KM_S2) * Math.asinh(Math.sqrt(3));

  it('solves the closed-form time of flight, proper time and peak beta', () => {
    expect(solution.ok).toBe(true);
    expect(solution.arrivalRadiusKm).toBe(ANCHOR_RADIUS_KM);
    expect(relativeError(solution.totalCoordSec, 2 * expectedHalfSec)).toBeLessThan(1e-12);
    expect(solution.flipAtCoordSec).toBe(solution.totalCoordSec / 2);
    expect(relativeError(solution.totalProperSec, expectedProperSec)).toBeLessThan(1e-12);
    expect(relativeError(solution.peakBeta, Math.sqrt(3) / 2)).toBeLessThan(1e-12);
    expect(solution.aimUnit[0]).toBeCloseTo(-1, 15);
  });

  it('the flown profile matches hyperbolic motion to 1e-9 relative at the flip', () => {
    const atFlip = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    expect(flyInterceptProfile(atFlip, ship, solution, ALPHA_MS2, 0, 0.5)).toBe(true);

    const travelledKm = (ship[STATE_RX] as number) - (atFlip[STATE_RX] as number);
    expect(relativeError(travelledKm, distanceKm / 2)).toBeLessThan(1e-9);
    expect(
      relativeError(Math.abs(atFlip[STATE_UX] as number), ALPHA_KM_S2 * expectedHalfSec),
    ).toBeLessThan(1e-9);
    expect(
      relativeError(
        atFlip[STATE_TAU] as number,
        (c / ALPHA_KM_S2) * Math.asinh((ALPHA_KM_S2 * expectedHalfSec) / c),
      ),
    ).toBeLessThan(1e-9);
    expect(atFlip[STATE_UY]).toBe(0);
    expect(atFlip[STATE_UZ]).toBe(0);
  });

  it('the flown profile arrives at the stand-off point, at rest, on the solved clock', () => {
    const atEnd = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    expect(flyInterceptProfile(atEnd, ship, solution, ALPHA_MS2, 0, 1)).toBe(true);

    // Errors are stated against the trip, not against the 1 000 km stand-off: the
    // trip is 1.8e12 km, so one ulp of the ship's own coordinate is already 0.25 km
    // and a relative bound on the residual radius would be a bound on float64 itself.
    const missKm = Math.hypot(
      (atEnd[STATE_RX] as number) - ANCHOR_RADIUS_KM,
      atEnd[STATE_RY] as number,
      atEnd[STATE_RZ] as number,
    );
    expect(missKm / distanceKm).toBeLessThan(1e-9);
    expect(
      Math.hypot(atEnd[STATE_UX] as number, atEnd[STATE_UY] as number, atEnd[STATE_UZ] as number) /
        (ALPHA_KM_S2 * expectedHalfSec),
    ).toBeLessThan(1e-9);
    expect(relativeError(atEnd[STATE_TAU] as number, solution.totalProperSec)).toBeLessThan(1e-9);
  });
});

describe('arrival stand-off radius — physics-spec §8.5', () => {
  const rails = staticRails();
  const solution = createInterceptSolution();

  it("defaults 'orbit' to three collision radii and 'flyby' to a graze", () => {
    const ship = shipAt(1e7, [0, 0, 0]);
    solveInterceptInto(solution, ship, rails, 0, ALPHA_MS2, 'orbit', 0, 0);
    expect(solution.arrivalRadiusKm).toBe(ORBIT_ARRIVAL_RADIUS_FACTOR * ANCHOR_RADIUS_KM);
    solveInterceptInto(solution, ship, rails, 0, ALPHA_MS2, 'flyby', 0, 0);
    expect(solution.arrivalRadiusKm).toBe(ANCHOR_RADIUS_KM);
  });

  it('adds a requested altitude to the collision radius in both modes', () => {
    const ship = shipAt(1e7, [0, 0, 0]);
    solveInterceptInto(solution, ship, rails, 0, ALPHA_MS2, 'flyby', 250, 0);
    expect(solution.arrivalRadiusKm).toBe(ANCHOR_RADIUS_KM + 250);
    solveInterceptInto(solution, ship, rails, 0, ALPHA_MS2, 'orbit', 9_000, 0);
    expect(solution.arrivalRadiusKm).toBe(ANCHOR_RADIUS_KM + 9_000);
  });

  it('shortens the flown distance by the stand-off radius', () => {
    const ship = shipAt(1e7, [0, 0, 0]);
    solveInterceptInto(solution, ship, rails, 0, ALPHA_MS2, 'flyby', 0, 0);
    const expectedSec = 2 * brachistochroneHalfCoordSec(1e7 - ANCHOR_RADIUS_KM, ALPHA_MS2);
    expect(relativeError(solution.totalCoordSec, expectedSec)).toBeLessThan(1e-12);
  });
});

describe('degenerate intercepts return ok=false cleanly — physics-spec §8.6', () => {
  const rails = staticRails();
  const solution = createInterceptSolution();
  const ship = shipAt(1e7, [0, 0, 0]);

  function expectRejected(): void {
    expect(solution.ok).toBe(false);
    expect(solution.totalCoordSec).toBeNaN();
    expect(solution.flipAtCoordSec).toBeNaN();
    expect(solution.totalProperSec).toBeNaN();
    expect(solution.peakBeta).toBeNaN();
    expect(solution.arrivalRadiusKm).toBeNaN();
    expect(solution.aimUnit[0]).toBe(0);
    expect(solution.aimUnit[1]).toBe(0);
    expect(solution.aimUnit[2]).toBe(0);
  }

  it('rejects a non-positive or non-finite proper acceleration', () => {
    for (const alphaMS2 of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      solveInterceptInto(solution, ship, rails, 0, alphaMS2, 'orbit', 0, 0);
      expectRejected();
    }
  });

  it('rejects a target index outside the compiled catalog', () => {
    for (const index of [-1, 1, 0.5, Number.NaN]) {
      solveInterceptInto(solution, ship, rails, index, ALPHA_MS2, 'orbit', 0, 0);
      expectRejected();
    }
  });

  it('rejects a non-finite ship state or start time', () => {
    const broken = shipAt(1e7, [0, 0, 0]);
    broken[STATE_RY] = Number.NaN;
    solveInterceptInto(solution, broken, rails, 0, ALPHA_MS2, 'orbit', 0, 0);
    expectRejected();

    const luminal = shipAt(1e7, [0, 0, 0]);
    luminal[STATE_UX] = Number.POSITIVE_INFINITY;
    solveInterceptInto(solution, luminal, rails, 0, ALPHA_MS2, 'orbit', 0, 0);
    expectRejected();

    solveInterceptInto(solution, ship, rails, 0, ALPHA_MS2, 'orbit', 0, Number.NaN);
    expectRejected();
  });

  it('rejects a non-finite or negative arrival altitude', () => {
    for (const altitudeKm of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      solveInterceptInto(solution, ship, rails, 0, ALPHA_MS2, 'flyby', altitudeKm, 0);
      expectRejected();
    }
  });

  it('rejects a target whose size is unknown and whose stand-off is unspecified', () => {
    const sizeless = sizelessRails();
    solveInterceptInto(solution, ship, sizeless, 0, ALPHA_MS2, 'orbit', 0, 0);
    expectRejected();
    // An explicit stand-off makes the same target solvable.
    solveInterceptInto(solution, ship, sizeless, 0, ALPHA_MS2, 'orbit', 5_000, 0);
    expect(solution.ok).toBe(true);
    expect(solution.arrivalRadiusKm).toBe(5_000);
  });

  it('rejects a target the ship is already at, within two collision radii', () => {
    solveInterceptInto(solution, shipAt(1_500, [0, 0, 0]), rails, 0, ALPHA_MS2, 'orbit', 0, 0);
    expectRejected();
    // 'orbit' pushes the stand-off out to 3 radii, so the same 2 500 km start is
    // inside the arrival sphere even though it clears the two-radius exclusion.
    solveInterceptInto(solution, shipAt(2_500, [0, 0, 0]), rails, 0, ALPHA_MS2, 'orbit', 0, 0);
    expectRejected();
    // Just outside both exclusions the same geometry solves.
    solveInterceptInto(solution, shipAt(2_500, [0, 0, 0]), rails, 0, ALPHA_MS2, 'flyby', 0, 0);
    expect(solution.ok).toBe(true);
    solveInterceptInto(solution, shipAt(20_000, [0, 0, 0]), rails, 0, ALPHA_MS2, 'orbit', 0, 0);
    expect(solution.ok).toBe(true);
  });

  it('rejects a drift that carries the ship inside the stand-off sphere', () => {
    const startKm = 1e6;
    const seedSec = 2 * brachistochroneHalfCoordSec(startKm - ANCHOR_RADIUS_KM, ALPHA_MS2);
    const closingKmS = startKm / seedSec;
    solveInterceptInto(
      solution,
      shipAt(startKm, [-closingKmS, 0, 0]),
      rails,
      0,
      ALPHA_MS2,
      'flyby',
      0,
      0,
    );
    expectRejected();
  });

  it('rejects a diverging iteration instead of returning its last guess', () => {
    solveInterceptInto(solution, shipAt(1e7, [-0.5 * c, 0, 0]), rails, 0, ALPHA_MS2, 'flyby', 0, 0);
    expectRejected();
    expect(solution.iterations).toBeLessThanOrEqual(MAX_INTERCEPT_ITERATIONS);
  });

  it('rejects a converged but ill-conditioned solve, and accepts the slow one', () => {
    const startKm = 1e8;
    const peakKmS = ALPHA_KM_S2 * brachistochroneHalfCoordSec(startKm, ALPHA_MS2);

    solveInterceptInto(
      solution,
      shipAt(startKm, [0, 0.3 * peakKmS, 0]),
      rails,
      0,
      ALPHA_MS2,
      'flyby',
      0,
      0,
    );
    expectRejected();

    solveInterceptInto(
      solution,
      shipAt(startKm, [0, 0.01 * peakKmS, 0]),
      rails,
      0,
      ALPHA_MS2,
      'flyby',
      0,
      0,
    );
    expect(solution.ok).toBe(true);
    expect(solution.iterations).toBeLessThanOrEqual(12);
  });
});

describe('allocation behaviour', () => {
  it('reuses the caller-owned solution and the rails scratch across many solves', () => {
    const rails = staticRails();
    const solution = createInterceptSolution();
    const aimUnit = solution.aimUnit;
    const positions = rails.scratchState.positionsKm;
    const velocities = rails.scratchState.velocitiesKmS;

    for (let index = 0; index < 500; index += 1) {
      solveInterceptInto(
        solution,
        shipAt(1e7 + index, [0, 0, 0]),
        rails,
        0,
        ALPHA_MS2,
        'orbit',
        0,
        index,
      );
      expect(solution.ok).toBe(true);
    }

    expect(solution.aimUnit).toBe(aimUnit);
    expect(rails.scratchState.positionsKm).toBe(positions);
    expect(rails.scratchState.velocitiesKmS).toBe(velocities);
  });
});
