import { vec3, type Vec3 } from '../../core/vec3.js';
import {
  createKeplerSolution,
  solveKeplerEllipticInto,
  solveKeplerHyperbolicInto,
  type KeplerSolution,
} from './kepler.js';

// physics-spec.md §2 / §7.1 — osculating elements and Cartesian state vectors.

const NUMERICAL_DEGENERACY_LIMIT = 64 * Number.EPSILON;
const ENERGY_CONDITION_LIMIT = Math.cbrt(Number.EPSILON);
const FULL_TURN_RAD = 2 * Math.PI;

/** Classical osculating elements using the units and frame conventions from §1/§2. */
export interface OrbitalElements {
  semiMajorAxisKm: number;
  eccentricity: number;
  inclinationRad: number;
  longitudeAscendingNodeRad: number;
  argumentPeriapsisRad: number;
  meanAnomalyRad: number;
}

/** Cartesian position and velocity in one common inertial frame. */
export interface CartesianState {
  readonly positionKm: Vec3;
  readonly velocityKmS: Vec3;
}

/** Caller-owned scratch storage required by allocation-free element propagation. */
export interface OrbitalConversionScratch {
  readonly keplerSolution: KeplerSolution;
}

/** Allocates a zero Cartesian state for reuse by conversion functions. */
export function createCartesianState(): CartesianState {
  return { positionKm: vec3(), velocityKmS: vec3() };
}

/** Allocates a zero element set for reuse by conversion functions. */
export function createOrbitalElements(): OrbitalElements {
  return {
    semiMajorAxisKm: 0,
    eccentricity: 0,
    inclinationRad: 0,
    longitudeAscendingNodeRad: 0,
    argumentPeriapsisRad: 0,
    meanAnomalyRad: 0,
  };
}

/** Allocates solver scratch once for repeated conversions in the frame loop. */
export function createOrbitalConversionScratch(): OrbitalConversionScratch {
  return { keplerSolution: createKeplerSolution() };
}

function normalizeAngle(angleRad: number): number {
  const normalized = angleRad % FULL_TURN_RAD;
  if (normalized === 0) {
    return 0;
  }
  const positive = normalized < 0 ? normalized + FULL_TURN_RAD : normalized;
  return positive === FULL_TURN_RAD ? 0 : positive;
}

/**
 * Converts elements to Cartesian state without allocating.
 * Applies `Rz(Ω)·Rx(i)·Rz(ω)` after evaluating the perifocal state (§2).
 */
