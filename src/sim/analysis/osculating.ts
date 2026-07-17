import {
  createCartesianState,
  createOrbitalElements,
  stateToElementsInto,
  type CartesianState,
  type OrbitalElements,
} from '../bodies/orbitalElements.js';
import {
  createKeplerSolution,
  solveKeplerEllipticInto,
  solveKeplerHyperbolicInto,
  type KeplerSolution,
} from '../bodies/kepler.js';
import type { CompiledRailsCatalog } from '../propagation/rails.js';
import type {
  OsculatingElementsSnapshot,
  SimulationSnapshotBuffer,
} from '../simulationSnapshot.js';
import { selectDominantBodyIndexWithHysteresis } from './dominantBody.js';

const FULL_TURN_RAD = 2 * Math.PI;

/** Preallocated state used by the per-snapshot osculating conversion. */
export interface OsculatingWorkspace {
  readonly relativeState: CartesianState;
  readonly elements: OrbitalElements;
  readonly keplerSolution: KeplerSolution;
  dominantBodyIndex: number;
}

/** Allocates the osculating conversion scratch once during simulation setup. */
export function createOsculatingWorkspace(): OsculatingWorkspace {
  return {
    relativeState: createCartesianState(),
    elements: createOrbitalElements(),
    keplerSolution: createKeplerSolution(),
    dominantBodyIndex: -1,
  };
}

function normalizeAngle(angleRad: number): number {
  const normalized = angleRad % FULL_TURN_RAD;
  return normalized < 0 ? normalized + FULL_TURN_RAD : normalized;
}

function invalidate(elements: OsculatingElementsSnapshot): void {
  elements.valid = false;
  elements.semiMajorAxisKm = Number.NaN;
  elements.eccentricity = Number.NaN;
  elements.inclinationRad = Number.NaN;
  elements.longitudeAscendingNodeRad = Number.NaN;
  elements.argumentPeriapsisRad = Number.NaN;
  elements.trueAnomalyRad = Number.NaN;
  elements.periapsisRadiusKm = Number.NaN;
  elements.apoapsisRadiusKm = Number.NaN;
  elements.periodSec = Number.NaN;
}

function trueAnomalyFromMean(elements: OrbitalElements, solution: KeplerSolution): number {
  const eccentricity = elements.eccentricity;
  if (eccentricity < 1) {
    solveKeplerEllipticInto(solution, elements.meanAnomalyRad, eccentricity);
    if (!solution.converged) return Number.NaN;
    const eccentricAnomalyRad = solution.anomalyRad;
    const denominator = 1 - eccentricity * Math.cos(eccentricAnomalyRad);
    const sineTrueAnomaly =
      (Math.sqrt((1 - eccentricity) * (1 + eccentricity)) * Math.sin(eccentricAnomalyRad)) /
      denominator;
    const cosineTrueAnomaly = (Math.cos(eccentricAnomalyRad) - eccentricity) / denominator;
    return normalizeAngle(Math.atan2(sineTrueAnomaly, cosineTrueAnomaly));
  }

  solveKeplerHyperbolicInto(solution, elements.meanAnomalyRad, eccentricity);
  if (!solution.converged) return Number.NaN;
  const hyperbolicAnomalyRad = solution.anomalyRad;
  const denominator = eccentricity * Math.cosh(hyperbolicAnomalyRad) - 1;
  const sineTrueAnomaly =
    (Math.sqrt((eccentricity - 1) * (eccentricity + 1)) * Math.sinh(hyperbolicAnomalyRad)) /
    denominator;
  const cosineTrueAnomaly = (eccentricity - Math.cosh(hyperbolicAnomalyRad)) / denominator;
  return Math.atan2(sineTrueAnomaly, cosineTrueAnomaly);
}

