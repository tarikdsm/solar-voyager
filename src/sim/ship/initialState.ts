import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import {
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
  type CompiledRailsCatalog,
} from '../propagation/rails.js';
import {
  RELATIVISTIC_STATE_DIMENSION,
  STATE_RX,
  STATE_RY,
  STATE_RZ,
  STATE_TAU,
  STATE_UX,
  STATE_UY,
  STATE_UZ,
} from './relativity.js';

/** Respawn radius as a multiple of the body's mean radius (ADR-036). */
export const RESPAWN_BODY_RADII = 2;

function normalizeOrThrow(
  xKm: number,
  yKm: number,
  zKm: number,
  label: string,
): [number, number, number] {
  const magnitude = Math.hypot(xKm, yKm, zKm);
  if (!Number.isFinite(magnitude) || magnitude <= 0) throw new RangeError(label);
  return [xKm / magnitude, yKm / magnitude, zKm / magnitude];
}

/** Any unit vector orthogonal to `radial`, chosen deterministically. */
function anyPerpendicular(radial: readonly [number, number, number]): [number, number, number] {
  const [rx, ry, rz] = radial;
  // Cross with whichever axis is least aligned, so the product never degenerates.
  const useX = Math.abs(rx) <= Math.abs(ry) && Math.abs(rx) <= Math.abs(rz);
  const useY = !useX && Math.abs(ry) <= Math.abs(rz);
  const ax = useX ? 1 : 0;
  const ay = useY ? 1 : 0;
  const az = useX || useY ? 0 : 1;
  return normalizeOrThrow(
    ry * az - rz * ay,
    rz * ax - rx * az,
    rx * ay - ry * ax,
    'perpendicular construction failed',
  );
}

/**
 * Builds a circular orbit around `bodyIndex` at `orbitRadiusKm`, at `timeSec`.
 *
 * The orbit plane is set by two directions: the radial, taken from
 * `referencePositionKm` relative to the body when supplied (so a respawn appears
 * above where the ship was lost) and otherwise from the body's own heliocentric
 * direction; and the body's heliocentric velocity, which makes the orbit
 * prograde with the body's motion. Either can degenerate — the Sun sits at the
 * frame origin with zero velocity — so both fall back to a deterministic
 * perpendicular rather than throwing (physics-spec.md section 3, ADR-036).
 */
export function createCircularOrbitState(
  catalog: CompiledRailsCatalog,
  bodyIndex: number,
  orbitRadiusKm: number,
  timeSec = 0,
  referencePositionKm: Float64Array | null = null,
): Float64Array {
  if (!Number.isInteger(bodyIndex) || bodyIndex < 0 || bodyIndex >= catalog.bodyCount) {
    throw new RangeError('body index must select a body in the compiled catalog');
  }
  if (!Number.isFinite(orbitRadiusKm) || orbitRadiusKm <= 0) {
    throw new RangeError('orbit radius must be finite and positive');
  }
  if (!Number.isFinite(timeSec)) throw new RangeError('orbit epoch must be finite');

  const railsState = createRailsState(catalog);
  evaluateRailsInto(railsState, catalog, timeSec, createRailsWorkspace());
  const offset = bodyIndex * 3;
  const bodyXKm = railsState.positionsKm[offset] as number;
  const bodyYKm = railsState.positionsKm[offset + 1] as number;
  const bodyZKm = railsState.positionsKm[offset + 2] as number;
  const bodyVxKmS = railsState.velocitiesKmS[offset] as number;
  const bodyVyKmS = railsState.velocitiesKmS[offset + 1] as number;
  const bodyVzKmS = railsState.velocitiesKmS[offset + 2] as number;

  // Body-relative when a reference position is given, heliocentric otherwise.
  const hintXKm =
    referencePositionKm === null ? bodyXKm : (referencePositionKm[0] as number) - bodyXKm;
  const hintYKm =
    referencePositionKm === null ? bodyYKm : (referencePositionKm[1] as number) - bodyYKm;
  const hintZKm =
    referencePositionKm === null ? bodyZKm : (referencePositionKm[2] as number) - bodyZKm;
  const hintMagnitudeKm = Math.hypot(hintXKm, hintYKm, hintZKm);
  const radial: [number, number, number] =
    Number.isFinite(hintMagnitudeKm) && hintMagnitudeKm > 0
      ? [hintXKm / hintMagnitudeKm, hintYKm / hintMagnitudeKm, hintZKm / hintMagnitudeKm]
      : [1, 0, 0];

  const radialVelocityKmS = bodyVxKmS * radial[0] + bodyVyKmS * radial[1] + bodyVzKmS * radial[2];
  const tangentXKmS = bodyVxKmS - radialVelocityKmS * radial[0];
  const tangentYKmS = bodyVyKmS - radialVelocityKmS * radial[1];
  const tangentZKmS = bodyVzKmS - radialVelocityKmS * radial[2];
  const tangentSpeedKmS = Math.hypot(tangentXKmS, tangentYKmS, tangentZKmS);
  const tangent: [number, number, number] =
    Number.isFinite(tangentSpeedKmS) && tangentSpeedKmS > 0
      ? [
          tangentXKmS / tangentSpeedKmS,
          tangentYKmS / tangentSpeedKmS,
          tangentZKmS / tangentSpeedKmS,
        ]
      : anyPerpendicular(radial);

  const circularSpeedKmS = Math.sqrt((catalog.muKm3S2[bodyIndex] as number) / orbitRadiusKm);
  const velocityXKmS = bodyVxKmS + tangent[0] * circularSpeedKmS;
  const velocityYKmS = bodyVyKmS + tangent[1] * circularSpeedKmS;
  const velocityZKmS = bodyVzKmS + tangent[2] * circularSpeedKmS;

  // physics-spec.md §3 — u = gamma*v for the full inherited coordinate velocity.
  const beta = Math.hypot(velocityXKmS, velocityYKmS, velocityZKmS) / SPEED_OF_LIGHT_KM_S;
  if (!Number.isFinite(beta) || beta >= 1) {
    throw new RangeError('respawn coordinate velocity must be finite and subluminal');
  }
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  const state = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
  state[STATE_RX] = bodyXKm + radial[0] * orbitRadiusKm;
  state[STATE_RY] = bodyYKm + radial[1] * orbitRadiusKm;
  state[STATE_RZ] = bodyZKm + radial[2] * orbitRadiusKm;
  state[STATE_UX] = gamma * velocityXKmS;
  state[STATE_UY] = gamma * velocityYKmS;
  state[STATE_UZ] = gamma * velocityZKmS;
  state[STATE_TAU] = 0;
  return state;
}

