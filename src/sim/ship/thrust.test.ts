import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import {
  DEFAULT_MAX_PROPER_ACCELERATION_M_S2,
  parallelCoordinateAccelerationKmS2,
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
    expect(parallelCoordinateAccelerationKmS2(0.01, 2)).toBe(0.01 / 8);
  });

  it('validates configurable maximum proper acceleration', () => {
    expect(validateMaxProperAcceleration(DEFAULT_MAX_PROPER_ACCELERATION_M_S2)).toBe(
      DEFAULT_MAX_PROPER_ACCELERATION_M_S2 / 1_000,
    );
    expect(() => validateMaxProperAcceleration(0)).toThrow(/maximum proper acceleration/u);
    expect(() => validateMaxProperAcceleration(Number.NaN)).toThrow(/maximum proper acceleration/u);
  });
});
