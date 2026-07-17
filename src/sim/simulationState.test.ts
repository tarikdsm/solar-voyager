import { describe, expect, it } from 'vitest';

import { copyAndValidateSimulationPersistentState } from './simulationState.js';
import { createBurnLog, SIMULATION_STATE_DIMENSION } from './ship/ledger.js';

function validState() {
  return {
    simTimeSec: 12,
    state: new Float64Array(SIMULATION_STATE_DIMENSION),
    attitudeQuaternion: new Float64Array([0, 0, 0, 1]),
    throttle: 0,
    attitudeMode: 'manual' as const,
    rotationRatesRadS: new Float64Array(3),
    requestedWarp: 1 as const,
    effectiveWarp: 1 as const,
    warpClampReason: 0 as const,
    targetBodyId: null,
    initialKineticEnergyJ: 0,
    burnLog: createBurnLog().persistence.exportState(),
  };
}

describe('simulation persistent state', () => {
  it('rejects a non-unit attitude quaternion', () => {
    expect(() =>
      copyAndValidateSimulationPersistentState(
        { ...validState(), attitudeQuaternion: new Float64Array([0, 0, 0, 2]) },
        ['earth'],
      ),
    ).toThrow(/unit quaternion/u);
  });

  it('rejects unknown dominant bodies inside the burn log', () => {
    const controller = createBurnLog();
    const x = new Float64Array([1, 0, 0]);
    const y = new Float64Array([0, 1, 0]);
    const z = new Float64Array([0, 0, 1]);
    controller.recorder.begin(0, 0, 0, 0, 0, 0, 0, 'unknown', x, y, z, 1);
    controller.recorder.synchronize(1, 1, 1, 1, 1, 0, 0);
    controller.recorder.end();

    expect(() =>
      copyAndValidateSimulationPersistentState(
        { ...validState(), burnLog: controller.persistence.exportState() },
        ['earth'],
      ),
    ).toThrow(/burn log body/u);
  });

  it('returns deep copies that cannot mutate the source state', () => {
    const source = validState();
    const copy = copyAndValidateSimulationPersistentState(source, ['earth']);

    copy.state[0] = 42;
    copy.attitudeQuaternion[3] = 0;
    copy.rotationRatesRadS[0] = 2;

    expect(source.state[0]).toBe(0);
    expect(source.attitudeQuaternion[3]).toBe(1);
    expect(source.rotationRatesRadS[0]).toBe(0);
  });
});