export function elementsToStateInto(
  output: CartesianState,
  elements: Readonly<OrbitalElements>,
  parentMuKm3S2: number,
  scratch: OrbitalConversionScratch,
): CartesianState {
  const aKm = elements.semiMajorAxisKm;
  const eccentricity = elements.eccentricity;
  let perifocalXKm: number;
  let perifocalYKm: number;
  let perifocalVelocityXKmS: number;
  let perifocalVelocityYKmS: number;

  if (eccentricity < 1) {
    solveKeplerEllipticInto(scratch.keplerSolution, elements.meanAnomalyRad, eccentricity);
    const eccentricAnomalyRad = scratch.keplerSolution.anomalyRad;
    const cosineAnomaly = Math.cos(eccentricAnomalyRad);
    const sineAnomaly = Math.sin(eccentricAnomalyRad);
    const minorAxisFactor = Math.sqrt(1 - eccentricity * eccentricity);
    const radiusKm = aKm * (1 - eccentricity * cosineAnomaly);
    const velocityFactor = Math.sqrt(parentMuKm3S2 * aKm) / radiusKm;

    perifocalXKm = aKm * (cosineAnomaly - eccentricity);
    perifocalYKm = aKm * minorAxisFactor * sineAnomaly;
    perifocalVelocityXKmS = -velocityFactor * sineAnomaly;
    perifocalVelocityYKmS = velocityFactor * minorAxisFactor * cosineAnomaly;
  } else {
    solveKeplerHyperbolicInto(scratch.keplerSolution, elements.meanAnomalyRad, eccentricity);
    const hyperbolicAnomalyRad = scratch.keplerSolution.anomalyRad;
    const hyperbolicCosine = Math.cosh(hyperbolicAnomalyRad);
    const hyperbolicSine = Math.sinh(hyperbolicAnomalyRad);
    const transverseFactor = Math.sqrt(eccentricity * eccentricity - 1);
    const denominator = eccentricity * hyperbolicCosine - 1;
    const cosineTrueAnomaly = (eccentricity - hyperbolicCosine) / denominator;
    const sineTrueAnomaly = (transverseFactor * hyperbolicSine) / denominator;
    const semilatusRectumKm = -aKm * (eccentricity * eccentricity - 1);
    const velocityFactor = Math.sqrt(parentMuKm3S2 / semilatusRectumKm);

    if (hyperbolicAnomalyRad === 0) {
      perifocalXKm = semilatusRectumKm / (1 + eccentricity);
      perifocalYKm = 0;
    } else {
      perifocalXKm = aKm * (hyperbolicCosine - eccentricity);
      perifocalYKm = -aKm * transverseFactor * hyperbolicSine;
    }
    perifocalVelocityXKmS = -velocityFactor * sineTrueAnomaly;
    perifocalVelocityYKmS = velocityFactor * (eccentricity + cosineTrueAnomaly);
  }

  const cosineNode = Math.cos(elements.longitudeAscendingNodeRad);
  const sineNode = Math.sin(elements.longitudeAscendingNodeRad);
  const cosineInclination = Math.cos(elements.inclinationRad);
  const sineInclination = Math.sin(elements.inclinationRad);
  const cosinePeriapsis = Math.cos(elements.argumentPeriapsisRad);
  const sinePeriapsis = Math.sin(elements.argumentPeriapsisRad);
  const rotation11 = cosineNode * cosinePeriapsis - sineNode * sinePeriapsis * cosineInclination;
  const rotation12 = -cosineNode * sinePeriapsis - sineNode * cosinePeriapsis * cosineInclination;
  const rotation21 = sineNode * cosinePeriapsis + cosineNode * sinePeriapsis * cosineInclination;
  const rotation22 = -sineNode * sinePeriapsis + cosineNode * cosinePeriapsis * cosineInclination;
  const rotation31 = sinePeriapsis * sineInclination;
  const rotation32 = cosinePeriapsis * sineInclination;

  output.positionKm.x = rotation11 * perifocalXKm + rotation12 * perifocalYKm;
  output.positionKm.y = rotation21 * perifocalXKm + rotation22 * perifocalYKm;
  output.positionKm.z = rotation31 * perifocalXKm + rotation32 * perifocalYKm;
  output.velocityKmS.x = rotation11 * perifocalVelocityXKmS + rotation12 * perifocalVelocityYKmS;
  output.velocityKmS.y = rotation21 * perifocalVelocityXKmS + rotation22 * perifocalVelocityYKmS;
  output.velocityKmS.z = rotation31 * perifocalVelocityXKmS + rotation32 * perifocalVelocityYKmS;
  return output;
}

