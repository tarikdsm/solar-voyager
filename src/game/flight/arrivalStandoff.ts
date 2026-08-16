// physics-spec.md §8.5 — the arrival stand-off class policy the CruiseDirector
// applies on top of the solver's own `max(R_col, 3 R_col)` default.
//
// This table lives in `game/` and not in `sim/guidance/` because it is derived
// from `data/rings.json`, which is game-layer catalog data (ADR-037 §6). The
// override is not cosmetic: `3 R_col` at Jupiter is 214,476 km, inside the
// Thebe gossamer ring at 270,000 km.

import ringsDocument from '../../../data/rings.json';

import { ORBIT_ARRIVAL_RADIUS_FACTOR } from '../../sim/guidance/constantAccelIntercept.js';

/** Solar 'orbit' stand-off in solar radii; physics-spec §8.5 (25 R☉ = 17,392,500 km). */
export const SOLAR_ARRIVAL_RADII = 25;

/** Ringed-giant stand-off as a multiple of the outermost catalogued ring radius. */
export const RING_ARRIVAL_MARGIN = 1.2;

/** Body id whose 'orbit' stand-off is measured in stellar radii. */
const SOLAR_BODY_ID = 'sun';

/** `bodyId -> outermost ring radius (km)`, compiled once from the shipped catalog. */
const OUTER_RING_RADII_KM: ReadonlyMap<string, number> = new Map(
  ringsDocument.systems.map((system) => [system.bodyId, system.outerRadiusKm] as const),
);

/**
 * Stand-off radius the cruise autopilot aims for with `arrival = 'orbit'`, in km.
 *
 * Returns NaN when no radius can be resolved, matching the solver's own contract
 * for an unresolvable stand-off (physics-spec §8.6 case 5). The class rule
 * *replaces* the `3 R_col` default rather than flooring against it: physics-spec
 * §8.5 puts Saturn at 168,734.4 km, which is 2.80 R_col and deliberately below
 * the 180,804 km the default would give — the ring, not the body, sets the bar.
 */
export function orbitArrivalRadiusKm(bodyId: string, collisionRadiusKm: number): number {
  if (!Number.isFinite(collisionRadiusKm) || collisionRadiusKm <= 0) return Number.NaN;
  if (bodyId === SOLAR_BODY_ID) return SOLAR_ARRIVAL_RADII * collisionRadiusKm;
  const outerRingRadiusKm = OUTER_RING_RADII_KM.get(bodyId);
  if (outerRingRadiusKm === undefined) return ORBIT_ARRIVAL_RADIUS_FACTOR * collisionRadiusKm;
  return RING_ARRIVAL_MARGIN * outerRingRadiusKm;
}

/**
 * The same stand-off expressed as the `arrivalAltitudeKm` argument
 * `solveInterceptInto` takes, i.e. height above the collision sphere.
 *
 * Zero means "no override" — the solver then applies its own `3 R_col` default
 * for `'orbit'`, which is the correct answer for every unringed body.
 */
export function orbitArrivalAltitudeKm(bodyId: string, collisionRadiusKm: number): number {
  const radiusKm = orbitArrivalRadiusKm(bodyId, collisionRadiusKm);
  if (!Number.isFinite(radiusKm)) return Number.NaN;
  const hasOverride = bodyId === SOLAR_BODY_ID || OUTER_RING_RADII_KM.has(bodyId);
  return hasOverride ? radiusKm - collisionRadiusKm : 0;
}
