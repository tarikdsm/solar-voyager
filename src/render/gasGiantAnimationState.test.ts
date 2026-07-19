import { describe, expect, it } from 'vitest';

import {
  GAS_GIANT_CONFIG,
  GasGiantAnimationState,
  isGasGiantId,
} from './gasGiantAnimationState.js';

describe('gas-giant animation configuration', () => {
  it('locks the four catalogued bodies and visual rotation periods', () => {
    expect(Object.keys(GAS_GIANT_CONFIG)).toEqual(['jupiter', 'saturn', 'uranus', 'neptune']);
    expect(GAS_GIANT_CONFIG.jupiter.baseRotationHours).toBe(9.9);
    expect(GAS_GIANT_CONFIG.saturn.baseRotationHours).toBe(10.7);
    expect(GAS_GIANT_CONFIG.uranus.baseRotationHours).toBe(17.2);
    expect(GAS_GIANT_CONFIG.neptune.baseRotationHours).toBe(16.1);
    expect(GAS_GIANT_CONFIG.jupiter.spot.toArray()).toEqual([0.374, 0.64, 0.068, 0.046]);
    expect(GAS_GIANT_CONFIG.saturn.spot.z).toBe(0);
    expect(GAS_GIANT_CONFIG.uranus.spot.z).toBe(0);
    expect(GAS_GIANT_CONFIG.neptune.spot.z).toBe(0);
  });

  it('recognizes only the supported body ids', () => {
    expect(isGasGiantId('jupiter')).toBe(true);
    expect(isGasGiantId('saturn')).toBe(true);
    expect(isGasGiantId('uranus')).toBe(true);
    expect(isGasGiantId('neptune')).toBe(true);
    expect(isGasGiantId('earth')).toBe(false);
    expect(isGasGiantId('')).toBe(false);
  });
});

describe('GasGiantAnimationState', () => {
  it('maps quality rungs without replacing uniform objects', () => {
    const state = new GasGiantAnimationState('jupiter', 599);
    const octaves = state.uniforms.uGasOctaves;

    expect(octaves.value).toBe(4);
    state.setQuality('half');
    expect(state.uniforms.uGasOctaves).toBe(octaves);
    expect(octaves.value).toBe(2);
    state.setQuality('minimum');
    expect(state.uniforms.uGasOctaves).toBe(octaves);
    expect(octaves.value).toBe(1);
    state.setQuality('full');
    expect(octaves.value).toBe(4);
  });

  it('updates deterministic bounded phases in place for arbitrary finite time', () => {
    const first = new GasGiantAnimationState('neptune', 899);
    const second = new GasGiantAnimationState('neptune', 899);
    const bandUniform = first.uniforms.uGasBandPhases;
    const stormUniform = first.uniforms.uGasStormPhase;

    first.update(1_000_000_000_000.25);
    second.update(1_000_000_000_000.25);

    expect(first.uniforms.uGasBandPhases).toBe(bandUniform);
    expect(first.uniforms.uGasStormPhase).toBe(stormUniform);
    expect(bandUniform.value.toArray()).toEqual(second.uniforms.uGasBandPhases.value.toArray());
    expect(stormUniform.value.toArray()).toEqual(second.uniforms.uGasStormPhase.value.toArray());
    for (const phase of bandUniform.value.toArray()) {
      expect(Number.isFinite(phase)).toBe(true);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
    expect(stormUniform.value.x ** 2 + stormUniform.value.y ** 2).toBeCloseTo(1, 10);
    expect(stormUniform.value.z ** 2 + stormUniform.value.w ** 2).toBeCloseTo(1, 10);
  });

  it('closes both storm cycles without a phase pop', () => {
    const state = new GasGiantAnimationState('jupiter', 599);
    state.update(0);
    const start = state.uniforms.uGasStormPhase.value.toArray();
    state.update(6 * 24 * 60 * 60);

    expect(state.uniforms.uGasStormPhase.value.toArray()).toEqual(start);
  });

  it.each([
    ['jupiter', 599],
    ['saturn', 699],
    ['uranus', 799],
    ['neptune', 899],
  ] as const)('encodes the %s seed and body parameters once', (id, seed) => {
    const state = new GasGiantAnimationState(id, seed);

    expect(state.uniforms.uGasSeed.value.x).toBe((seed & 0xffff) / 0xffff);
    expect(state.uniforms.uGasSeed.value.y).toBe((seed >>> 16) / 0xffff);
    expect(state.uniforms.uGasSpot.value.toArray()).toEqual(GAS_GIANT_CONFIG[id].spot.toArray());
    expect(state.uniforms.uGasWarp.value.x).toBe(0.006);
    expect(state.uniforms.uGasWarp.value.y).toBe(0.002);
    expect(state.uniforms.uGasWarp.value.z).toBe(GAS_GIANT_CONFIG[id].bandCount);
  });

  it.each([-1, 2 ** 32, 1.5, Number.NaN])('rejects invalid uint32 seed %s', (seed) => {
    expect(() => new GasGiantAnimationState('jupiter', seed)).toThrow(RangeError);
  });

  it('rejects unknown bodies, non-finite time, and unknown quality', () => {
    expect(() => new GasGiantAnimationState('earth' as never, 399)).toThrow(RangeError);
    const state = new GasGiantAnimationState('jupiter', 599);
    expect(() => state.update(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => state.setQuality('ultra' as never)).toThrow(RangeError);
  });

  it('toggles the exact static fallback scalar in place', () => {
    const state = new GasGiantAnimationState('saturn', 699);
    const enabled = state.uniforms.uGasEnabled;

    state.setEnabled(false);
    expect(state.uniforms.uGasEnabled).toBe(enabled);
    expect(enabled.value).toBe(0);
    state.setEnabled(true);
    expect(enabled.value).toBe(1);
  });
});
