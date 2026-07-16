import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../../src/core/constants.js';
import {
  coordinateVelocityInto,
  lorentzFactorFromCelerity,
  relativisticKineticEnergyJ,
  relativisticMomentumInto,
  speedFractionOfLightFromCelerity,
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
});
