import { readFileSync } from 'node:fs';

import { SPEED_OF_LIGHT_KM_S } from '../../src/core/constants.js';
import {
  createDp54Result,
  createDp54Workspace,
  createShipDp54Tolerance,
  propagate,
} from '../../src/sim/propagation/dp54.js';
import { evaluateNBodyAccelerationInto } from '../../src/sim/propagation/nbodyForces.js';
import {
  compileRailsCatalog,
  createRailsState,
  createRailsWorkspace,
  evaluateRailsInto,
  type CompiledRailsCatalog,
  type RailsBodyInput,
} from '../../src/sim/propagation/rails.js';
import { createRelativisticDerivative } from '../../src/sim/ship/relativity.js';

export const GOLDEN_DURATION_SEC = 30 * 86_400;
export const GOLDEN_SAMPLE_INTERVAL_SEC = 86_400;
export const GOLDEN_SCENARIO_IDS = [
  'leo-30d',
  'earth-mars-transfer-30d',
  'jupiter-flyby-30d',
] as const;

export type GoldenScenarioId = (typeof GOLDEN_SCENARIO_IDS)[number];

interface CatalogBody extends RailsBodyInput {
  readonly meanRadiusKm: number;
  readonly soiRadiusKm: number | null;
}

interface BodyCatalogFile {
  readonly epoch: { readonly name: string };
  readonly bodies: readonly CatalogBody[];
}

export interface GoldenScenario {
  readonly id: GoldenScenarioId;
  readonly epoch: string;
  readonly parameters: Readonly<Record<string, number | string>>;
  readonly initialState: Float64Array;
}

export interface GoldenSample {
  readonly timeSec: number;
  readonly state: number[];
  readonly acceptedSteps: number;
  readonly rejectedSteps: number;
}

export interface GoldenTrajectory {
  readonly schemaVersion: 1;
  readonly scenarioId: GoldenScenarioId;
  readonly epoch: string;
  readonly durationSec: number;
  readonly sampleIntervalSec: number;
  readonly integration: {
    readonly profile: 'production-ship-dp54';
    readonly maxAcceptedStepsPerSegment: number;
  };
  readonly parameters: Readonly<Record<string, number | string>>;
  readonly initialState: number[];
  readonly samples: GoldenSample[];
}

export interface GoldenRunOptions {
  readonly maxAcceptedSteps?: number;
}

const catalogFile = JSON.parse(
  readFileSync(new URL('../../data/bodies.json', import.meta.url), 'utf8'),
) as BodyCatalogFile;
const railsCatalog = compileRailsCatalog(catalogFile.bodies);

function bodyIndex(bodyId: string): number {
  const index = railsCatalog.bodyIds.indexOf(bodyId);
  if (index < 0) {
    throw new Error(`golden trajectory body not found: ${bodyId}`);
  }
  return index;
}

function body(bodyId: string): CatalogBody {
  const found = catalogFile.bodies.find((candidate) => candidate.id === bodyId);
  if (found === undefined) {
    throw new Error(`golden trajectory body metadata not found: ${bodyId}`);
  }
  return found;
}

function component(array: Float64Array, bodyId: string, axis: number): number {
  return array[bodyIndex(bodyId) * 3 + axis] as number;
}

function normalizedVector(x: number, y: number, z: number): [number, number, number] {
  const magnitude = Math.hypot(x, y, z);
  if (magnitude === 0) {
    throw new RangeError('golden trajectory direction must be non-zero');
  }
  return [x / magnitude, y / magnitude, z / magnitude];
}

function progradeTangent(
  radial: readonly [number, number, number],
  vx: number,
  vy: number,
  vz: number,
): [number, number, number] {
  const radialVelocity = vx * radial[0] + vy * radial[1] + vz * radial[2];
  return normalizedVector(
    vx - radialVelocity * radial[0],
    vy - radialVelocity * radial[1],
    vz - radialVelocity * radial[2],
  );
}

// physics-spec.md §3 — u = gamma*v for a resolved coordinate velocity.
function writeState(
  positionKm: readonly [number, number, number],
  coordinateVelocityKmS: readonly [number, number, number],
): Float64Array {
  const speedKmS = Math.hypot(...coordinateVelocityKmS);
  const beta = speedKmS / SPEED_OF_LIGHT_KM_S;
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  return new Float64Array([
    ...positionKm,
    gamma * coordinateVelocityKmS[0],
    gamma * coordinateVelocityKmS[1],
    gamma * coordinateVelocityKmS[2],
    0,
  ]);
}

