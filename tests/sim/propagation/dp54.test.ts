import { describe, expect, it } from 'vitest';

import {
  createDp54Result,
  createDp54Workspace,
  createShipDp54Tolerance,
  propagate,
} from '../../../src/sim/propagation/dp54.js';

const MU_KM3_S2 = 398_600.4418;

function twoBodyDerivative(_timeSec: number, state: Float64Array, output: Float64Array): void {
  const x = state[0] as number;
  const y = state[1] as number;
  const z = state[2] as number;
  const inverseRadiusCubed = 1 / Math.pow(Math.hypot(x, y, z), 3);

  output[0] = state[3] as number;
  output[1] = state[4] as number;
  output[2] = state[5] as number;
  output[3] = -MU_KM3_S2 * x * inverseRadiusCubed;
  output[4] = -MU_KM3_S2 * y * inverseRadiusCubed;
  output[5] = -MU_KM3_S2 * z * inverseRadiusCubed;
}

function specificEnergy(state: Float64Array): number {
  const radius = Math.hypot(state[0] as number, state[1] as number, state[2] as number);
  const speedSquared =
    (state[3] as number) ** 2 + (state[4] as number) ** 2 + (state[5] as number) ** 2;
  return speedSquared / 2 - MU_KM3_S2 / radius;
}

function angularMomentumMagnitude(state: Float64Array): number {
  const x = state[0] as number;
  const y = state[1] as number;
  const z = state[2] as number;
  const vx = state[3] as number;
  const vy = state[4] as number;
  const vz = state[5] as number;
  return Math.hypot(y * vz - z * vy, z * vx - x * vz, x * vy - y * vx);
}

function expectTenPeriodOrbit(semimajorAxisKm: number, eccentricity: number): void {
  const periapsisKm = semimajorAxisKm * (1 - eccentricity);
  const periapsisSpeedKmSec = Math.sqrt(
    (MU_KM3_S2 * (1 + eccentricity)) / (semimajorAxisKm * (1 - eccentricity)),
  );
  const initial = new Float64Array([periapsisKm, 0, 0, 0, periapsisSpeedKmSec, 0]);
  const output = new Float64Array(6);
  const periodSec = 2 * Math.PI * Math.sqrt(semimajorAxisKm ** 3 / MU_KM3_S2);
  const result = createDp54Result();

  propagate(
    output,
    initial,
    0,
    10 * periodSec,
    twoBodyDerivative,
    {
      absolute: new Float64Array([2e-8, 2e-8, 2e-8, 2e-11, 2e-11, 2e-11]),
      relative: 2e-11,
      initialStepSec: 1,
      maxAcceptedSteps: 4_000,
    },
    createDp54Workspace(6),
    result,
  );

  const positionErrorKm = Math.hypot(
    (output[0] as number) - (initial[0] as number),
    (output[1] as number) - (initial[1] as number),
    (output[2] as number) - (initial[2] as number),
  );
  const energyDrift =
    Math.abs(specificEnergy(output) - specificEnergy(initial)) / Math.abs(specificEnergy(initial));
  const angularMomentumDrift =
    Math.abs(angularMomentumMagnitude(output) - angularMomentumMagnitude(initial)) /
    angularMomentumMagnitude(initial);

  expect(
    result.reachedEnd,
    `accepted=${result.acceptedSteps}, reached=${result.reachedTimeSec}`,
  ).toBe(true);
  expect(result.acceptedSteps).toBeLessThanOrEqual(4_000);
  expect(positionErrorKm, `accepted=${result.acceptedSteps}`).toBeLessThan(1e-3);
  expect(energyDrift, `accepted=${result.acceptedSteps}`).toBeLessThan(1e-9);
  expect(angularMomentumDrift, `accepted=${result.acceptedSteps}`).toBeLessThan(1e-9);
}

describe('dp54 - physics-spec.md section 3.1 / section 7.2', () => {
  it('provides the seven-component ship tolerance profile and 4000-step budget', () => {
    const tolerance = createShipDp54Tolerance();

    expect([...tolerance.absolute]).toEqual([1e-6, 1e-6, 1e-6, 1e-9, 1e-9, 1e-9, 1e-6]);
    expect(tolerance.relative).toBe(1e-9);
    expect(tolerance.initialStepSec).toBe(1);
    expect(tolerance.maxAcceptedSteps).toBe(4_000);
  });

  it('holds circular-orbit position and invariants for ten periods', () => {
    expectTenPeriodOrbit(7_000, 0);
  });

  it('holds eccentric-orbit position and invariants for ten periods', () => {
    expectTenPeriodOrbit(20_000, 0.7);
  });
});
