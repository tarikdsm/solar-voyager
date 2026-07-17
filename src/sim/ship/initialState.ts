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