/** Writes physics-spec.md §6 osculating elements relative to maximum local gravity. */
export function updateOsculatingElements(
  snapshot: SimulationSnapshotBuffer,
  catalog: CompiledRailsCatalog,
  workspace: OsculatingWorkspace,
): void {
  const dominantBodyIndex = selectDominantBodyIndexWithHysteresis(
    snapshot.shipState,
    snapshot.bodyPositionsKm,
    catalog,
    workspace.dominantBodyIndex,
  );
  workspace.dominantBodyIndex = dominantBodyIndex;
  snapshot.dominantBodyIndex = dominantBodyIndex;
  const output = snapshot.osculatingElements;
  if (dominantBodyIndex < 0) {
    invalidate(output);
    return;
  }

  const bodyOffset = dominantBodyIndex * 3;
  const state = workspace.relativeState;
  state.positionKm.x =
    (snapshot.shipState[0] as number) - (snapshot.bodyPositionsKm[bodyOffset] as number);
  state.positionKm.y =
    (snapshot.shipState[1] as number) - (snapshot.bodyPositionsKm[bodyOffset + 1] as number);
  state.positionKm.z =
    (snapshot.shipState[2] as number) - (snapshot.bodyPositionsKm[bodyOffset + 2] as number);
  state.velocityKmS.x =
    (snapshot.shipCoordinateVelocityKmS[0] as number) -
    (snapshot.bodyVelocitiesKmS[bodyOffset] as number);
  state.velocityKmS.y =
    (snapshot.shipCoordinateVelocityKmS[1] as number) -
    (snapshot.bodyVelocitiesKmS[bodyOffset + 1] as number);
  state.velocityKmS.z =
    (snapshot.shipCoordinateVelocityKmS[2] as number) -
    (snapshot.bodyVelocitiesKmS[bodyOffset + 2] as number);

  const radiusKm = Math.hypot(state.positionKm.x, state.positionKm.y, state.positionKm.z);
  const speedKmS = Math.hypot(state.velocityKmS.x, state.velocityKmS.y, state.velocityKmS.z);
  const muKm3S2 = catalog.muKm3S2[dominantBodyIndex] as number;
  if (
    !Number.isFinite(radiusKm) ||
    radiusKm <= 0 ||
    !Number.isFinite(speedKmS) ||
    !Number.isFinite(muKm3S2) ||
    muKm3S2 <= 0
  ) {
    invalidate(output);
    return;
  }

  const elements = stateToElementsInto(workspace.elements, state, muKm3S2);
  const elliptic = elements.eccentricity < 1;
  const validBranch =
    (elliptic && elements.semiMajorAxisKm > 0 && elements.eccentricity >= 0) ||
    (!elliptic && elements.semiMajorAxisKm < 0 && elements.eccentricity > 1);
  const trueAnomalyRad = validBranch
    ? trueAnomalyFromMean(elements, workspace.keplerSolution)
    : Number.NaN;
  const periapsisRadiusKm = elements.semiMajorAxisKm * (1 - elements.eccentricity);
  if (
    !validBranch ||
    !Number.isFinite(elements.inclinationRad) ||
    !Number.isFinite(elements.longitudeAscendingNodeRad) ||
    !Number.isFinite(elements.argumentPeriapsisRad) ||
    !Number.isFinite(trueAnomalyRad) ||
    !Number.isFinite(periapsisRadiusKm) ||
    periapsisRadiusKm <= 0
  ) {
    invalidate(output);
    return;
  }

  output.valid = true;
  output.semiMajorAxisKm = elements.semiMajorAxisKm;
  output.eccentricity = elements.eccentricity;
  output.inclinationRad = elements.inclinationRad;
  output.longitudeAscendingNodeRad = elements.longitudeAscendingNodeRad;
  output.argumentPeriapsisRad = elements.argumentPeriapsisRad;
  output.trueAnomalyRad = trueAnomalyRad;
  output.periapsisRadiusKm = periapsisRadiusKm;
  output.apoapsisRadiusKm = elliptic
    ? elements.semiMajorAxisKm * (1 + elements.eccentricity)
    : Number.POSITIVE_INFINITY;
  output.periodSec = elliptic
    ? FULL_TURN_RAD * Math.sqrt(elements.semiMajorAxisKm ** 3 / muKm3S2)
    : Number.POSITIVE_INFINITY;
}
