import { describe, expect, it } from 'vitest';

import {
  evaluateBodyRateQuaternionInto,
  selectMaximumGravityBodyIndex,
  writeAttitudeDirectionInto,
  writeForwardFromQuaternionInto,
  writeQuaternionFromForwardInto,
} from './attitude.js';

function expectVector(actual: Float64Array, expected: readonly number[]): void {
  for (let index = 0; index < expected.length; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index] as number, 13);
  }
}

describe('attitude quaternion primitives', () => {
  it('maps local +X to a requested forward direction including antiparallel', () => {
    const quaternion = new Float64Array(4);
    const forward = new Float64Array(3);

    writeQuaternionFromForwardInto(quaternion, 0, 1, 0);
    writeForwardFromQuaternionInto(forward, quaternion);
    expectVector(forward, [0, 1, 0]);

    writeQuaternionFromForwardInto(quaternion, -1, 0, 0);
    writeForwardFromQuaternionInto(forward, quaternion);
    expectVector(forward, [-1, 0, 0]);
  });

  it('evaluates exact constant body angular velocity without allocating', () => {
    const output = new Float64Array(4);
    const forward = new Float64Array(3);
    const identity = new Float64Array([0, 0, 0, 1]);
    const omegaBodyRadS = new Float64Array([0, 0, Math.PI / 2]);

    expect(evaluateBodyRateQuaternionInto(output, identity, omegaBodyRadS, 1)).toBe(output);
    writeForwardFromQuaternionInto(forward, output);
    expectVector(forward, [0, 1, 0]);
    expect(Math.hypot(...output)).toBeCloseTo(1, 14);
  });
});

describe('orbital attitude directions', () => {
  const bodyMuKm3S2 = new Float64Array([100, 1]);
  const bodyPositionsKm = new Float64Array([0, 0, 0, 10, 10, 0]);
  const bodyVelocitiesKmS = new Float64Array([0, 0, 0, 0, 0, 0]);
  const shipState = new Float64Array([10, 0, 0, 0, 2, 0, 0]);
  const shipVelocityKmS = new Float64Array([0, 2, 0]);
  const fallbackQuaternion = new Float64Array([0, 0, 0, 1]);

  it('selects the maximum instantaneous gravitational influence', () => {
    expect(selectMaximumGravityBodyIndex(shipState, bodyMuKm3S2, bodyPositionsKm)).toBe(0);
  });

  it.each([
    ['prograde', [0, 1, 0]],
    ['retrograde', [0, -1, 0]],
    ['radialOut', [1, 0, 0]],
    ['radialIn', [-1, 0, 0]],
    ['normal', [0, 0, 1]],
    ['antinormal', [0, 0, -1]],
    ['target', [0, 1, 0]],
  ] as const)('writes %s in the local orbital frame', (mode, expected) => {
    const output = new Float64Array(3);
    writeAttitudeDirectionInto(
      output,
      mode,
      shipState,
      shipVelocityKmS,
      bodyMuKm3S2,
      bodyPositionsKm,
      bodyVelocitiesKmS,
      1,
      fallbackQuaternion,
    );
    expectVector(output, expected);
  });

  it('retains the previous finite forward direction for a degenerate hold', () => {
    const output = new Float64Array(3);
    const zForwardQuaternion = new Float64Array(4);
    writeQuaternionFromForwardInto(zForwardQuaternion, 0, 0, 1);

    writeAttitudeDirectionInto(
      output,
      'prograde',
      shipState,
      new Float64Array(3),
      bodyMuKm3S2,
      bodyPositionsKm,
      bodyVelocitiesKmS,
      -1,
      zForwardQuaternion,
    );

    expectVector(output, [0, 0, 1]);
  });
});
