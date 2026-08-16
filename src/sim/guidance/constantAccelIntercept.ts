// physics-spec.md section 8 — constant-proper-acceleration intercept of a rails
// target (ADR-037). Pure, allocation-free, float64. Consumes the rails catalog
// read-only; the evaluation cache in `CompiledRails` is this module's own scratch.

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import {
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
  type CompiledRailsCatalog,
  type RailsState,
  type RailsWorkspace,
} from '../propagation/rails.js';
import {
  lorentzFactorFromCelerity,
  STATE_RX,
  STATE_RY,
  STATE_RZ,
  STATE_UX,
  STATE_UY,
  STATE_UZ,
} from '../ship/relativity.js';

/** Fixed-point iteration cap; plan §3.3.2. */
export const MAX_INTERCEPT_ITERATIONS = 25;

/** Time-of-flight change below which the iteration is converged; plan §3.3.2. */
export const INTERCEPT_CONVERGENCE_SEC = 0.5;

/**
 * Largest accepted ratio of arrival closing speed to the profile's peak drift-frame
 * celerity (physics-spec §8.6). This is simultaneously the contraction factor of the
 * fixed point and the "is this an arrival or a fly-past" test: measured departure
 * solves sit at 0.0019–0.036, mid-cruise re-solves at 0.24–1.6, and the latter
 * either fail to converge or converge to a spurious drift-past-and-return root.
 */
export const MAX_INTERCEPT_CLOSING_RATIO = 0.1;

/** Default 'orbit' stand-off, in collision radii; plan §3.3.3. */
export const ORBIT_ARRIVAL_RADIUS_FACTOR = 3;

/** Player-selected arrival geometry; only the stand-off radius differs. */
export type ArrivalIntent = 'orbit' | 'flyby';

/**
 * A compiled rails catalog bundled with private evaluation scratch.
 *
 * The catalog is shared and read-only. `scratchState` and `scratchWorkspace` are
 * owned by this handle and **must never be `SimulationCore`'s live `RailsState`**:
 * that cache holds the current frame's body positions, and the solver evaluates
 * future times through it, which would silently corrupt every other consumer in the
 * same frame.
 */
export interface CompiledRails {
  readonly catalog: CompiledRailsCatalog;
  readonly scratchState: RailsState;
  readonly scratchWorkspace: RailsWorkspace;
}

/** Allocates the guidance-owned rails scratch once, at setup. */
export function createCompiledRails(catalog: CompiledRailsCatalog): CompiledRails {
  return {
    catalog,
    scratchState: createRailsState(catalog),
    scratchWorkspace: createRailsWorkspace(),
  };
}

/** Solved boost-flip-brake profile. `ok === false` selects the pursuit fallback. */
export interface InterceptSolution {
  ok: boolean;
  /** Boost plus brake, in coordinate seconds. */
  totalCoordSec: number;
  /** Time from start to the attitude reversal; always `totalCoordSec / 2` (§8.4). */
  flipAtCoordSec: number;
  /** Ship proper time for the whole trip. */
  totalProperSec: number;
  /** Largest `|v|/c` reached anywhere on the profile. */
  peakBeta: number;
  /** Stand-off radius from the target centre that the profile arrives at. */
  arrivalRadiusKm: number;
  /**
   * Fixed-point iterations performed. Diagnostic: bounded by
   * `MAX_INTERCEPT_ITERATIONS`, and the quantity T0114's convergence acceptance and
   * any future route-health logging are stated in.
   */
  iterations: number;
  /**
   * Inertial unit thrust axis of the boost leg; the brake leg is its negation.
   * Zeroed when `ok` is false. Written in place, never reassigned.
   */
  readonly aimUnit: Float64Array;
}

/** Allocates one reusable solution record. */
export function createInterceptSolution(): InterceptSolution {
  return {
    ok: false,
    totalCoordSec: Number.NaN,
    flipAtCoordSec: Number.NaN,
    totalProperSec: Number.NaN,
    peakBeta: Number.NaN,
    arrivalRadiusKm: Number.NaN,
    iterations: 0,
    aimUnit: new Float64Array(3),
  };
}

/**
 * Half the coordinate time of a rest-to-rest constant-acceleration trip of
 * `distanceKm`: `sqrt(d^2/(4c^2) + d/alpha)` (physics-spec §8.2).
 *
 * The two terms are both positive, so the form has no cancellation at either limit;
 * it degrades to the Newtonian `sqrt(d/alpha)` for shallow trips and to the photon
 * bound `d/(2c)` for deep ones.
 */
export function brachistochroneHalfCoordSec(distanceKm: number, alphaMS2: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return Number.NaN;
  if (!Number.isFinite(alphaMS2) || alphaMS2 <= 0) return Number.NaN;
  const alphaKmS2 = alphaMS2 / 1_000;
  return Math.sqrt(
    (distanceKm / (2 * SPEED_OF_LIGHT_KM_S)) * (distanceKm / (2 * SPEED_OF_LIGHT_KM_S)) +
      distanceKm / alphaKmS2,
  );
}

