import { describe, expect, it } from 'vitest';

import {
  evaluateBodyRateQuaternionInto,
  quaternionSeparationRad,
  selectMaximumGravityBodyIndex,
  writeAttitudeDirectionInto,
  writeForwardFromQuaternionInto,
  writeQuaternionFromForwardInto,
  writeSlewLimitedQuaternionInto,
  writeUpFromQuaternionInto,
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

describe('slew-limited attitude pursuit — physics-spec.md §3.0.1 / ADR-035', () => {
  const identity = new Float64Array([0, 0, 0, 1]);

  function quaternionFromForward(x: number, y: number, z: number): Float64Array {
    return writeQuaternionFromForwardInto(new Float64Array(4), x, y, z);
  }

  it('measures the shortest-path separation across the double cover', () => {
    const quarterTurn = quaternionFromForward(0, 1, 0);
    const negated = new Float64Array(quarterTurn).map((component) => -component);

    expect(quaternionSeparationRad(identity, identity)).toBe(0);
    expect(quaternionSeparationRad(identity, quarterTurn)).toBeCloseTo(Math.PI / 2, 14);
    // -q is the same rotation; the separation must not report the long way round.
    expect(quaternionSeparationRad(identity, negated)).toBeCloseTo(Math.PI / 2, 14);
    expect(quaternionSeparationRad(identity, quaternionFromForward(-1, 0, 0))).toBeCloseTo(
      Math.PI,
      14,
    );
  });

  it('advances exactly the requested angle along the great circle', () => {
    const target = quaternionFromForward(0, 1, 0);
    const output = new Float64Array(4);
    const forward = new Float64Array(3);
    const stepRad = Math.PI / 6;

    expect(writeSlewLimitedQuaternionInto(output, identity, target, stepRad)).toBe(output);

    // Analytic check: a 30 deg step of a 90 deg +X -> +Y rotation about +Z.
    writeForwardFromQuaternionInto(forward, output);
    expectVector(forward, [Math.cos(stepRad), Math.sin(stepRad), 0]);
    expect(quaternionSeparationRad(identity, output)).toBeCloseTo(stepRad, 14);
    expect(quaternionSeparationRad(output, target)).toBeCloseTo(Math.PI / 2 - stepRad, 14);
    expect(Math.hypot(...output)).toBeCloseTo(1, 15);
  });

  it('composes successive steps into one uniform-rate geodesic', () => {
    const target = quaternionFromForward(0, 0, 1);
    const stepwise = new Float64Array(4);
    const direct = new Float64Array(4);
    const scratch = new Float64Array(identity);
    const stepRad = Math.PI / 400;

    for (let step = 0; step < 100; step += 1) {
      writeSlewLimitedQuaternionInto(stepwise, scratch, target, stepRad);
      scratch.set(stepwise);
    }
    writeSlewLimitedQuaternionInto(direct, identity, target, 100 * stepRad);

    for (let index = 0; index < 4; index += 1) {
      expect(stepwise[index]).toBeCloseTo(direct[index] as number, 14);
    }
  });

  it('copies the target verbatim once the budget covers the separation', () => {
    const target = quaternionFromForward(0.3, -0.5, 0.81);
    const output = new Float64Array(4);

    // Bit-for-bit, not merely close: this is what keeps a converged hold identical
    // to the pre-ADR-035 snap and makes an unbounded rate reproduce it exactly.
    writeSlewLimitedQuaternionInto(output, identity, target, Math.PI);
    expect(output).toEqual(target);
    writeSlewLimitedQuaternionInto(output, identity, target, Number.POSITIVE_INFINITY);
    expect(output).toEqual(target);
    writeSlewLimitedQuaternionInto(output, target, target, 0);
    expect(output).toEqual(target);
  });

  it('holds the current attitude for a zero, negative, or non-finite budget', () => {
    const target = quaternionFromForward(0, 1, 0);
    const output = new Float64Array(4);

    for (const budget of [0, -1, Number.NaN]) {
      writeSlewLimitedQuaternionInto(output, identity, target, budget);
      expect(output).toEqual(identity);
    }
  });

  it('takes the short way round when the target is the negated quaternion', () => {
    const target = quaternionFromForward(0, 1, 0);
    const negatedTarget = new Float64Array(target).map((component) => -component);
    const viaTarget = new Float64Array(4);
    const viaNegated = new Float64Array(4);
    const stepRad = Math.PI / 8;

    writeSlewLimitedQuaternionInto(viaTarget, identity, target, stepRad);
    writeSlewLimitedQuaternionInto(viaNegated, identity, negatedTarget, stepRad);

    for (let index = 0; index < 4; index += 1) {
      expect(viaNegated[index]).toBeCloseTo(viaTarget[index] as number, 14);
    }
  });

  it('slews through an exact 180 degree reversal without a degenerate axis', () => {
    const target = quaternionFromForward(-1, 0, 0);
    const output = new Float64Array(4);
    const forward = new Float64Array(3);

    expect(quaternionSeparationRad(identity, target)).toBeCloseTo(Math.PI, 14);
    writeSlewLimitedQuaternionInto(output, identity, target, Math.PI / 2);
    writeForwardFromQuaternionInto(forward, output);

    expect(Number.isFinite(forward[0] as number)).toBe(true);
    expect(forward[0]).toBeCloseTo(0, 13);
    expect(Math.hypot(...forward)).toBeCloseTo(1, 14);
    expect(quaternionSeparationRad(output, target)).toBeCloseTo(Math.PI / 2, 13);
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

describe('writeUpFromQuaternionInto', () => {
  it('returns the world +Z axis for the identity attitude', () => {
    const output = new Float64Array(3);
    writeUpFromQuaternionInto(output, new Float64Array([0, 0, 0, 1]));
    expectVector(output, [0, 0, 1]);
  });

  it('is the third column of the same rotation the forward extractor reads', () => {
    // ADR-025 section 4: body +X is the nose, body +Z is the vessel up. A quarter
    // roll about the nose therefore leaves forward alone and swings up onto -Y.
    const roll = new Float64Array([Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    const forward = new Float64Array(3);
    const up = new Float64Array(3);
    writeForwardFromQuaternionInto(forward, roll);
    writeUpFromQuaternionInto(up, roll);
    expectVector(forward, [1, 0, 0]);
    expectVector(up, [0, -1, 0]);
  });

  it('stays orthonormal to forward through an arbitrary rotation', () => {
    const axisLength = Math.hypot(0.3, -0.7, 0.5);
    const angle = 1.1;
    const sin = Math.sin(angle / 2);
    const quaternion = new Float64Array([
      (0.3 / axisLength) * sin,
      (-0.7 / axisLength) * sin,
      (0.5 / axisLength) * sin,
      Math.cos(angle / 2),
    ]);
    const forward = new Float64Array(3);
    const up = new Float64Array(3);
    writeForwardFromQuaternionInto(forward, quaternion);
    writeUpFromQuaternionInto(up, quaternion);

    expect(Math.hypot(up[0] as number, up[1] as number, up[2] as number)).toBeCloseTo(1, 15);
    expect(
      (forward[0] as number) * (up[0] as number) +
        (forward[1] as number) * (up[1] as number) +
        (forward[2] as number) * (up[2] as number),
    ).toBeCloseTo(0, 15);
  });
});
