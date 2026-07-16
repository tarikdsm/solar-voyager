import { describe, expect, it } from 'vitest';

import {
  createDp54Result,
  createDp54Workspace,
  propagate,
  type Dp54Tolerance,
} from './dp54.js';

const TEST_TOLERANCE: Dp54Tolerance = {
  absolute: new Float64Array([1e-12]),
  relative: 1e-12,
  initialStepSec: 0.25,
  maxAcceptedSteps: 4_000,
};

describe('dp54 — physics-spec.md §3.1 / §3.2', () => {
  it('returns the initial state for a zero-length horizon', () => {
    const initial = new Float64Array([3]);
    const output = new Float64Array(1);
    const result = createDp54Result();

    propagate(
      output,
      initial,
      5,
      5,
      (_timeSec, _state, derivative) => {
        derivative[0] = 99;
      },
      TEST_TOLERANCE,
      createDp54Workspace(1),
      result,
    );

    expect(output[0]).toBe(3);
    expect(result.reachedEnd).toBe(true);
    expect(result.acceptedSteps).toBe(0);
  });

  it('integrates a constant derivative forward and backward', () => {
    for (const endTimeSec of [2, -2]) {
      const output = new Float64Array(1);
      const result = createDp54Result();

      propagate(
        output,
        new Float64Array([1]),
        0,
        endTimeSec,
        (_timeSec, _state, derivative) => {
          derivative[0] = 2;
        },
        TEST_TOLERANCE,
        createDp54Workspace(1),
        result,
      );

      expect(output[0]).toBeCloseTo(1 + 2 * endTimeSec, 12);
      expect(result.reachedTimeSec).toBe(endTimeSec);
      expect(result.reachedEnd).toBe(true);
    }
  });

  it('reuses the final derivative through FSAL after an accepted step', () => {
    const output = new Float64Array(1);
    const result = createDp54Result();
    let derivativeCalls = 0;

    propagate(
      output,
      new Float64Array([0]),
      0,
      2,
      (_timeSec, _state, derivative) => {
        derivativeCalls += 1;
        derivative[0] = 1;
      },
      {
        ...TEST_TOLERANCE,
        initialStepSec: 1,
      },
      createDp54Workspace(1),
      result,
    );

    expect(result.acceptedSteps).toBe(2);
    expect(derivativeCalls).toBe(13);
  });

  it('stops at the accepted-step budget and reports a resumable step', () => {
    const output = new Float64Array(1);
    const result = createDp54Result();

    propagate(
      output,
      new Float64Array([4]),
      0,
      10_000,
      (_timeSec, _state, derivative) => {
        derivative[0] = 0;
      },
      {
        ...TEST_TOLERANCE,
        initialStepSec: 1,
        maxAcceptedSteps: 2,
      },
      createDp54Workspace(1),
      result,
    );

    expect(output[0]).toBe(4);
    expect(result.reachedTimeSec).toBe(6);
    expect(result.acceptedSteps).toBe(2);
    expect(result.budgetExhausted).toBe(true);
    expect(result.nextStepSec).toBe(25);
  });

  it('rejects an oversized step and recovers to integrate exponential growth', () => {
    const output = new Float64Array(1);
    const result = createDp54Result();

    propagate(
      output,
      new Float64Array([1]),
      0,
      1,
      (_timeSec, state, derivative) => {
        derivative[0] = 50 * (state[0] as number);
      },
      {
        absolute: new Float64Array([1e-12]),
        relative: 1e-11,
        initialStepSec: 1,
        maxAcceptedSteps: 4_000,
      },
      createDp54Workspace(1),
      result,
    );

    expect(result.rejectedSteps).toBeGreaterThan(0);
    expect(result.reachedEnd).toBe(true);
    expect(Math.abs((output[0] as number) / Math.exp(50) - 1)).toBeLessThan(1e-9);
  });
});
