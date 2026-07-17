import bodiesDocument from '../../data/bodies.json';

import { compileRailsCatalog } from '../sim/propagation/rails.js';
import { SimulationCore } from '../sim/simulation.js';
import { createNewGameLeoState } from '../sim/ship/initialState.js';

const NEW_GAME_LEO_ALTITUDE_KM = 400;

/** Compiles the committed J2026 catalog and creates the canonical new-game simulation. */
export function createNewGameSimulation(shipMassKg: number): SimulationCore {
  const catalog = compileRailsCatalog(bodiesDocument.bodies);
  const earthIndex = catalog.bodyIds.indexOf('earth');
  const earth = bodiesDocument.bodies[earthIndex];
  if (earthIndex < 0 || earth === undefined) {
    throw new Error('J2026 catalog does not contain Earth');
  }
  const initialShipState = createNewGameLeoState(
    catalog,
    earthIndex,
    earth.meanRadiusKm,
    NEW_GAME_LEO_ALTITUDE_KM,
  );
  return new SimulationCore({ catalog, initialShipState, shipMassKg });
}
