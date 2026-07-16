import bodiesDocument from '../../data/bodies.json';

import type { ReadonlyVec3 } from '../core/vec3.js';
import {
  compileRailsCatalog,
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
} from '../sim/propagation/rails.js';

const LEO_ALTITUDE_KM = 400;

export interface EpochBodyDefinition {
  readonly id: string;
  readonly kind: string;
  readonly meanRadiusKm: number;
  readonly geometricAlbedo: number;
  readonly albedoColor: string;
}

export interface EpochState {
  readonly bodies: readonly EpochBodyDefinition[];
  readonly positionsKm: Float64Array;
  readonly cameraPositionKm: ReadonlyVec3;
  readonly cameraLookDirection: ReadonlyVec3;
}

/** Evaluates the catalog's fixed J2026 rails and initial LEO camera state. */
export function createEpochState(): EpochState {
  const railsCatalog = compileRailsCatalog(bodiesDocument.bodies);
  const railsState = createRailsState(railsCatalog);
  evaluateRailsInto(railsState, railsCatalog, 0, createRailsWorkspace());

  const bodies: EpochBodyDefinition[] = [];
  let earthIndex = -1;
  for (let index = 0; index < bodiesDocument.bodies.length; index += 1) {
    const body = bodiesDocument.bodies[index];
    if (body === undefined) throw new Error('Body catalog array is sparse.');
    bodies.push({
      id: body.id,
      kind: body.kind,
      meanRadiusKm: body.meanRadiusKm,
      geometricAlbedo: body.geometricAlbedo,
      albedoColor: body.visual.albedoColor,
    });
    if (body.id === 'earth') earthIndex = index;
  }
  if (earthIndex < 0) throw new Error('J2026 catalog does not contain Earth.');

  const earth = bodiesDocument.bodies[earthIndex];
  const earthOffset = earthIndex * 3;
  const earthX = railsState.positionsKm[earthOffset];
  const earthY = railsState.positionsKm[earthOffset + 1];
  const earthZ = railsState.positionsKm[earthOffset + 2];
  if (earth === undefined || earthX === undefined || earthY === undefined || earthZ === undefined) {
    throw new Error('Earth catalog state is incomplete.');
  }
  const earthSunDistanceKm = Math.sqrt(earthX * earthX + earthY * earthY + earthZ * earthZ);
  if (!Number.isFinite(earthSunDistanceKm) || earthSunDistanceKm <= 0) {
    throw new Error('Earth must have a finite nonzero heliocentric distance.');
  }
  const cameraDistanceKm = earth.meanRadiusKm + LEO_ALTITUDE_KM;
  const sunwardX = -earthX / earthSunDistanceKm;
  const sunwardY = -earthY / earthSunDistanceKm;
  const sunwardZ = -earthZ / earthSunDistanceKm;

  return {
    bodies,
    positionsKm: railsState.positionsKm,
    cameraPositionKm: {
      x: earthX + sunwardX * cameraDistanceKm,
      y: earthY + sunwardY * cameraDistanceKm,
      z: earthZ + sunwardZ * cameraDistanceKm,
    },
    cameraLookDirection: {
      x: -sunwardX,
      y: -sunwardY,
      z: -sunwardZ,
    },
  };
}
