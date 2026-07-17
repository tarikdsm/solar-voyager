import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import {
  createDp54Result,
  createDp54Workspace,
  createShipDp54Tolerance,
  propagate,
} from '../propagation/dp54.js';
import {
  coordinateVelocityInto,
  createRelativisticDerivative,
  RELATIVISTIC_STATE_DIMENSION,
  STATE_UX,
} from './relativity.js';
import {
  DEFAULT_MAX_PROPER_ACCELERATION_M_S2,
  photonDrivePowerW,
  validateMaxProperAcceleration,
  writeProperAccelerationInto,
  writeThrustForceInto,
} from './thrust.js';

describe('ship proper thrust', () => {
  it('scales the default 1 g proper acceleration by throttle and direction', () => {
    const acceleration = new Float64Array(3);
    writeProperAccelerationInto(
      acceleration,
      new Float64Array([0, 0.6, 0.8]),
      0.25,
      DEFAULT_MAX_PROPER_ACCELERATION_M_S2 / 1_000,
    );

    expect(Array.from(acceleration)).toEqual([
      0,
      0.25 * 0.6 * (DEFAULT_MAX_PROPER_ACCELERATION_M_S2 / 1_000),
      0.25 * 0.8 * (DEFAULT_MAX_PROPER_ACCELERATION_M_S2 / 1_000),
    ]);
  });

  it('writes force in newtons and photon-drive power in watts', () => {
    const massKg = 12_000;
    const accelerationKmS2 = new Float64Array([0.003, -0.004, 0]);
    const forceN = new Float64Array(3);

    writeThrustForceInto(forceN, accelerationKmS2, massKg);

    expect(Array.from(forceN)).toEqual([36_000, -48_000, 0]);
    expect(photonDrivePowerW(accelerationKmS2, massKg)).toBe(60_000 * SPEED_OF_LIGHT_KM_S * 1_000);
  });

  it('produces zero acceleration, force, and power at zero throttle', () => {
    const acceleration = new Float64Array(3);
    const force = new Float64Array(3);
    writeProperAccelerationInto(acceleration, new Float64Array([1, 0, 0]), 0, 0.01);
    writeThrustForceInto(force, acceleration, 10_000);
    expect(acceleration).toEqual(new Float64Array(3));
    expect(force).toEqual(new Float64Array(3));
    expect(photonDrivePowerW(acceleration, 10_000)).toBe(0);
  });

  it('recovers the alpha/gamma^3 parallel coordinate-acceleration law at gamma 2', () => {
    const properAccelerationKmS2 = 0.01;
    const durationSec = 0.1;
    const state = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    state[STATE_UX] = Math.sqrt(3) * SPEED_OF_LIGHT_KM_S;
    const initialVelocity = new Float64Array(3);
    coordinateVelocityInto(initialVelocity, state[STATE_UX] as number, 0, 0);
    const output = new Float64Array(RELATIVISTIC_STATE_DIMENSION);
    const result = createDp54Result();
    const derivative = createRelativisticDerivative(
      (_timeSec, _state, acceleration) => acceleration.fill(0),
      (_timeSec, _state, acceleration) => {
        acceleration[0] = properAccelerationKmS2;
        acceleration[1] = 0;
        acceleration[2] = 0;
      },
    );

    propagate(
      output,
      state,
      0,
      durationSec,
      derivative,
      createShipDp54Tolerance(),
      createDp54Workspace(RELATIVISTIC_STATE_DIMENSION),
      result,
    );
    const finalVelocity = new Float64Array(3);
    coordinateVelocityInto(finalVelocity, output[STATE_UX] as number, 0, 0);
    const measuredCoordinateAcceleration =
      ((finalVelocity[0] as number) - (initialVelocity[0] as number)) / durationSec;

    expect(result.reachedEnd).toBe(true);
    expect(measuredCoordinateAcceleration).toBeCloseTo(properAccelerationKmS2 / 8, 8);
  });

  it('validates configurable maximum proper acceleration', () => {
    expect(validateMaxProperAcceleration(DEFAULT_MAX_PROPER_ACCELERATION_M_S2)).toBe(
      DEFAULT_MAX_PROPER_ACCELERATION_M_S2 / 1_000,
    );
    expect(() => validateMaxProperAcceleration(0)).toThrow(/maximum proper acceleration/u);
    expect(() => validateMaxProperAcceleration(Number.NaN)).toThrow(/maximum proper acceleration/u);
  });
});
