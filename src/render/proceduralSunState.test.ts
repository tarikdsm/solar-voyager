import { describe, expect, it } from 'vitest';

import { ProceduralSunState } from './proceduralSunState.js';

describe('ProceduralSunState', () => {
  it('maps every fixed quality rung without replacing uniform objects', () => {
    const state = new ProceduralSunState(10);
    const octaveUniform = state.uniforms.uSunOctaves;

    expect(octaveUniform.value).toBe(4);
    state.setQuality('half');
    expect(state.uniforms.uSunOctaves).toBe(octaveUniform);
    expect(octaveUniform.value).toBe(2);
    state.setQuality('minimum');
    expect(octaveUniform.value).toBe(1);
  });

  it('keeps periodic phases bounded and stable over the complete cycle', () => {
    const state = new ProceduralSunState(10);
    const phaseUniform = state.uniforms.uSunTimePhases;
    state.update(0);
    const start = phaseUniform.value.toArray();
    state.update(21_600);

    expect(state.uniforms.uSunTimePhases).toBe(phaseUniform);
    expect(phaseUniform.value.toArray()).toEqual(start);
    expect(phaseUniform.value.length()).toBeCloseTo(Math.SQRT2, 12);
  });

  it('advances the fast phase with simulation time while retaining bounded values', () => {
    const state = new ProceduralSunState(10);
    state.update(150);

    expect(state.uniforms.uSunTimePhases.value.x).toBeCloseTo(0, 12);
    expect(state.uniforms.uSunTimePhases.value.y).toBeCloseTo(1, 12);
    expect(Math.abs(state.uniforms.uSunTimePhases.value.z)).toBeLessThanOrEqual(1);
    expect(Math.abs(state.uniforms.uSunTimePhases.value.w)).toBeLessThanOrEqual(1);
  });

  it.each([-1, 2 ** 32, 1.5, Number.NaN])('rejects invalid uint32 seed %s', (seed) => {
    expect(() => new ProceduralSunState(seed)).toThrow(RangeError);
  });

  it('rejects non-finite simulation time and unknown quality', () => {
    const state = new ProceduralSunState(10);
    expect(() => state.update(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => state.setQuality('ultra' as never)).toThrow(RangeError);
  });

  it('toggles the shared enable scalar in place', () => {
    const state = new ProceduralSunState(10);
    const enabled = state.uniforms.uSunEnabled;
    state.setEnabled(false);
    expect(state.uniforms.uSunEnabled).toBe(enabled);
    expect(enabled.value).toBe(0);
    state.setEnabled(true);
    expect(enabled.value).toBe(1);
  });
});