function epochRails(): ReturnType<typeof createRailsState> {
  const state = createRailsState(railsCatalog);
  evaluateRailsInto(state, railsCatalog, 0, createRailsWorkspace());
  return state;
}

function createLeoScenario(): GoldenScenario {
  const rails = epochRails();
  const earth = body('earth');
  const radiusKm = earth.meanRadiusKm + 400;
  const earthPosition = [
    component(rails.positionsKm, 'earth', 0),
    component(rails.positionsKm, 'earth', 1),
    component(rails.positionsKm, 'earth', 2),
  ] as const;
  const earthVelocity = [
    component(rails.velocitiesKmS, 'earth', 0),
    component(rails.velocitiesKmS, 'earth', 1),
    component(rails.velocitiesKmS, 'earth', 2),
  ] as const;
  const radial = normalizedVector(...earthPosition);
  const tangent = progradeTangent(radial, ...earthVelocity);
  const circularSpeedKmS = Math.sqrt(earth.muKm3S2 / radiusKm);

  return {
    id: 'leo-30d',
    epoch: catalogFile.epoch.name,
    parameters: { altitudeKm: 400, primaryBody: 'earth', direction: 'prograde' },
    initialState: writeState(
      [
        earthPosition[0] + radial[0] * radiusKm,
        earthPosition[1] + radial[1] * radiusKm,
        earthPosition[2] + radial[2] * radiusKm,
      ],
      [
        earthVelocity[0] + tangent[0] * circularSpeedKmS,
        earthVelocity[1] + tangent[1] * circularSpeedKmS,
        earthVelocity[2] + tangent[2] * circularSpeedKmS,
      ],
    ),
  };
}

function createEarthMarsScenario(): GoldenScenario {
  const rails = epochRails();
  const sun = body('sun');
  const earth = body('earth');
  const mars = body('mars');
  if (earth.soiRadiusKm === null || earth.elements === null || mars.elements === null) {
    throw new Error('Earth-Mars golden scenario requires committed SOI and orbital elements');
  }
  const earthPosition = [
    component(rails.positionsKm, 'earth', 0),
    component(rails.positionsKm, 'earth', 1),
    component(rails.positionsKm, 'earth', 2),
  ] as const;
  const earthVelocity = [
    component(rails.velocitiesKmS, 'earth', 0),
    component(rails.velocitiesKmS, 'earth', 1),
    component(rails.velocitiesKmS, 'earth', 2),
  ] as const;
  const radial = normalizedVector(...earthPosition);
  const tangent = progradeTangent(radial, ...earthVelocity);
  const departureOffsetKm = earth.soiRadiusKm + 1_000;
  const position = [
    earthPosition[0] + radial[0] * departureOffsetKm,
    earthPosition[1] + radial[1] * departureOffsetKm,
    earthPosition[2] + radial[2] * departureOffsetKm,
  ] as const;
  const radiusKm = Math.hypot(...position);
  const transferSemimajorAxisKm =
    (earth.elements.semiMajorAxisKm + mars.elements.semiMajorAxisKm) / 2;
  const transferSpeedKmS = Math.sqrt(sun.muKm3S2 * (2 / radiusKm - 1 / transferSemimajorAxisKm));

  return {
    id: 'earth-mars-transfer-30d',
    epoch: catalogFile.epoch.name,
    parameters: {
      departureOffsetBeyondSoiKm: 1_000,
      departureBody: 'earth',
      targetBody: 'mars',
      transfer: 'sun-centered-hohmann',
    },
    initialState: writeState(position, [
      tangent[0] * transferSpeedKmS,
      tangent[1] * transferSpeedKmS,
      tangent[2] * transferSpeedKmS,
    ]),
  };
}

