import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import {
  type BurnLogEntry,
  type BurnLogView,
  createBurnLog,
  SIMULATION_STATE_DIMENSION,
  STATE_ENERGY_J,
  STATE_PROPER_DELTA_V_MS,
  STATE_PROPER_DELTA_V_VECTOR_X_MS,
  STATE_PROPER_DELTA_V_VECTOR_Y_MS,
  STATE_PROPER_DELTA_V_VECTOR_Z_MS,
  writeLedgerDerivativeRates,
} from './ledger.js';

function copyBurnEntry(entry: BurnLogEntry): BurnLogEntry {
  return { ...entry };
}

function copyBurnLog(log: BurnLogView): {
  readonly active: BurnLogEntry | null;
  readonly completed: readonly BurnLogEntry[];
} {
  const completed: BurnLogEntry[] = [];
  for (let index = 0; index < log.count; index += 1) {
    const entry = log.get(index);
    if (entry !== null) completed.push(copyBurnEntry(entry));
  }
  return {
    active: log.activeBurn === null ? null : copyBurnEntry(log.activeBurn),
    completed,
  };
}

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
    const controller = createBurnLog(2);
    const log = controller.view;
    const recorder = controller.recorder;
    const prograde = new Float64Array([0, 1, 0]);
    const normal = new Float64Array([0, 0, 1]);
    const radial = new Float64Array([1, 0, 0]);

    for (let burn = 0; burn < 3; burn += 1) {
      recorder.begin(
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
      recorder.synchronize(
        burn * 10 + 5,
        burn * 9 + 4,
        burn * 100 + 80,
        burn * 2 + 3,
        burn + 1,
        2,
        3,
      );
      recorder.end();
    }

    expect(log.count).toBe(2);
    expect('begin' in log).toBe(false);
    expect('end' in log).toBe(false);
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
    const controller = createBurnLog();
    const log = controller.view;
    const recorder = controller.recorder;
    const x = new Float64Array([1, 0, 0]);
    const y = new Float64Array([0, 1, 0]);
    const z = new Float64Array([0, 0, 1]);

    recorder.begin(0, 0, 0, 0, 0, 0, 0, 'earth', x, z, y, 10);
    const activeIdentity = log.activeBurn;
    recorder.notePeakPower(25);
    recorder.synchronize(2, 2, 50, 4, 3, 0, 0);

    expect(log.activeBurn).toBe(activeIdentity);
    expect(log.activeBurn?.peakPowerW).toBe(25);
    expect(log.activeBurn?.energySpentJ).toBe(50);
    recorder.end();
    expect(log.count).toBe(1);
  });

  it('restores completed and active burns without losing continuation state', () => {
    const original = createBurnLog(4);
    const prograde = new Float64Array([0, 1, 0]);
    const normal = new Float64Array([0, 0, 1]);
    const radial = new Float64Array([1, 0, 0]);

    original.recorder.begin(0, 0, 100, 2, 1, 2, 3, 'earth', prograde, normal, radial, 10);
    original.recorder.synchronize(5, 4, 180, 5, 2, 4, 6);
    original.recorder.end();
    original.recorder.begin(10, 8, 180, 5, 2, 4, 6, 'mars', radial, prograde, normal, 20);
    original.recorder.notePeakPower(25);
    original.recorder.synchronize(12, 9.5, 230, 7, 5, 8, 10);

    const persisted = original.persistence.exportState();
    const restored = createBurnLog(4, persisted);

    expect(copyBurnLog(restored.view)).toEqual(copyBurnLog(original.view));
    original.recorder.synchronize(15, 12, 300, 10, 7, 12, 15);
    restored.recorder.synchronize(15, 12, 300, 10, 7, 12, 15);
    original.recorder.end();
    restored.recorder.end();

    expect(copyBurnLog(restored.view)).toEqual(copyBurnLog(original.view));
  });
});
