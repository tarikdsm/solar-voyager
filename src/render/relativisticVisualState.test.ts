import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import type { SimSnapshot } from '../sim/simulationSnapshot.js';
import {
  createRelativisticVisualState,
  writeAberratedPositionInto,
  writeRelativisticVisualState,
} from './relativisticVisualState.js';

type RelativisticSnapshot = Pick<
  SimSnapshot,
  'shipCoordinateVelocityKmS' | 'gamma' | 'speedFractionOfLight'
>;

function snapshotAtBeta(betaX: number, betaY = 0, betaZ = 0): RelativisticSnapshot {
  const beta = Math.hypot(betaX, betaY, betaZ);
  return {
    shipCoordinateVelocityKmS: new Float64Array([
      betaX * SPEED_OF_LIGHT_KM_S,
      betaY * SPEED_OF_LIGHT_KM_S,
      betaZ * SPEED_OF_LIGHT_KM_S,
    ]),
    gamma: 1 / Math.sqrt(1 - beta * beta),
    speedFractionOfLight: beta,
  };
}

describe('relativistic visual state', () => {
  it('keeps gamma-one and quality-disabled observations at exact identity', () => {
    const state = createRelativisticVisualState();
    const output = new Float64Array(3);

    writeRelativisticVisualState(state, snapshotAtBeta(0), true);
    expect(state).toEqual({ betaX: 0, betaY: 0, betaZ: 0, gamma: 1, activation: 0 });
    writeAberratedPositionInto(output, 12, -4, 9, state);
    expect(Array.from(output)).toEqual([12, -4, 9]);

    writeRelativisticVisualState(state, snapshotAtBeta(0, 0, 0.9), false);
    expect(state.activation).toBe(0);
    writeAberratedPositionInto(output, 12, -4, 9, state);
    expect(Array.from(output)).toEqual([12, -4, 9]);
  });

  it('matches the analytic perpendicular aberration at 0.9c', () => {
    const state = createRelativisticVisualState();
    const output = new Float64Array(3);
    const gamma = 1 / Math.sqrt(1 - 0.9 ** 2);

    writeRelativisticVisualState(state, snapshotAtBeta(0, 0, 0.9), true);
    writeAberratedPositionInto(output, 1, 0, 0, state);

    expect(state.activation).toBe(1);
    expect(output[0]).toBeCloseTo(1 / gamma, 14);
    expect(output[1]).toBe(0);
    expect(output[2]).toBeCloseTo(0.9, 14);
    expect(Math.hypot(...output)).toBeCloseTo(1, 14);
  });

  it('preserves radius and forward/aft collinearity', () => {
    const state = createRelativisticVisualState();
    const output = new Float64Array(3);
    writeRelativisticVisualState(state, snapshotAtBeta(0.9), true);

    writeAberratedPositionInto(output, 700, 0, 0, state);
    expect(Array.from(output)).toEqual([700, 0, 0]);

    writeAberratedPositionInto(output, -700, 0, 0, state);
    expect(output[0]).toBeCloseTo(-700, 12);
    expect(output[1]).toBe(0);
    expect(output[2]).toBe(0);

    writeAberratedPositionInto(output, 3, -4, 12, state);
    expect(Math.hypot(...output)).toBeCloseTo(13, 12);
  });

  it('activates continuously from gamma 1 through gamma 1.05', () => {
    const state = createRelativisticVisualState();
    const betaAtGamma = (gamma: number): number => Math.sqrt(1 - 1 / (gamma * gamma));

    writeRelativisticVisualState(state, snapshotAtBeta(betaAtGamma(1)), true);
    expect(state.activation).toBe(0);

    writeRelativisticVisualState(state, snapshotAtBeta(betaAtGamma(1.025)), true);
    expect(state.activation).toBeCloseTo(0.5, 12);

    writeRelativisticVisualState(state, snapshotAtBeta(betaAtGamma(1.05)), true);
    expect(state.activation).toBe(1);

    writeRelativisticVisualState(state, snapshotAtBeta(betaAtGamma(1.05) + 1e-8), true);
    expect(state.activation).toBe(1);
  });

  it.each([
    ['non-finite velocity', { ...snapshotAtBeta(0.5), shipCoordinateVelocityKmS: new Float64Array([NaN, 0, 0]) }],
    ['light-speed beta', { ...snapshotAtBeta(0.5), speedFractionOfLight: 1 }],
    ['inconsistent beta', { ...snapshotAtBeta(0.5), speedFractionOfLight: 0.6 }],
    ['inconsistent gamma', { ...snapshotAtBeta(0.5), gamma: 8 }],
  ])('rejects %s without partially mutating output', (_label, snapshot) => {
    const state = {
      betaX: 0.1,
      betaY: 0.2,
      betaZ: 0.3,
      gamma: 4,
      activation: 0.75,
    };

    expect(() => writeRelativisticVisualState(state, snapshot, true)).toThrow(RangeError);
    expect(state).toEqual({ betaX: 0.1, betaY: 0.2, betaZ: 0.3, gamma: 4, activation: 0.75 });
  });
});