function createJupiterScenario(): GoldenScenario {
  const rails = epochRails();
  const jupiterPosition = [
    component(rails.positionsKm, 'jupiter', 0),
    component(rails.positionsKm, 'jupiter', 1),
    component(rails.positionsKm, 'jupiter', 2),
  ] as const;
  const jupiterVelocity = [
    component(rails.velocitiesKmS, 'jupiter', 0),
    component(rails.velocitiesKmS, 'jupiter', 1),
    component(rails.velocitiesKmS, 'jupiter', 2),
  ] as const;
  const radial = normalizedVector(...jupiterPosition);
  const tangent = progradeTangent(radial, ...jupiterVelocity);
  const upstreamDistanceKm = 15_000_000;
  const impactParameterKm = 1_000_000;
  const approachSpeedKmS = 15;

  return {
    id: 'jupiter-flyby-30d',
    epoch: catalogFile.epoch.name,
    parameters: {
      approachSpeedKmS,
      impactParameterKm,
      primaryBody: 'jupiter',
      upstreamDistanceKm,
    },
    initialState: writeState(
      [
        jupiterPosition[0] - tangent[0] * upstreamDistanceKm + radial[0] * impactParameterKm,
        jupiterPosition[1] - tangent[1] * upstreamDistanceKm + radial[1] * impactParameterKm,
        jupiterPosition[2] - tangent[2] * upstreamDistanceKm + radial[2] * impactParameterKm,
      ],
      [
        jupiterVelocity[0] + tangent[0] * approachSpeedKmS,
        jupiterVelocity[1] + tangent[1] * approachSpeedKmS,
        jupiterVelocity[2] + tangent[2] * approachSpeedKmS,
      ],
    ),
  };
}

export function createGoldenScenario(scenarioId: GoldenScenarioId): GoldenScenario {
  switch (scenarioId) {
    case 'leo-30d':
      return createLeoScenario();
    case 'earth-mars-transfer-30d':
      return createEarthMarsScenario();
    case 'jupiter-flyby-30d':
      return createJupiterScenario();
  }
}

function createFullNBodyDerivative(catalog: CompiledRailsCatalog) {
  const railsState = createRailsState(catalog);
  const railsWorkspace = createRailsWorkspace();
  return createRelativisticDerivative(
    (timeSec, state, outputAcceleration) => {
      evaluateRailsInto(railsState, catalog, timeSec, railsWorkspace);
      evaluateNBodyAccelerationInto(
        outputAcceleration,
        state,
        catalog.muKm3S2,
        railsState.positionsKm,
      );
    },
    (_timeSec, _state, outputAcceleration) => {
      outputAcceleration[0] = 0;
      outputAcceleration[1] = 0;
      outputAcceleration[2] = 0;
    },
  );
}

export function runGoldenTrajectory(
  scenario: GoldenScenario,
  options: GoldenRunOptions = {},
): GoldenTrajectory {
  const maxAcceptedSteps = options.maxAcceptedSteps ?? 4_000;
  const tolerance = createShipDp54Tolerance(1, maxAcceptedSteps);
  const workspace = createDp54Workspace(7);
  const result = createDp54Result();
  const derivative = createFullNBodyDerivative(railsCatalog);
  let currentState = new Float64Array(scenario.initialState);
  let nextState = new Float64Array(7);
  const samples: GoldenSample[] = [
    { timeSec: 0, state: Array.from(currentState), acceptedSteps: 0, rejectedSteps: 0 },
  ];

  for (let day = 1; day <= 30; day += 1) {
    const startTimeSec = (day - 1) * GOLDEN_SAMPLE_INTERVAL_SEC;
    const endTimeSec = day * GOLDEN_SAMPLE_INTERVAL_SEC;
    propagate(
      nextState,
      currentState,
      startTimeSec,
      endTimeSec,
      derivative,
      tolerance,
      workspace,
      result,
    );
    if (!result.reachedEnd) {
      throw new Error(
        `${scenario.id} day ${day} propagation failed: budgetExhausted=${result.budgetExhausted}, accepted=${result.acceptedSteps}, rejected=${result.rejectedSteps}, stepUnderflow=${result.stepUnderflow}, nonFiniteError=${result.nonFiniteError}`,
      );
    }
    samples.push({
      timeSec: endTimeSec,
      state: Array.from(nextState),
      acceptedSteps: result.acceptedSteps,
      rejectedSteps: result.rejectedSteps,
    });
    const swap = currentState;
    currentState = nextState;
    nextState = swap;
  }

  return {
    schemaVersion: 1,
    scenarioId: scenario.id,
    epoch: scenario.epoch,
    durationSec: GOLDEN_DURATION_SEC,
    sampleIntervalSec: GOLDEN_SAMPLE_INTERVAL_SEC,
    integration: { profile: 'production-ship-dp54', maxAcceptedStepsPerSegment: maxAcceptedSteps },
    parameters: scenario.parameters,
    initialState: Array.from(scenario.initialState),
    samples,
  };
}
