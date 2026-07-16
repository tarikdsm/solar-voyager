import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../../src/core/constants.js';
import {
  createDp54Result,
  createDp54Workspace,
  createShipDp54Tolerance,
  propagate,
  type Dp54Tolerance,
} from '../../../src/sim/propagation/dp54.js';
import {
  createRelativisticDerivative,
  coordinateVelocityInto,
  lorentzFactorFromCelerity,
  RELATIVISTIC_STATE_DIMENSION,
  relativisticKineticEnergyJ,
  relativisticMomentumInto,
  speedFractionOfLightFromCelerity,
  STATE_RX,
  STATE_RY,
  STATE_RZ,
  STATE_TAU,
  STATE_UX,
  STATE_UY,
  STATE_UZ,
} from '../../../src/sim/ship/relativity.js';

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected));
}

function writeZeroAcceleration(_timeSec: number, _state: Float64Array, output: Float64Array): void {
  output[0] = 0;
  output[1] = 0;
  output[2] = 0;
}

describe('relativistic kinematics - physics-spec.md section 3 / section 6', () => {
  const celerityAtGammaTwoKmSec = Math.sqrt(3) * SPEED_OF_LIGHT_KM_S;

  it('derives gamma and coordinate velocity from celerity', () => {
    const velocity = new Float64Array(3);

    coordinateVelocityInto(velocity, celerityAtGammaTwoKmSec, 0, 0);

    expect(lorentzFactorFromCelerity(celerityAtGammaTwoKmSec, 0, 0)).toBeCloseTo(2, 14);
    expect((velocity[0] as number) / SPEED_OF_LIGHT_KM_S).toBeCloseTo(Math.sqrt(3) / 2, 14);
    expect(velocity[1]).toBe(0);
    expect(velocity[2]).toBe(0);
  });

  it('reports speed as a fraction of light speed', () => {
    expect(speedFractionOfLightFromCelerity(celerityAtGammaTwoKmSec, 0, 0)).toBeCloseTo(
      Math.sqrt(3) / 2,
      14,
    );
  });

  it('preserves a representable speed below light speed at extreme finite celerity', () => {
    const targetGamma = 1e8;
    const extremeCelerityKmSec = Math.sqrt(targetGamma ** 2 - 1) * SPEED_OF_LIGHT_KM_S;
    const velocity = new Float64Array(3);

    coordinateVelocityInto(velocity, extremeCelerityKmSec, 0, 0);

    expect(Math.hypot(...velocity)).toBeLessThan(SPEED_OF_LIGHT_KM_S);
    expect(speedFractionOfLightFromCelerity(extremeCelerityKmSec, 0, 0)).toBeLessThan(1);

    coordinateVelocityInto(velocity, 1e300, -1e300, 1e300);
    expect([...velocity].every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...velocity)).toBeLessThan(SPEED_OF_LIGHT_KM_S);

    const state = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const derivativeOutput = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    state[STATE_UX] = 1e300;
    state[STATE_UY] = -1e300;
    state[STATE_UZ] = 1e300;
    createRelativisticDerivative(writeZeroAcceleration, writeZeroAcceleration)(
      0,
      state,
      derivativeOutput,
    );
    expect(
      Math.hypot(
        derivativeOutput[STATE_RX] as number,
        derivativeOutput[STATE_RY] as number,
        derivativeOutput[STATE_RZ] as number,
      ),
    ).toBeLessThan(SPEED_OF_LIGHT_KM_S);
  });

  it('calculates relativistic momentum from celerity', () => {
    const momentum = new Float64Array(3);

    relativisticMomentumInto(momentum, celerityAtGammaTwoKmSec, 2, -3, 5);

    expect(momentum[0]).toBe(5 * celerityAtGammaTwoKmSec);
    expect(momentum[1]).toBe(10);
    expect(momentum[2]).toBe(-15);
  });

  it('calculates kinetic energy in joules without low-speed cancellation', () => {
    const massKg = 5;
    const lightSpeedMetersSec = SPEED_OF_LIGHT_KM_S * 1_000;
    const restEnergyJ = massKg * lightSpeedMetersSec ** 2;

    expect(
      relativisticKineticEnergyJ(celerityAtGammaTwoKmSec, 0, 0, massKg) / restEnergyJ,
    ).toBeCloseTo(1, 14);

    const lowCelerityKmSec = 1e-6;
    const newtonianEnergyJ = 0.5 * massKg * (lowCelerityKmSec * 1_000) ** 2;
    expect(relativisticKineticEnergyJ(lowCelerityKmSec, 0, 0, massKg)).toBeCloseTo(
      newtonianEnergyJ,
      14,
    );
  });

  it('combines gravity and proper acceleration in a reusable ship derivative', () => {
    const gravityBuffers: Float64Array[] = [];
    const thrustBuffers: Float64Array[] = [];
    const derivative = createRelativisticDerivative(
      (_timeSec, _state, output) => {
        gravityBuffers.push(output);
        output[0] = 1;
        output[1] = 2;
        output[2] = 3;
      },
      (_timeSec, _state, output) => {
        thrustBuffers.push(output);
        output[0] = 4;
        output[1] = 5;
        output[2] = 6;
      },
    );
    const state = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const output = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    state[STATE_RX] = 10;
    state[STATE_RY] = 20;
    state[STATE_RZ] = 30;
    state[STATE_UX] = celerityAtGammaTwoKmSec;
    state[STATE_UY] = 0;
    state[STATE_UZ] = 0;
    state[STATE_TAU] = 40;

    derivative(50, state, output);
    derivative(51, state, output);

    expect(output[STATE_RX]).toBeCloseTo((Math.sqrt(3) / 2) * SPEED_OF_LIGHT_KM_S, 9);
    expect(output[STATE_RY]).toBe(0);
    expect(output[STATE_RZ]).toBe(0);
    expect(output[STATE_UX]).toBe(5);
    expect(output[STATE_UY]).toBe(7);
    expect(output[STATE_UZ]).toBe(9);
    expect(output[STATE_TAU]).toBeCloseTo(0.5, 14);
    expect(gravityBuffers).toHaveLength(2);
    expect(thrustBuffers).toHaveLength(2);
    expect(gravityBuffers[1]).toBe(gravityBuffers[0]);
    expect(thrustBuffers[1]).toBe(thrustBuffers[0]);
    expect(gravityBuffers[0]).not.toBe(thrustBuffers[0]);
  });

  it('matches analytic hyperbolic motion through gamma ten', () => {
    const properAccelerationKmSec2 = 0.01;
    const targetGamma = 10;
    const endTimeSec =
      (SPEED_OF_LIGHT_KM_S * Math.sqrt(targetGamma ** 2 - 1)) / properAccelerationKmSec2;
    const initial = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const output = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const result = createDp54Result();
    const derivative = createRelativisticDerivative(
      writeZeroAcceleration,
      (_timeSec, _state, acceleration) => {
        acceleration[0] = properAccelerationKmSec2;
        acceleration[1] = 0;
        acceleration[2] = 0;
      },
    );

    propagate(
      output,
      initial,
      0,
      endTimeSec,
      derivative,
      createShipDp54Tolerance(60),
      createDp54Workspace(RELATIVISTIC_STATE_DIMENSION),
      result,
    );

    const velocity = new Float64Array(3);
    coordinateVelocityInto(
      velocity,
      output[STATE_UX] as number,
      output[STATE_UY] as number,
      output[STATE_UZ] as number,
    );
    const accelerationTimeRatio = (properAccelerationKmSec2 * endTimeSec) / SPEED_OF_LIGHT_KM_S;
    const expectedVelocityKmSec =
      (properAccelerationKmSec2 * endTimeSec) / Math.sqrt(1 + accelerationTimeRatio ** 2);
    const expectedProperTimeSec =
      (SPEED_OF_LIGHT_KM_S / properAccelerationKmSec2) * Math.asinh(accelerationTimeRatio);

    expect(result.reachedEnd).toBe(true);
    expect(result.acceptedSteps).toBeLessThanOrEqual(4_000);
    expect(relativeError(velocity[0] as number, expectedVelocityKmSec)).toBeLessThan(1e-9);
    expect(relativeError(output[STATE_TAU] as number, expectedProperTimeSec)).toBeLessThan(1e-9);
    expect(
      relativeError(
        lorentzFactorFromCelerity(
          output[STATE_UX] as number,
          output[STATE_UY] as number,
          output[STATE_UZ] as number,
        ),
        targetGamma,
      ),
    ).toBeLessThan(1e-9);
    expect(Math.hypot(...velocity)).toBeLessThan(SPEED_OF_LIGHT_KM_S);
  });

  it('agrees with Newtonian propagation over ten LEO orbits', () => {
    const earthMuKm3Sec2 = 398_600.4418;
    const orbitRadiusKm = 6_778.137;
    const circularSpeedKmSec = Math.sqrt(earthMuKm3Sec2 / orbitRadiusKm);
    const periodSec = 2 * Math.PI * Math.sqrt(orbitRadiusKm ** 3 / earthMuKm3Sec2);
    const endTimeSec = 10 * periodSec;
    const velocityGamma = 1 / Math.sqrt(1 - (circularSpeedKmSec / SPEED_OF_LIGHT_KM_S) ** 2);
    const newtonianInitial = new Float64Array([orbitRadiusKm, 0, 0, 0, circularSpeedKmSec, 0]);
    const relativisticInitial = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    relativisticInitial[STATE_RX] = orbitRadiusKm;
    relativisticInitial[STATE_UY] = velocityGamma * circularSpeedKmSec;
    const newtonianOutput = new Float64Array(6);
    const relativisticOutput = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const verificationTolerance: Dp54Tolerance = {
      absolute: new Float64Array([2e-8, 2e-8, 2e-8, 2e-11, 2e-11, 2e-11]),
      relative: 2e-11,
      initialStepSec: 1,
      maxAcceptedSteps: 4_000,
    };
    const shipVerificationTolerance: Dp54Tolerance = {
      ...verificationTolerance,
      absolute: new Float64Array([2e-8, 2e-8, 2e-8, 2e-11, 2e-11, 2e-11, 1e-6]),
    };
    const newtonianResult = createDp54Result();
    const relativisticResult = createDp54Result();

    propagate(
      newtonianOutput,
      newtonianInitial,
      0,
      endTimeSec,
      (_timeSec, state, derivative) => {
        const x = state[0] as number;
        const y = state[1] as number;
        const z = state[2] as number;
        const inverseRadiusCubed = 1 / Math.hypot(x, y, z) ** 3;
        derivative[0] = state[3] as number;
        derivative[1] = state[4] as number;
        derivative[2] = state[5] as number;
        derivative[3] = -earthMuKm3Sec2 * x * inverseRadiusCubed;
        derivative[4] = -earthMuKm3Sec2 * y * inverseRadiusCubed;
        derivative[5] = -earthMuKm3Sec2 * z * inverseRadiusCubed;
      },
      verificationTolerance,
      createDp54Workspace(6),
      newtonianResult,
    );

    propagate(
      relativisticOutput,
      relativisticInitial,
      0,
      endTimeSec,
      createRelativisticDerivative((_timeSec, state, acceleration) => {
        const x = state[STATE_RX] as number;
        const y = state[STATE_RY] as number;
        const z = state[STATE_RZ] as number;
        const inverseRadiusCubed = 1 / Math.hypot(x, y, z) ** 3;
        acceleration[0] = -earthMuKm3Sec2 * x * inverseRadiusCubed;
        acceleration[1] = -earthMuKm3Sec2 * y * inverseRadiusCubed;
        acceleration[2] = -earthMuKm3Sec2 * z * inverseRadiusCubed;
      }, writeZeroAcceleration),
      shipVerificationTolerance,
      createDp54Workspace(RELATIVISTIC_STATE_DIMENSION),
      relativisticResult,
    );

    const finalSeparationKm = Math.hypot(
      (relativisticOutput[STATE_RX] as number) - (newtonianOutput[0] as number),
      (relativisticOutput[STATE_RY] as number) - (newtonianOutput[1] as number),
      (relativisticOutput[STATE_RZ] as number) - (newtonianOutput[2] as number),
    );

    expect(newtonianResult.reachedEnd).toBe(true);
    expect(relativisticResult.reachedEnd).toBe(true);
    const relativeFinalSeparation = finalSeparationKm / orbitRadiusKm;
    expect(relativeFinalSeparation).toBeGreaterThan(4e-8);
    expect(relativeFinalSeparation).toBeLessThan(5e-8);
  });

  it('integrates one year of proper time at gamma two', () => {
    const coordinateYearSec = 365.25 * 86_400;
    const initial = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    initial[STATE_UX] = celerityAtGammaTwoKmSec;
    const output = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const result = createDp54Result();

    propagate(
      output,
      initial,
      0,
      coordinateYearSec,
      createRelativisticDerivative(writeZeroAcceleration, writeZeroAcceleration),
      createShipDp54Tolerance(60),
      createDp54Workspace(RELATIVISTIC_STATE_DIMENSION),
      result,
    );

    expect(result.reachedEnd).toBe(true);
    expect(relativeError(output[STATE_TAU] as number, coordinateYearSec / 2)).toBeLessThan(1e-9);
  });

  it('keeps every evaluated velocity subluminal under high-celerity stress', () => {
    const properAccelerationKmSec2 = 0.01;
    const targetGamma = 1_000;
    const endTimeSec =
      (SPEED_OF_LIGHT_KM_S * Math.sqrt(targetGamma ** 2 - 1)) / properAccelerationKmSec2;
    const initial = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const output = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const result = createDp54Result();
    let allEvaluatedSpeedsAreSubluminal = true;
    const derivative = createRelativisticDerivative(
      writeZeroAcceleration,
      (_timeSec, state, acceleration) => {
        const speedFraction = speedFractionOfLightFromCelerity(
          state[STATE_UX] as number,
          state[STATE_UY] as number,
          state[STATE_UZ] as number,
        );
        allEvaluatedSpeedsAreSubluminal &&= Number.isFinite(speedFraction) && speedFraction < 1;
        acceleration[0] = properAccelerationKmSec2;
        acceleration[1] = 0;
        acceleration[2] = 0;
      },
    );

    propagate(
      output,
      initial,
      0,
      endTimeSec,
      derivative,
      createShipDp54Tolerance(60),
      createDp54Workspace(RELATIVISTIC_STATE_DIMENSION),
      result,
    );

    const finalSpeedFraction = speedFractionOfLightFromCelerity(
      output[STATE_UX] as number,
      output[STATE_UY] as number,
      output[STATE_UZ] as number,
    );

    expect(result.reachedEnd).toBe(true);
    expect(allEvaluatedSpeedsAreSubluminal).toBe(true);
    expect(finalSpeedFraction).toBeLessThan(1);
    expect(
      relativeError(
        lorentzFactorFromCelerity(
          output[STATE_UX] as number,
          output[STATE_UY] as number,
          output[STATE_UZ] as number,
        ),
        targetGamma,
      ),
    ).toBeLessThan(1e-9);
  });
});