function reject(out: InterceptSolution, iterations: number): void {
  out.ok = false;
  out.totalCoordSec = Number.NaN;
  out.flipAtCoordSec = Number.NaN;
  out.totalProperSec = Number.NaN;
  out.peakBeta = Number.NaN;
  out.arrivalRadiusKm = Number.NaN;
  out.iterations = iterations;
  out.aimUnit[0] = 0;
  out.aimUnit[1] = 0;
  out.aimUnit[2] = 0;
}

/**
 * Resolves the stand-off radius the profile brakes to (physics-spec §8.5).
 * Returns NaN when no radius can be resolved. The `Math.max` floor is a hard
 * guarantee that guidance never aims inside a body's collision sphere, whatever
 * altitude the caller supplies. Ring-aware radii for the four giants are the
 * caller's table (`data/rings.json` lives in the game layer); the numbers are
 * transcribed in physics-spec §8.5.
 */
function resolveArrivalRadiusKm(
  collisionRadiusKm: number,
  arrival: ArrivalIntent,
  arrivalAltitudeKm: number,
): number {
  if (!Number.isFinite(arrivalAltitudeKm) || arrivalAltitudeKm < 0) return Number.NaN;
  if (arrivalAltitudeKm > 0)
    return Math.max(collisionRadiusKm, collisionRadiusKm + arrivalAltitudeKm);
  if (!(collisionRadiusKm > 0)) return Number.NaN;
  return arrival === 'orbit' ? ORBIT_ARRIVAL_RADIUS_FACTOR * collisionRadiusKm : collisionRadiusKm;
}

/**
 * Solves the constant-proper-acceleration boost-flip-brake intercept of rails body
 * `targetIndex`, writing the profile into `out` (physics-spec §8.4).
 *
 * The 1D profile is relativistically exact; the vector correction is the plan's
 * first-order drift subtraction, iterated to a fixed point on the coordinate time of
 * flight. Gravity is deliberately absent — the model is thrust-only and the
 * CruiseDirector's mid-course re-solve is the closed loop (physics-spec §8.7).
 *
 * Allocation-free: every intermediate is a scalar local, and the only arrays touched
 * are `out.aimUnit` and the caller's `rails` scratch.
 */
