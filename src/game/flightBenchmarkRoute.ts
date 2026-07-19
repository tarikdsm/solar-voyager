import bodiesDocument from '../../data/bodies.json';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import { WarpClampReason } from '../sim/simulationSnapshot.js';
import { STATE_TAU, relativisticKineticEnergyJ } from '../sim/ship/relativity.js';
import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
} from './createNewGameSimulation.js';
import { createSaveEnvelope, serializeSaveEnvelope } from './saveLoad.js';
import { DEFAULT_GAME_SETTINGS, projectGameSettingsV1 } from './settings.js';

const SHIP_MASS_KG = 10_000;

interface RouteDefinition {
  readonly altitudeKm: number;
  readonly relativeSpeedKmS: number;
  readonly simTimeSec: number;
  readonly targetBodyId: 'earth' | 'moon' | 'jupiter';
}

const ROUTE_DEFINITIONS: readonly RouteDefinition[] = Object.freeze([
  Object.freeze({ altitudeKm: 400, relativeSpeedKmS: 7.675, simTimeSec: 0, targetBodyId: 'earth' }),
  Object.freeze({ altitudeKm: 1_000, relativeSpeedKmS: 2.4, simTimeSec: 60, targetBodyId: 'moon' }),
  Object.freeze({
    altitudeKm: 150_000,
    relativeSpeedKmS: 20,
    simTimeSec: 120,
    targetBodyId: 'jupiter',
  }),
  Object.freeze({
    altitudeKm: 150_000,
    relativeSpeedKmS: 20,
    simTimeSec: 180,
    targetBodyId: 'jupiter',
  }),
]);

export interface FlightBenchmarkCheckpoint {
  readonly distanceToTargetKm: number;
  readonly dominantBodyId: string;
  readonly saveJson: string;
  readonly simTimeSec: number;
  readonly targetBodyId: RouteDefinition['targetBodyId'];
}

function coordinateVelocityToCelerity(velocityKmS: readonly number[]): readonly number[] {
  // physics-spec.md §3: u = gamma(v) * v.
  const speedKmS = Math.hypot(...velocityKmS);
  const beta = speedKmS / SPEED_OF_LIGHT_KM_S;
  if (!Number.isFinite(beta) || beta >= 1) {
    throw new RangeError('benchmark route velocity must be finite and subluminal');
  }
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  return velocityKmS.map((component) => component * gamma);
}

function createCheckpoint(definition: RouteDefinition): FlightBenchmarkCheckpoint {
  const initialSimulation = createNewGameSimulation(SHIP_MASS_KG);
  const timeState = initialSimulation.exportPersistentState();
  const stateAtTime = new Float64Array(timeState.state);
  stateAtTime[STATE_TAU] = definition.simTimeSec;
  const simulationAtTime = createGameSimulationFromPersistentState(SHIP_MASS_KG, {
    ...timeState,
    simTimeSec: definition.simTimeSec,
    state: stateAtTime,
    throttle: 0,
    requestedWarp: 1,
    effectiveWarp: 1,
    warpClampReason: WarpClampReason.NONE,
    targetBodyId: definition.targetBodyId,
  });
  const snapshot = simulationAtTime.snapshot;
  const bodyIndex = snapshot.bodyIds.indexOf(definition.targetBodyId);
  const body = bodiesDocument.bodies[bodyIndex];
  if (bodyIndex < 0 || body === undefined) {
    throw new Error(`benchmark target ${definition.targetBodyId} is absent from the catalog`);
  }
  const offset = bodyIndex * 3;
  const bodyX = snapshot.bodyPositionsKm[offset] as number;
  const bodyY = snapshot.bodyPositionsKm[offset + 1] as number;
  const bodyZ = snapshot.bodyPositionsKm[offset + 2] as number;
  const radialLength = Math.hypot(bodyX, bodyY, bodyZ);
  if (radialLength === 0) throw new Error('benchmark target radial direction is undefined');
  const radialX = bodyX / radialLength;
  const radialY = bodyY / radialLength;
  const radialZ = bodyZ / radialLength;
  const tangentLength = Math.hypot(radialX, radialY);
  if (tangentLength === 0) throw new Error('benchmark target tangent direction is undefined');
  const tangentX = -radialY / tangentLength;
  const tangentY = radialX / tangentLength;
  const distanceToTargetKm = body.meanRadiusKm + definition.altitudeKm;
  const coordinateVelocityKmS = [
    (snapshot.bodyVelocitiesKmS[offset] as number) + tangentX * definition.relativeSpeedKmS,
    (snapshot.bodyVelocitiesKmS[offset + 1] as number) + tangentY * definition.relativeSpeedKmS,
    snapshot.bodyVelocitiesKmS[offset + 2] as number,
  ];
  const celerityKmS = coordinateVelocityToCelerity(coordinateVelocityKmS);
  const routeState = new Float64Array(stateAtTime);
  routeState[0] = bodyX + radialX * distanceToTargetKm;
  routeState[1] = bodyY + radialY * distanceToTargetKm;
  routeState[2] = bodyZ + radialZ * distanceToTargetKm;
  routeState[3] = celerityKmS[0] as number;
  routeState[4] = celerityKmS[1] as number;
  routeState[5] = celerityKmS[2] as number;
  routeState[STATE_TAU] = definition.simTimeSec;
  const persistentState = {
    ...timeState,
    simTimeSec: definition.simTimeSec,
    state: routeState,
    throttle: 0,
    requestedWarp: 1 as const,
    effectiveWarp: 1 as const,
    warpClampReason: WarpClampReason.NONE,
    targetBodyId: definition.targetBodyId,
    initialKineticEnergyJ: relativisticKineticEnergyJ(
      routeState[3] as number,
      routeState[4] as number,
      routeState[5] as number,
      SHIP_MASS_KG,
    ),
  };
  const checkpointSimulation = createGameSimulationFromPersistentState(
    SHIP_MASS_KG,
    persistentState,
  );
  const checkpointSnapshot = checkpointSimulation.snapshot;
  const dominantBodyId = checkpointSnapshot.bodyIds[checkpointSnapshot.dominantBodyIndex];
  if (dominantBodyId === undefined) throw new Error('benchmark checkpoint has no dominant body');
  const actualDistanceToTargetKm = Math.hypot(
    (checkpointSnapshot.shipState[0] as number) -
      (checkpointSnapshot.bodyPositionsKm[offset] as number),
    (checkpointSnapshot.shipState[1] as number) -
      (checkpointSnapshot.bodyPositionsKm[offset + 1] as number),
    (checkpointSnapshot.shipState[2] as number) -
      (checkpointSnapshot.bodyPositionsKm[offset + 2] as number),
  );
  const settings = projectGameSettingsV1({
    ...DEFAULT_GAME_SETTINGS,
    qualityLock: 'high' as const,
  });
  return Object.freeze({
    distanceToTargetKm: Number(actualDistanceToTargetKm.toFixed(6)),
    dominantBodyId,
    saveJson: serializeSaveEnvelope(
      createSaveEnvelope(persistentState, settings, checkpointSnapshot.bodyIds),
    ),
    simTimeSec: definition.simTimeSec,
    targetBodyId: definition.targetBodyId,
  });
}

/** Builds portable, validated save checkpoints used by the headless flight route. */
export function createFlightBenchmarkRoute(): readonly FlightBenchmarkCheckpoint[] {
  return Object.freeze(ROUTE_DEFINITIONS.map(createCheckpoint));
}
