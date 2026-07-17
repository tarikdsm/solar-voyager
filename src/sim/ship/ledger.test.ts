import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import {
  BurnLog,
  SIMULATION_STATE_DIMENSION,
  STATE_ENERGY_J,
  STATE_PROPER_DELTA_V_MS,
  STATE_PROPER_DELTA_V_VECTOR_X_MS,
  STATE_PROPER_DELTA_V_VECTOR_Y_MS,
  STATE_PROPER_DELTA_V_VECTOR_Z_MS,
  writeLedgerDerivativeRates,
} from './ledger.js';

describe('photon-drive ledger — physics-spec.md §5', () => {
  it('writes energy, scalar proper-dv, and inertial vector rates', () => {
    const derivative = new Float64Array(SIMULATION_STATE_DIMENSION);
    const accelerationKmS2 = new Float64Array([0.003, 0.004, 0]);

    writeLedgerDerivativeRates(derivative, accelerationKmS2, 0.5, 10);

    expect(derivative[STATE_ENERGY_J]).toBeCloseTo(10 * 5 * SPEED_OF_LIGHT_KM_S * 1_000, 8);
    expect(derivative[STATE_PROPER_DELTA_V_MS]).toBe(2.5);
    expect(derivative[STATE_PROPER_DELTA_V_VECTOR_X_MS]).toBe(1.5);
    expect(derivative[STATE_PROPER_DELTA_V_VECTOR_Y_MS]).toBe(2);
    expect(derivative[STATE_PROPER_DELTA_V_VECTOR_Z_MS]).toBe(0);
  });

  it('retains completed burns chronologically in a fixed-capacity ring', () => {
    const log = new BurnLog(2);
    const prograde = new Float64Array([0, 1, 0]);
    const normal = new Float64Array([0, 0, 1]);
    const radial = new Float64Array([1, 0, 0]);

    for (let burn = 0; burn < 3; burn += 1) {
      log.begin(
        burn * 10,
        burn * 9,
        burn * 100,
        burn * 2,
        burn,
        0,
        0,
        'earth',
        prograde,
        normal,
        radial,
        50 + burn,
      );
      log.synchronize(burn * 10 + 5, burn * 9 + 4, burn * 100 + 80, burn * 2 + 3, burn + 1, 2, 3);
      log.end();
    }

    expect(log.count).toBe(2);
    expect(log.activeBurn).toBeNull();
    expect(log.get(-1)).toBeNull();
    expect(log.get(2)).toBeNull();
    expect(log.get(0)).toMatchObject({
      startTimeSec: 10,
      endTimeSec: 15,
      energySpentJ: 80,
      properDeltaVMS: 3,
      dominantBodyId: 'earth',
      progradeDeltaVMS: 2,
      normalDeltaVMS: 3,
      radialDeltaVMS: 1,
    });
    expect(log.get(1)?.startTimeSec).toBe(20);
  });

  it('keeps positive throttle changes in one active burn and tracks peak power', () => {
    const log = new BurnLog();
    const x = new Float64Array([1, 0, 0]);
    const y = new Float64Array([0, 1, 0]);
    const z = new Float64Array([0, 0, 1]);

    log.begin(0, 0, 0, 0, 0, 0, 0, 'earth', x, z, y, 10);
    const activeIdentity = log.activeBurn;
    log.notePeakPower(25);
    log.synchronize(2, 2, 50, 4, 3, 0, 0);

    expect(log.activeBurn).toBe(activeIdentity);
    expect(log.activeBurn?.peakPowerW).toBe(25);
    expect(log.activeBurn?.energySpentJ).toBe(50);
    log.end();
    expect(log.count).toBe(1);
  });
});
