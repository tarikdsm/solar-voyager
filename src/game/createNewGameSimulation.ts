import bodiesDocument from '../../data/bodies.json';

import { compileRailsCatalog } from '../sim/propagation/rails.js';
import { SimulationCore } from '../sim/simulation.js';
import type { SimulationPersistentState } from '../sim/simulationState.js';
import { createNewGameLeoState } from '../sim/ship/initialState.js';

const NEW_GAME_LEO_ALTITUDE_KM = 400;

function createCanonicalCatalog() {
  return compileRailsCatalog(bodiesDocument.bodies);
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
export function createNewGameSimulation(shipMassKg: number): SimulationCore {
  const catalog = createCanonicalCatalog();
  return new SimulationCore({
    catalog,
    initialShipState: createCanonicalLeoState(catalog),
    shipMassKg,
  });
}

/** Reconstructs a saved space-phase simulation against the canonical catalog. */
export function createGameSimulationFromPersistentState(
  shipMassKg: number,
  persistentState: SimulationPersistentState,
): SimulationCore {
  const catalog = createCanonicalCatalog();
  return new SimulationCore({
    catalog,
    initialShipState: createCanonicalLeoState(catalog),
    shipMassKg,
    persistentState,
  });
}