/** Converts a Cartesian state to canonical osculating elements without allocating. */
export function stateToElementsInto(
  output: OrbitalElements,
  state: CartesianState,
  parentMuKm3S2: number,
): OrbitalElements {
  const rx = state.positionKm.x;
  const ry = state.positionKm.y;
  const rz = state.positionKm.z;
  const vx = state.velocityKmS.x;
  const vy = state.velocityKmS.y;
  const vz = state.velocityKmS.z;
  const radiusKm = Math.hypot(rx, ry, rz);
  const velocitySquaredKm2S2 = vx * vx + vy * vy + vz * vz;

  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const angularMomentumKm2S = Math.hypot(hx, hy, hz);
  const nodeX = -hy;
  const nodeY = hx;
  const nodeMagnitude = Math.hypot(nodeX, nodeY);

  const eccentricityX = (vy * hz - vz * hy) / parentMuKm3S2 - rx / radiusKm;
  const eccentricityY = (vz * hx - vx * hz) / parentMuKm3S2 - ry / radiusKm;
  const eccentricityZ = (vx * hy - vy * hx) / parentMuKm3S2 - rz / radiusKm;
  const measuredEccentricity = Math.hypot(eccentricityX, eccentricityY, eccentricityZ);
  const circular = measuredEccentricity <= NUMERICAL_DEGENERACY_LIMIT;
  const equatorial = nodeMagnitude / angularMomentumKm2S <= NUMERICAL_DEGENERACY_LIMIT;
  const retrogradeEquatorial = equatorial && hz < 0;
  const eccentricity = circular ? 0 : measuredEccentricity;
  const semilatusRectumKm = (angularMomentumKm2S * angularMomentumKm2S) / parentMuKm3S2;
  const specificEnergyKm2S2 = velocitySquaredKm2S2 / 2 - parentMuKm3S2 / radiusKm;
  const energyCondition =
    Math.abs(specificEnergyKm2S2) / (velocitySquaredKm2S2 / 2 + parentMuKm3S2 / radiusKm);
  const semiMajorAxisKm =
    energyCondition > ENERGY_CONDITION_LIMIT
      ? -parentMuKm3S2 / (2 * specificEnergyKm2S2)
      : semilatusRectumKm / (1 - eccentricity * eccentricity);
  const inclinationRad = equatorial
    ? retrogradeEquatorial
      ? Math.PI
      : 0
    : Math.atan2(nodeMagnitude, hz);
  const longitudeAscendingNodeRad = equatorial ? 0 : normalizeAngle(Math.atan2(nodeY, nodeX));

  let argumentPeriapsisRad = 0;
  let trueAnomalyRad: number;

  if (!circular) {
    if (equatorial) {
      const periapsisLongitudeRad = Math.atan2(eccentricityY, eccentricityX);
      argumentPeriapsisRad = normalizeAngle(
        retrogradeEquatorial ? -periapsisLongitudeRad : periapsisLongitudeRad,
      );
    } else {
      const crossX = nodeY * eccentricityZ;
      const crossY = -nodeX * eccentricityZ;
      const crossZ = nodeX * eccentricityY - nodeY * eccentricityX;
      const sineArgument =
        (crossX * hx + crossY * hy + crossZ * hz) /
        (nodeMagnitude * eccentricity * angularMomentumKm2S);
      const cosineArgument =
        (nodeX * eccentricityX + nodeY * eccentricityY) / (nodeMagnitude * eccentricity);
      argumentPeriapsisRad = normalizeAngle(Math.atan2(sineArgument, cosineArgument));
    }

    const crossX = eccentricityY * rz - eccentricityZ * ry;
    const crossY = eccentricityZ * rx - eccentricityX * rz;
    const crossZ = eccentricityX * ry - eccentricityY * rx;
    const sineTrueAnomaly =
      (crossX * hx + crossY * hy + crossZ * hz) / (eccentricity * radiusKm * angularMomentumKm2S);
    const cosineTrueAnomaly =
      (eccentricityX * rx + eccentricityY * ry + eccentricityZ * rz) / (eccentricity * radiusKm);
    trueAnomalyRad = Math.atan2(sineTrueAnomaly, cosineTrueAnomaly);
  } else if (!equatorial) {
    const crossX = nodeY * rz;
    const crossY = -nodeX * rz;
    const crossZ = nodeX * ry - nodeY * rx;
    const sineArgumentLatitude =
      (crossX * hx + crossY * hy + crossZ * hz) / (nodeMagnitude * radiusKm * angularMomentumKm2S);
    const cosineArgumentLatitude = (nodeX * rx + nodeY * ry) / (nodeMagnitude * radiusKm);
    trueAnomalyRad = Math.atan2(sineArgumentLatitude, cosineArgumentLatitude);
  } else {
    const longitudeRad = Math.atan2(ry, rx);
    trueAnomalyRad = retrogradeEquatorial ? -longitudeRad : longitudeRad;
  }

  let meanAnomalyRad: number;
  if (eccentricity < 1) {
    const normalizedTrueAnomalyRad = normalizeAngle(trueAnomalyRad);
    if (circular) {
      meanAnomalyRad = normalizedTrueAnomalyRad;
    } else {
      const denominator = 1 + eccentricity * Math.cos(normalizedTrueAnomalyRad);
      const sineEccentricAnomaly =
        (Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(normalizedTrueAnomalyRad)) /
        denominator;
      const cosineEccentricAnomaly =
        (eccentricity + Math.cos(normalizedTrueAnomalyRad)) / denominator;
      const eccentricAnomalyRad = normalizeAngle(
        Math.atan2(sineEccentricAnomaly, cosineEccentricAnomaly),
      );
      meanAnomalyRad = normalizeAngle(
        eccentricAnomalyRad - eccentricity * Math.sin(eccentricAnomalyRad),
      );
    }
  } else {
    const radialDotKm2S = rx * vx + ry * vy + rz * vz;
    const speedKmS = Math.sqrt(velocitySquaredKm2S2);
    if (Math.abs(radialDotKm2S) <= NUMERICAL_DEGENERACY_LIMIT * radiusKm * speedKmS) {
      meanAnomalyRad = 0;
    } else {
      const hyperbolicSine =
        radialDotKm2S / (eccentricity * Math.sqrt(parentMuKm3S2 * -semiMajorAxisKm));
      const hyperbolicAnomalyRad = Math.asinh(hyperbolicSine);
      meanAnomalyRad = eccentricity * hyperbolicSine - hyperbolicAnomalyRad;
    }
  }

  output.semiMajorAxisKm = semiMajorAxisKm;
  output.eccentricity = eccentricity;
  output.inclinationRad = inclinationRad;
  output.longitudeAscendingNodeRad = longitudeAscendingNodeRad;
  output.argumentPeriapsisRad = argumentPeriapsisRad;
  output.meanAnomalyRad = meanAnomalyRad;
  return output;
}
