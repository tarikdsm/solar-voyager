import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../../src/core/constants.js';
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

describe('relativistic kinematics - physics-spec.md section 3 / section 6', () => {
  const celerityAtGammaTwoKmSec = Math.sqrt(3) * SPEED_OF_LIGHT_KM_S;

  it('derives gamma and coordinate velocity from celerity', () => {
    const velocity = new Float64Array(3);

    coordinateVelocityInto(velocity, celerityAtGammaTwoKmSec, 0, 0);

    expect(lorentzFactorFromCelerity(celerityAtGammaTwoKmSec, 0, 0)).toBeCloseTo(2, 14);
    expect((velocity[0] as number) / SPEED_OF_LIGHT_KM_S).toBeCloseTo(
      Math.sqrt(3) / 2,
      14,
    );
    expect(velocity[1]).toBe(0);
    expect(velocity[2]).toBe(0);
  });

  it('reports speed as a fraction of light speed', () => {
    expect(speedFractionOfLightFromCelerity(celerityAtGammaTwoKmSec, 0, 0)).toBeCloseTo(
      Math.sqrt(3) / 2,
      14,
    );
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
});
