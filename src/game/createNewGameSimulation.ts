import bodiesDocument from '../../data/bodies.json';

import { compileRailsCatalog } from '../sim/propagation/rails.js';
import { SimulationCore } from '../sim/simulation.js';
import type { TrajectoryInvalidationListener } from '../sim/simulationSnapshot.js';
import type { SimulationPersistentState } from '../sim/simulationState.js';
import {
  createCircularOrbitState,
  createNewGameLeoState,
  RESPAWN_BODY_RADII,
} from '../sim/ship/initialState.js';
import type { VesselConfig } from '../sim/ship/vessel.js';
import { WarpClampReason } from '../sim/simulationSnapshot.js';
import { STATE_TAU } from '../sim/ship/relativity.js';

const NEW_GAME_LEO_ALTITUDE_KM = 400;

function createCanonicalCatalog() {
  return compileRailsCatalog(bodiesDocument.bodies);
}

/**
 * The committed J2026 catalog, compiled fresh.
 *
 * `SimulationCore` keeps its own copy private, so game-layer consumers that need
 * to reason about the same bodies (T0116's guidance, the epoch state, the
 * predictor worker) compile their own read-only copy rather than reaching into
 * the simulation — the pattern `createEpochState` and `predictorWorkerRuntime`
 * already use.
 */
export function compileCanonicalCatalog(): ReturnType<typeof createCanonicalCatalog> {
  return createCanonicalCatalog();
}

function createCanonicalLeoState(catalog: ReturnType<typeof createCanonicalCatalog>): Float64Array {
  const earthIndex = catalog.bodyIds.indexOf('earth');
  const earth = bodiesDocument.bodies[earthIndex];
  if (earthIndex < 0 || earth === undefined) {
    throw new Error('J2026 catalog does not contain Earth');
  }
  return createNewGameLeoState(catalog, earthIndex, earth.meanRadiusKm, NEW_GAME_LEO_ALTITUDE_KM);
}

/** Compiles the committed J2026 catalog and creates the canonical new-game simulation. */
export function createNewGameSimulation(
  vessel: VesselConfig,
  onTrajectoryInvalidated: TrajectoryInvalidationListener | null = null,
): SimulationCore {
  const catalog = createCanonicalCatalog();
  return new SimulationCore({
    catalog,
    initialShipState: createCanonicalLeoState(catalog),
    vessel,
    onTrajectoryInvalidated: onTrajectoryInvalidated ?? undefined,
  });
}

/**
 * Builds the ADR-036 respawn document: a circular orbit at two body radii above
 * where the ship was lost, with the mission carried forward.
 *
 * Simulation time, ship proper time, the energy ledger and the completed burn
 * log are preserved — a respawn relocates the ship, it does not restart the
 * mission. Throttle is zero and the active burn is dropped, because
 * `copyAndValidateSimulationPersistentState` requires those two to agree, and a
 * burn that was interrupted by a planet is over.
 */
export function createRespawnPersistentState(
  source: SimulationPersistentState,
  shipPositionKm: Float64Array,
  bodyIndex: number,
): SimulationPersistentState {
  const catalog = createCanonicalCatalog();
  if (!Number.isInteger(bodyIndex) || bodyIndex < 0 || bodyIndex >= catalog.bodyCount) {
    throw new RangeError('respawn body must exist in the simulation catalog');
  }
  const body = bodiesDocument.bodies[bodyIndex];
  if (body === undefined) throw new RangeError('respawn body metadata is missing');

  // Two mean radii, per plan §3.4. Clamped above the collision sphere so a
  // future catalog whose atmosphere top exceeds its mean radius cannot respawn
  // the ship inside the very surface it just hit.
  const collisionRadiusKm = catalog.collisionRadiiKm[bodyIndex] as number;
  const orbitRadiusKm = Math.max(
    RESPAWN_BODY_RADII * body.meanRadiusKm,
    RESPAWN_BODY_RADII * collisionRadiusKm,
  );
  const orbitState = createCircularOrbitState(
    catalog,
    bodyIndex,
    orbitRadiusKm,
    source.simTimeSec,
    shipPositionKm,
  );

  const state = new Float64Array(source.state);
  // Position and celerity are replaced; proper time and the five ledger
  // components at indices 6..11 carry over untouched.
  for (let index = 0; index < STATE_TAU; index += 1) {
    state[index] = orbitState[index] as number;
  }

  return {
    simTimeSec: source.simTimeSec,
    vessel: source.vessel,
    state,
    attitudeQuaternion: new Float64Array(source.attitudeQuaternion),
    throttle: 0,
    attitudeMode: source.attitudeMode,
    rotationRatesRadS: new Float64Array(3),
    requestedWarp: 1,
    effectiveWarp: 1,
    warpClampReason: WarpClampReason.NONE,
    targetBodyId: source.targetBodyId,
    initialKineticEnergyJ: source.initialKineticEnergyJ,
    burnLog: {
      capacity: source.burnLog.capacity,
      entries: source.burnLog.entries,
      active: null,
    },
  };
}

/**
 * Reconstructs a saved space-phase simulation against the canonical catalog.
 *
 * `vessel` is the fallback only; `persistentState.vessel` is what the restored
 * core actually flies (ADR-034).
 */
export function createGameSimulationFromPersistentState(
  vessel: VesselConfig,
  persistentState: SimulationPersistentState,
  onTrajectoryInvalidated: TrajectoryInvalidationListener | null = null,
): SimulationCore {
  const catalog = createCanonicalCatalog();
  return new SimulationCore({
    catalog,
    initialShipState: createCanonicalLeoState(catalog),
    vessel,
    onTrajectoryInvalidated: onTrajectoryInvalidated ?? undefined,
    persistentState,
  });
}
