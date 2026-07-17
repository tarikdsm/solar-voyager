import {
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { prepareProceduralSunMaterial } from './proceduralSunMaterial.js';
import { ProceduralSunState } from './proceduralSunState.js';

function shaderFixture(): {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
} {
  return {
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <opaque_fragment>',
  };
}

describe.each([
  ['Lambert', () => new MeshLambertMaterial()],
  ['Standard', () => new MeshStandardMaterial()],
])('procedural Sun %s material extension', (_label, materialFactory) => {
  it('chains one stable, fallback-guarded HDR photosphere extension', () => {
    const material = materialFactory();
    const previousCompile = vi.fn();
    material.onBeforeCompile = previousCompile;
    const state = new ProceduralSunState(10);
    const prepared = prepareProceduralSunMaterial(material, state.uniforms);
    const cacheKey = material.customProgramCacheKey();
    const shader = shaderFixture();

    material.onBeforeCompile(shader as never, {} as WebGLRenderer);

    expect(previousCompile).toHaveBeenCalledOnce();
    expect(material.customProgramCacheKey()).toBe(cacheKey);
    expect(cacheKey).toContain('solar-voyager-procedural-sun-v1');
    expect(shader.uniforms.uSunEnabled).toBe(state.uniforms.uSunEnabled);
    expect(shader.uniforms.uSunOctaves).toBe(state.uniforms.uSunOctaves);
    expect(shader.uniforms.uSunSeed).toBe(state.uniforms.uSunSeed);
    expect(shader.uniforms.uSunTimePhases).toBe(state.uniforms.uSunTimePhases);
    expect(shader.vertexShader).toContain('vSunObjectDirection = normalize( position )');
    expect(shader.fragmentShader).toContain('sunDomainWarpedFbm');
    expect(shader.fragmentShader).toContain('if ( uSunOctaves > 1.5 )');
    expect(shader.fragmentShader).toContain('if ( uSunOctaves > 3.5 )');
    expect(shader.fragmentShader).toContain('1.0 - 0.52 * sunOneMinusMu');
    expect(shader.fragmentShader).toContain('if ( uSunEnabled > 0.5 )');
    expect(shader.fragmentShader).toContain('outgoingLight = sunHdrColor');
    expect(shader.fragmentShader.indexOf('outgoingLight = sunHdrColor')).toBeLessThan(
      shader.fragmentShader.indexOf('#include <opaque_fragment>'),
    );
    expect(shader.fragmentShader).not.toContain('vSunUv');
    expect(shader.fragmentShader).toContain('#include <opaque_fragment>');

    prepared.dispose();
  });
});

describe('procedural Sun material extension lifecycle', () => {
  it('restores chained hooks once on idempotent disposal', () => {
    const material = new MeshStandardMaterial();
    const previousCompile = vi.fn();
    const previousCacheKey = material.customProgramCacheKey;
    material.onBeforeCompile = previousCompile;
    const prepared = prepareProceduralSunMaterial(material, new ProceduralSunState(10).uniforms);

    expect(material.onBeforeCompile).not.toBe(previousCompile);
    expect(material.customProgramCacheKey).not.toBe(previousCacheKey);

    prepared.dispose();
    prepared.dispose();

    expect(material.onBeforeCompile).toBe(previousCompile);
    expect(material.customProgramCacheKey).toBe(previousCacheKey);
  });

  it('rejects materials whose shader contract lacks lit outgoing light', () => {
    expect(() =>
      prepareProceduralSunMaterial(
        new MeshBasicMaterial() as never,
        new ProceduralSunState(10).uniforms,
      ),
    ).toThrow(TypeError);
  });
});
