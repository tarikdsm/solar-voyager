import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import {
  STATE_VECTOR_COMPONENT_COUNT,
  STATE_VECTOR_SCALE,
  StateVectorKind,
  formatStateVectorMagnitude,
  logarithmicVectorLength,
  writeStateVectorEndpointsInto,
} from './stateVectorModel.js';

describe('state-vector logarithmic model — rendering-spec.md §9', () => {
  it('keeps 30 km/s and 0.99c velocity vectors readable at opposite curve bounds', () => {
    const scale = STATE_VECTOR_SCALE[StateVectorKind.VELOCITY];

    expect(logarithmicVectorLength(30, scale)).toBeCloseTo(scale.minLength, 12);
    expect(logarithmicVectorLength(0.99 * SPEED_OF_LIGHT_KM_S, scale)).toBeCloseTo(
      scale.maxLength,
      12,
    );
    expect(logarithmicVectorLength(300, scale)).toBeGreaterThan(scale.minLength);
    expect(logarithmicVectorLength(300, scale)).toBeLessThan(scale.maxLength);
  });

  it('is monotonic, clamps finite magnitudes and hides zero or invalid values', () => {
    const scale = STATE_VECTOR_SCALE[StateVectorKind.ACCELERATION];

    expect(logarithmicVectorLength(0, scale)).toBe(0);
    expect(logarithmicVectorLength(Number.NaN, scale)).toBe(0);
    expect(logarithmicVectorLength(Number.POSITIVE_INFINITY, scale)).toBe(0);
    expect(logarithmicVectorLength(scale.minMagnitude / 10, scale)).toBe(scale.minLength);
    expect(logarithmicVectorLength(scale.minMagnitude, scale)).toBe(scale.minLength);
    expect(
      logarithmicVectorLength(Math.sqrt(scale.minMagnitude * scale.maxMagnitude), scale),
    ).toBeCloseTo((scale.minLength + scale.maxLength) / 2, 10);
    expect(logarithmicVectorLength(scale.maxMagnitude * 10, scale)).toBe(scale.maxLength);
  });

  it('writes four direction-preserving endpoints into caller-owned storage', () => {
    const output = new Float32Array(STATE_VECTOR_COMPONENT_COUNT);
    const velocity = new Float64Array([30, 40, 0]);
    const acceleration = new Float64Array([0, 0, 0.009_806_65]);
    const momentum = new Float64Array([-300_000, 0, 0]);
    const angularMomentum = new Float64Array([0, 5e16, 0]);

    const visibleMask = writeStateVectorEndpointsInto(
      output,
      velocity,
      acceleration,
      momentum,
      angularMomentum,
    );

    expect(visibleMask).toBe(0b1111);
    expect((output[0] as number) / (output[1] as number)).toBeCloseTo(3 / 4, 6);
    expect(output[2]).toBe(0);
    expect(output[3]).toBe(0);
    expect(output[4]).toBe(0);
    expect(output[5]).toBeGreaterThan(0);
    expect(output[6]).toBeLessThan(0);
    expect(output[7]).toBe(0);
    expect(output[8]).toBe(0);
    expect(output[9]).toBe(0);
    expect(output[10]).toBeGreaterThan(0);
    expect(output[11]).toBe(0);
  });

  it('clears hidden endpoints and rejects undersized or malformed vector storage', () => {
    const output = new Float32Array(STATE_VECTOR_COMPONENT_COUNT).fill(1);
    const zero = new Float64Array(3);
    const invalid = new Float64Array([Number.NaN, 0, 0]);

    expect(writeStateVectorEndpointsInto(output, zero, invalid, zero, zero)).toBe(0);
    expect(Array.from(output)).toEqual(new Array<number>(STATE_VECTOR_COMPONENT_COUNT).fill(0));
    expect(() =>
      writeStateVectorEndpointsInto(new Float32Array(3), zero, zero, zero, zero),
    ).toThrow(RangeError);
    expect(() =>
      writeStateVectorEndpointsInto(output, new Float64Array(2), zero, zero, zero),
    ).toThrow(RangeError);
  });

  it('formats each physical magnitude with a three-significant-digit SI prefix', () => {
    expect(formatStateVectorMagnitude(StateVectorKind.VELOCITY, 29.78)).toBe('29.8 km/s');
    expect(formatStateVectorMagnitude(StateVectorKind.ACCELERATION, 0.009_806_65)).toBe(
      '9.81 m/s²',
    );
    expect(formatStateVectorMagnitude(StateVectorKind.MOMENTUM, 297_800)).toBe('298 MN·s');
    expect(formatStateVectorMagnitude(StateVectorKind.ANGULAR_MOMENTUM, 4.47e16)).toBe(
      '44.7 Zkg·m²/s',
    );
    expect(formatStateVectorMagnitude(StateVectorKind.VELOCITY, Number.NaN)).toBe('—');
  });
});