/** Creates the setup-time relativistic ship state for a prograde circular Earth orbit. */
export function createNewGameLeoState(
  catalog: CompiledRailsCatalog,
  earthIndex: number,
  earthMeanRadiusKm: number,
  altitudeKm = 400,
): Float64Array {
  if (!Number.isInteger(earthIndex) || earthIndex < 0 || earthIndex >= catalog.bodyCount) {
    throw new RangeError('Earth index must select a body in the compiled catalog');
  }
  const orbitRadiusKm = earthMeanRadiusKm + altitudeKm;
  if (!Number.isFinite(orbitRadiusKm) || orbitRadiusKm <= 0) {
    throw new RangeError('new-game orbit radius must be finite and positive');
  }

  const railsState = createRailsState(catalog);
  evaluateRailsInto(railsState, catalog, 0, createRailsWorkspace());
  const offset = earthIndex * 3;
  const earthXKm = railsState.positionsKm[offset] as number;
  const earthYKm = railsState.positionsKm[offset + 1] as number;
  const earthZKm = railsState.positionsKm[offset + 2] as number;
  const earthVxKmS = railsState.velocitiesKmS[offset] as number;
  const earthVyKmS = railsState.velocitiesKmS[offset + 1] as number;
  const earthVzKmS = railsState.velocitiesKmS[offset + 2] as number;

  const earthDistanceKm = Math.hypot(earthXKm, earthYKm, earthZKm);
  if (!Number.isFinite(earthDistanceKm) || earthDistanceKm <= 0) {
    throw new RangeError('Earth must have a finite nonzero heliocentric position');
  }
  const radialX = earthXKm / earthDistanceKm;
  const radialY = earthYKm / earthDistanceKm;
  const radialZ = earthZKm / earthDistanceKm;

  const radialVelocityKmS = earthVxKmS * radialX + earthVyKmS * radialY + earthVzKmS * radialZ;
  const tangentXKmS = earthVxKmS - radialVelocityKmS * radialX;
  const tangentYKmS = earthVyKmS - radialVelocityKmS * radialY;
  const tangentZKmS = earthVzKmS - radialVelocityKmS * radialZ;
  const tangentSpeedKmS = Math.hypot(tangentXKmS, tangentYKmS, tangentZKmS);
  if (!Number.isFinite(tangentSpeedKmS) || tangentSpeedKmS <= 0) {
    throw new RangeError('Earth must have a finite nonzero prograde tangent');
  }

  const earthMuKm3S2 = catalog.muKm3S2[earthIndex] as number;
  const circularSpeedKmS = Math.sqrt(earthMuKm3S2 / orbitRadiusKm);
  const velocityXKmS = earthVxKmS + (tangentXKmS / tangentSpeedKmS) * circularSpeedKmS;
  const velocityYKmS = earthVyKmS + (tangentYKmS / tangentSpeedKmS) * circularSpeedKmS;
  const velocityZKmS = earthVzKmS + (tangentZKmS / tangentSpeedKmS) * circularSpeedKmS;

  // physics-spec.md §3 — u = gamma*v for the full inherited coordinate velocity.
  const beta = Math.hypot(velocityXKmS, velocityYKmS, velocityZKmS) / SPEED_OF_LIGHT_KM_S;
  if (!Number.isFinite(beta) || beta >= 1) {
    throw new RangeError('new-game coordinate velocity must be finite and subluminal');
  }
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  const state = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
  state[STATE_RX] = earthXKm + radialX * orbitRadiusKm;
  state[STATE_RY] = earthYKm + radialY * orbitRadiusKm;
  state[STATE_RZ] = earthZKm + radialZ * orbitRadiusKm;
  state[STATE_UX] = gamma * velocityXKmS;
  state[STATE_UY] = gamma * velocityYKmS;
  state[STATE_UZ] = gamma * velocityZKmS;
  state[STATE_TAU] = 0;
  return state;
}