export function solveInterceptInto(
  out: InterceptSolution,
  shipState: Float64Array,
  rails: CompiledRails,
  targetIndex: number,
  alphaMS2: number,
  arrival: ArrivalIntent,
  arrivalAltitudeKm: number,
  startSimTimeSec: number,
): void {
  const catalog = rails.catalog;
  if (!Number.isFinite(alphaMS2) || alphaMS2 <= 0) return reject(out, 0);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= catalog.bodyCount) {
    return reject(out, 0);
  }
  if (!Number.isFinite(startSimTimeSec)) return reject(out, 0);

  const shipXKm = shipState[STATE_RX] as number;
  const shipYKm = shipState[STATE_RY] as number;
  const shipZKm = shipState[STATE_RZ] as number;
  const celerityXKmS = shipState[STATE_UX] as number;
  const celerityYKmS = shipState[STATE_UY] as number;
  const celerityZKmS = shipState[STATE_UZ] as number;
  if (
    !Number.isFinite(shipXKm) ||
    !Number.isFinite(shipYKm) ||
    !Number.isFinite(shipZKm) ||
    !Number.isFinite(celerityXKmS) ||
    !Number.isFinite(celerityYKmS) ||
    !Number.isFinite(celerityZKmS)
  ) {
    return reject(out, 0);
  }

  const arrivalRadiusKm = resolveArrivalRadiusKm(
    catalog.collisionRadiiKm[targetIndex] as number,
    arrival,
    arrivalAltitudeKm,
  );
  if (!Number.isFinite(arrivalRadiusKm)) return reject(out, 0);

  // physics-spec.md §3 — v = u/gamma, the drift this profile is solved relative to.
  const gamma = lorentzFactorFromCelerity(celerityXKmS, celerityYKmS, celerityZKmS);
  const driftXKmS = celerityXKmS / gamma;
  const driftYKmS = celerityYKmS / gamma;
  const driftZKmS = celerityZKmS / gamma;

  const alphaKmS2 = alphaMS2 / 1_000;
  const componentIndex = targetIndex * 3;

  // Seed: straight-line separation now, minus the stand-off (plan §3.3.1).
  evaluateRailsInto(rails.scratchState, catalog, startSimTimeSec, rails.scratchWorkspace);
  let offsetXKm = (rails.scratchState.positionsKm[componentIndex] as number) - shipXKm;
  let offsetYKm = (rails.scratchState.positionsKm[componentIndex + 1] as number) - shipYKm;
  let offsetZKm = (rails.scratchState.positionsKm[componentIndex + 2] as number) - shipZKm;
  let separationKm = Math.hypot(offsetXKm, offsetYKm, offsetZKm);

  // Already there: the two-radius exclusion, and the arrival sphere itself.
  const collisionRadiusKm = catalog.collisionRadiiKm[targetIndex] as number;
  if (!(separationKm > Math.max(2 * collisionRadiusKm, arrivalRadiusKm))) return reject(out, 0);

  let totalCoordSec = 2 * brachistochroneHalfCoordSec(separationKm - arrivalRadiusKm, alphaMS2);
  if (!Number.isFinite(totalCoordSec) || totalCoordSec <= 0) return reject(out, 0);

  let iterations = 0;
  let converged = false;
  let distanceKm = 0;
  while (iterations < MAX_INTERCEPT_ITERATIONS) {
    iterations += 1;
    evaluateRailsInto(
      rails.scratchState,
      catalog,
      startSimTimeSec + totalCoordSec,
      rails.scratchWorkspace,
    );
    // physics-spec §8.4 — displacement in the frame drifting at the ship's initial
    // coordinate velocity, which is where the profile starts at rest.
    offsetXKm =
      (rails.scratchState.positionsKm[componentIndex] as number) -
      shipXKm -
      driftXKmS * totalCoordSec;
    offsetYKm =
      (rails.scratchState.positionsKm[componentIndex + 1] as number) -
      shipYKm -
      driftYKmS * totalCoordSec;
    offsetZKm =
      (rails.scratchState.positionsKm[componentIndex + 2] as number) -
      shipZKm -
      driftZKmS * totalCoordSec;
    separationKm = Math.hypot(offsetXKm, offsetYKm, offsetZKm);
    distanceKm = separationKm - arrivalRadiusKm;
    if (!(distanceKm > 0)) return reject(out, iterations);

    const nextCoordSec = 2 * brachistochroneHalfCoordSec(distanceKm, alphaMS2);
    // Guard before the next rails evaluation: evaluateRailsInto throws on a
    // non-finite time, and a guidance solver must not throw into a frame loop.
    if (!Number.isFinite(nextCoordSec) || nextCoordSec <= 0) return reject(out, iterations);
    const changeSec = Math.abs(nextCoordSec - totalCoordSec);
    totalCoordSec = nextCoordSec;
    if (changeSec < INTERCEPT_CONVERGENCE_SEC) {
      converged = true;
      break;
    }
  }
  if (!converged) return reject(out, iterations);

  const aimXUnit = offsetXKm / separationKm;
  const aimYUnit = offsetYKm / separationKm;
  const aimZUnit = offsetZKm / separationKm;

  // physics-spec §8.6 — conditioning: the arrival closing speed must be small
  // against the profile's own peak, or the fixed point has found a fly-past root.
  const closingKmS = Math.hypot(
    driftXKmS - (rails.scratchState.velocitiesKmS[componentIndex] as number),
    driftYKmS - (rails.scratchState.velocitiesKmS[componentIndex + 1] as number),
    driftZKmS - (rails.scratchState.velocitiesKmS[componentIndex + 2] as number),
  );
  const peakDriftCelerityKmS = (alphaKmS2 * totalCoordSec) / 2;
  if (!(closingKmS <= MAX_INTERCEPT_CLOSING_RATIO * peakDriftCelerityKmS)) {
    return reject(out, iterations);
  }

  // physics-spec §8.4 — exact profile quantities with the initial celerity retained,
  // so a re-solve from a moving ship reports its real clock and its real peak beta.
  const alongKmS = celerityXKmS * aimXUnit + celerityYKmS * aimYUnit + celerityZKmS * aimZUnit;
  const acrossSquared = Math.max(
    celerityXKmS * celerityXKmS +
      celerityYKmS * celerityYKmS +
      celerityZKmS * celerityZKmS -
      alongKmS * alongKmS,
    0,
  );
  const transverseScaleKmS = Math.sqrt(SPEED_OF_LIGHT_KM_S * SPEED_OF_LIGHT_KM_S + acrossSquared);
  const flipAlongKmS = alongKmS + peakDriftCelerityKmS;
  const totalProperSec =
    ((2 * SPEED_OF_LIGHT_KM_S) / alphaKmS2) *
    (Math.asinh(flipAlongKmS / transverseScaleKmS) - Math.asinh(alongKmS / transverseScaleKmS));
  const peakCelerityKmS = Math.sqrt(
    acrossSquared + Math.max(alongKmS * alongKmS, flipAlongKmS * flipAlongKmS),
  );

  out.ok = true;
  out.totalCoordSec = totalCoordSec;
  out.flipAtCoordSec = totalCoordSec / 2;
  out.totalProperSec = totalProperSec;
  out.peakBeta = peakCelerityKmS / Math.hypot(SPEED_OF_LIGHT_KM_S, peakCelerityKmS);
  out.arrivalRadiusKm = arrivalRadiusKm;
  out.iterations = iterations;
  out.aimUnit[0] = aimXUnit;
  out.aimUnit[1] = aimYUnit;
  out.aimUnit[2] = aimZUnit;
}
