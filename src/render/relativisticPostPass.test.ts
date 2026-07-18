import { PerspectiveCamera, ShaderMaterial, Vector2, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { createRelativisticVisualState } from './relativisticVisualState.js';
import { RelativisticPostPass } from './relativisticPostPass.js';

describe('RelativisticPostPass', () => {
  it('updates stable view and camera-space observer uniforms without normalizing beta', () => {
    const pass = new RelativisticPostPass();
    const camera = new PerspectiveCamera(60, 2, 0.1, 1_000);
    camera.updateMatrixWorld(true);
    const state = createRelativisticVisualState();
    state.betaX = 0.3;
    state.betaY = -0.4;
    state.gamma = 1.2;
    state.activation = 0.75;
    const uniforms = pass.material.uniforms;
    const betaUniform = uniforms.uObserverBetaCamera;
    const viewScaleUniform = uniforms.uViewScale;

    pass.updateObserver(state, camera);

    expect(uniforms.uObserverBetaCamera).toBe(betaUniform);
    expect(uniforms.uViewScale).toBe(viewScaleUniform);
    expect(betaUniform?.value).toBeInstanceOf(Vector3);
    expect((betaUniform?.value as Vector3).toArray()).toEqual([0.3, -0.4, 0]);
    expect((betaUniform?.value as Vector3).length()).toBeCloseTo(0.5, 14);
    expect(viewScaleUniform?.value).toBeInstanceOf(Vector2);
    expect((viewScaleUniform?.value as Vector2).toArray()).toEqual([
      2 * Math.tan(Math.PI / 6),
      Math.tan(Math.PI / 6),
    ]);
    expect(uniforms.uObserverGamma?.value).toBe(1.2);
    expect(uniforms.uRelativisticActivation?.value).toBe(0.75);
    expect(pass.enabled).toBe(true);
  });

  it('rotates world beta into camera space and disables the identity pass', () => {
    const pass = new RelativisticPostPass();
    const camera = new PerspectiveCamera(75, 1, 0.1, 1_000);
    camera.rotation.y = Math.PI / 2;
    camera.updateMatrixWorld(true);
    const state = createRelativisticVisualState();
    state.betaZ = -0.5;
    state.gamma = 1.2;
    state.activation = 1;

    pass.updateObserver(state, camera);
    const betaCamera = pass.material.uniforms.uObserverBetaCamera?.value as Vector3;
    expect(betaCamera.x).toBeCloseTo(0.5, 14);
    expect(betaCamera.y).toBeCloseTo(0, 14);
    expect(betaCamera.z).toBeCloseTo(0, 14);

    state.activation = 0;
    pass.updateObserver(state, camera);
    expect(pass.enabled).toBe(false);
  });

  it('contains the normative Doppler, RGB, beaming, and adaptive UV mapping', () => {
    const pass = new RelativisticPostPass();
    const fragmentShader = pass.material.fragmentShader;
    const vertexShader = pass.material.vertexShader;

    expect(fragmentShader).toContain('1.0 / (uObserverGamma *');
    expect(fragmentShader).toContain('clamp(log2(doppler), -2.0, 2.0)');
    expect(fragmentShader).toContain('vec3(-0.20, 0.05, 0.35)');
    expect(fragmentShader).toContain('vec3(0.2126, 0.7152, 0.0722)');
    expect(fragmentShader).toContain('clamp(doppler * doppler * doppler, 0.20, 8.0)');
    expect(vertexShader).toContain('vUv = uv * uAdaptiveUvScale');
    expect(vertexShader).toContain('vViewUv = uv');

    const adaptiveUniform = pass.material.uniforms.uAdaptiveUvScale;
    pass.setRenderScale(0.55);
    expect(pass.material.uniforms.uAdaptiveUvScale).toBe(adaptiveUniform);
    expect(adaptiveUniform?.value).toBe(0.55);
  });

  it('disposes its precompiled shader resources', () => {
    const pass = new RelativisticPostPass();
    const materialDispose = vi.spyOn(pass.material as ShaderMaterial, 'dispose');

    pass.dispose();

    expect(materialDispose).toHaveBeenCalledOnce();
  });
});
