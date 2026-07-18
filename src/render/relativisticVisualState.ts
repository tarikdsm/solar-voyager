import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import type { SimSnapshot } from '../sim/simulationSnapshot.js';

const ACTIVATION_MAX_GAMMA = 1.05;
const CONSISTENCY_TOLERANCE_ULPS = 128;

type RelativisticSnapshot = Pick<
  SimSnapshot,
  'shipCoordinateVelocityKmS' | 'gamma' | 'speedFractionOfLight'
>;

export interface RelativisticVisualState {
  betaX: number;
  betaY: number;
  betaZ: number;
  gamma: number;
  activation: number;
}

export function createRelativisticVisualState(): RelativisticVisualState {
  return {
    betaX: 0,
    betaY: 0,
    betaZ: 0,
    gamma: 1,
    activation: 0,
  };
}

function areConsistent(actual: number, expected: number): boolean {
  return (
    Math.abs(actual - expected) <=
    CONSISTENCY_TOLERANCE_ULPS * Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected))
  );
}

export function writeRelativisticVisualState(
  output: RelativisticVisualState,
  snapshot: RelativisticSnapshot,
  qualityEnabled: boolean,
): void {
  const velocity = snapshot.shipCoordinateVelocityKmS;
  const velocityX = velocity[0] as number;
  const velocityY = velocity[1] as number;
  const velocityZ = velocity[2] as number;
  const snapshotGamma = snapshot.gamma;
  const snapshotBeta = snapshot.speedFractionOfLight;

  if (
    velocity.length < 3 ||
    !Number.isFinite(velocityX) ||
    !Number.isFinite(velocityY) ||
    !Number.isFinite(velocityZ) ||
    !Number.isFinite(snapshotGamma) ||
    !Number.isFinite(snapshotBeta)
  ) {
    throw new RangeError('Relativistic observer snapshot must contain finite values.');
  }

  const betaX = velocityX / SPEED_OF_LIGHT_KM_S;
  const betaY = velocityY / SPEED_OF_LIGHT_KM_S;
  const betaZ = velocityZ / SPEED_OF_LIGHT_KM_S;
  const betaSquared = betaX * betaX + betaY * betaY + betaZ * betaZ;
  const beta = Math.sqrt(betaSquared);

  if (snapshotBeta < 0 || snapshotBeta >= 1 || beta >= 1 || !areConsistent(snapshotBeta, beta)) {
    throw new RangeError('Relativistic observer beta must be consistent and subluminal.');
  }

  const expectedGamma = 1 / Math.sqrt(1 - betaSquared);
  if (snapshotGamma < 1 || !areConsistent(snapshotGamma, expectedGamma)) {
    throw new RangeError('Relativistic observer gamma must be consistent with velocity.');
  }

  // physics-spec.md section 6.1: presentation fades smoothly over gamma 1..1.05.
  const linearActivation = Math.min(
    1,
    Math.max(0, (snapshotGamma - 1) / (ACTIVATION_MAX_GAMMA - 1)),
  );
  const activation = qualityEnabled
    ? linearActivation * linearActivation * (3 - 2 * linearActivation)
    : 0;

  output.betaX = betaX;
  output.betaY = betaY;
  output.betaZ = betaZ;
  output.gamma = snapshotGamma;
  output.activation = activation;
}

export function writeAberratedPositionInto(
  output: Float64Array,
  relativeX: number,
  relativeY: number,
  relativeZ: number,
  state: Readonly<RelativisticVisualState>,
): void {
  const radius = Math.hypot(relativeX, relativeY, relativeZ);
  if (state.activation === 0 || radius === 0) {
    output[0] = relativeX;
    output[1] = relativeY;
    output[2] = relativeZ;
    return;
  }

  const inverseRadius = 1 / radius;
  const directionX = relativeX * inverseRadius;
  const directionY = relativeY * inverseRadius;
  const directionZ = relativeZ * inverseRadius;
  const betaSquared =
    state.betaX * state.betaX + state.betaY * state.betaY + state.betaZ * state.betaZ;

  if (betaSquared === 0) {
    output[0] = relativeX;
    output[1] = relativeY;
    output[2] = relativeZ;
    return;
  }

  // physics-spec.md section 6.1: Lorentz-transform the source direction.
  const dot = state.betaX * directionX + state.betaY * directionY + state.betaZ * directionZ;
  const boostCoefficient = ((state.gamma - 1) / betaSquared) * dot + state.gamma;
  const inverseDenominator = 1 / (state.gamma * (1 + dot));
  const observedX = (directionX + boostCoefficient * state.betaX) * inverseDenominator;
  const observedY = (directionY + boostCoefficient * state.betaY) * inverseDenominator;
  const observedZ = (directionZ + boostCoefficient * state.betaZ) * inverseDenominator;

  const activation = state.activation;
  const inverseActivation = 1 - activation;
  const blendedX = inverseActivation * directionX + activation * observedX;
  const blendedY = inverseActivation * directionY + activation * observedY;
  const blendedZ = inverseActivation * directionZ + activation * observedZ;
  const radiusScale = radius / Math.hypot(blendedX, blendedY, blendedZ);

  output[0] = blendedX * radiusScale;
  output[1] = blendedY * radiusScale;
  output[2] = blendedZ * radiusScale;
}
