import {
  MeshBasicMaterial,
  MeshStandardMaterial,
  Texture,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { GasGiantAnimationState } from './gasGiantAnimationState.js';
import { prepareGasGiantMaterial } from './gasGiantMaterial.js';

interface ShaderFixture extends WebGLProgramParametersWithUniforms {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
}

function shaderFixture(): ShaderFixture {
  return {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {}',
    fragmentShader: [
      '#include <common>',
      'void main() {',
      '  vec4 diffuseColor = vec4( 1.0 );',
      '  #include <map_fragment>',
      '  #include <opaque_fragment>',
      '}',
    ].join('\n'),
  } as ShaderFixture;
}

function mappedSurfaceMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ map: new Texture() });
  material.name = 'mat_surface';
  return material;
}

describe('gas-giant material extension', () => {
  it('chains one stable texture-preserving shader extension', () => {
    const material = mappedSurfaceMaterial();
    const previousCompile = vi.fn();
    const previousKey = vi.fn(() => 'authored');
    material.onBeforeCompile = previousCompile;
    material.customProgramCacheKey = previousKey;
    const state = new GasGiantAnimationState('jupiter', 599);
    const prepared = prepareGasGiantMaterial(material, state.uniforms);
    const shader = shaderFixture();

    material.onBeforeCompile(shader, {} as WebGLRenderer);

    expect(previousCompile).toHaveBeenCalledOnce();
    expect(shader.uniforms.uGasBandPhases).toBe(state.uniforms.uGasBandPhases);
    expect(shader.uniforms.uGasStormPhase).toBe(state.uniforms.uGasStormPhase);
    expect(shader.fragmentShader).toContain('gasSphericalDirection');
    expect(shader.fragmentShader).toContain('if ( uGasOctaves > 1.5 )');
    expect(shader.fragmentShader).toContain('if ( uGasOctaves > 3.5 )');
    expect(shader.fragmentShader).toContain('clamp( gasWarp.x, -0.006, 0.006 )');
    expect(shader.fragmentShader).toContain('clamp( gasWarp.y, -0.002, 0.002 )');
    expect(shader.fragmentShader).toContain('#define vMapUv gasAnimatedUv');
    expect(shader.fragmentShader).toContain('#undef vMapUv');
    expect(shader.fragmentShader).toContain('uGasEnabled > 0.5');
    expect(shader.fragmentShader).toContain('clamp( gasShimmer, 0.985, 1.015 )');
    expect(material.customProgramCacheKey()).toBe('authored|solar-voyager-gas-giant-v1');

    state.update(3_600);
    state.setQuality('minimum');
    expect(material.customProgramCacheKey()).toBe('authored|solar-voyager-gas-giant-v1');

    prepared.dispose();
    prepared.dispose();
    expect(material.onBeforeCompile).toBe(previousCompile);
    expect(material.customProgramCacheKey).toBe(previousKey);
  });

  it('injects declarations and the map wrapper exactly once per compile', () => {
    const material = mappedSurfaceMaterial();
    prepareGasGiantMaterial(material, new GasGiantAnimationState('saturn', 699).uniforms);

    for (let compile = 0; compile < 2; compile += 1) {
      const shader = shaderFixture();
      material.onBeforeCompile(shader, {} as WebGLRenderer);
      expect(shader.fragmentShader.match(/uniform float uGasEnabled;/gu)).toHaveLength(1);
      expect(shader.fragmentShader.match(/#define vMapUv gasAnimatedUv/gu)).toHaveLength(1);
      expect(shader.fragmentShader.match(/#undef vMapUv/gu)).toHaveLength(1);
      expect(shader.fragmentShader.match(/#include <map_fragment>/gu)).toHaveLength(1);
    }
  });

  it('keeps the authored UV and exact unity shimmer while disabled', () => {
    const material = mappedSurfaceMaterial();
    const state = new GasGiantAnimationState('uranus', 799);
    state.setEnabled(false);
    prepareGasGiantMaterial(material, state.uniforms);
    const shader = shaderFixture();

    material.onBeforeCompile(shader, {} as WebGLRenderer);

    expect(shader.fragmentShader).toContain('vec2 gasAnimatedUv = vMapUv;');
    expect(shader.fragmentShader).toContain('float gasShimmer = 1.0;');
    expect(shader.fragmentShader).toContain('if ( uGasEnabled > 0.5 )');
  });

  it('rejects unsupported, unnamed, and unmapped materials', () => {
    const uniforms = new GasGiantAnimationState('neptune', 899).uniforms;
    expect(() => prepareGasGiantMaterial(new MeshBasicMaterial(), uniforms)).toThrow(TypeError);

    const unnamed = new MeshStandardMaterial({ map: new Texture() });
    expect(() => prepareGasGiantMaterial(unnamed, uniforms)).toThrow(TypeError);

    const unmapped = new MeshStandardMaterial();
    unmapped.name = 'mat_surface';
    expect(() => prepareGasGiantMaterial(unmapped, uniforms)).toThrow(TypeError);
  });

  it('fails setup when required Three shader anchors are absent', () => {
    const material = mappedSurfaceMaterial();
    prepareGasGiantMaterial(material, new GasGiantAnimationState('jupiter', 599).uniforms);
    const missingCommon = shaderFixture();
    missingCommon.fragmentShader = missingCommon.fragmentShader.replace('#include <common>', '');
    expect(() => material.onBeforeCompile(missingCommon, {} as WebGLRenderer)).toThrow(
      '#include <common>',
    );

    const missingMap = shaderFixture();
    missingMap.fragmentShader = missingMap.fragmentShader.replace('#include <map_fragment>', '');
    expect(() => material.onBeforeCompile(missingMap, {} as WebGLRenderer)).toThrow(
      '#include <map_fragment>',
    );
  });
});
