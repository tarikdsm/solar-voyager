import { MeshStandardMaterial, Texture, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { LoadedSurfaceDetail } from './bodyAssetLoader.js';
import {
  prepareSurfaceDetail,
  surfaceDetailBlend,
  surfaceDetailProceduralBlend,
} from './surfaceDetail.js';

const RADIUS_KM = 6_371;

function detail(seed = 399): LoadedSurfaceDetail {
  return {
    albedo: new Texture(),
    normal: new Texture(),
    tilesPerEquator: 512,
    seed,
  };
}

function shaderFixture(): {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
} {
  return {
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: [
      '#include <common>',
      '#include <map_fragment>',
      '#include <normal_fragment_maps>',
      '#include <roughnessmap_fragment>',
    ].join('\n'),
  };
}

describe('surface detail distance blend', () => {
  it('is exact at its boundaries, monotonic, and saturated inside the surface', () => {
    expect(surfaceDetailBlend(6 * RADIUS_KM, RADIUS_KM)).toBe(0);
    expect(surfaceDetailBlend(5 * RADIUS_KM, RADIUS_KM)).toBe(0);
    expect(surfaceDetailBlend(3 * RADIUS_KM, RADIUS_KM)).toBeGreaterThan(0);
    expect(surfaceDetailBlend(3 * RADIUS_KM, RADIUS_KM)).toBeLessThan(1);
    expect(surfaceDetailBlend(1.2 * RADIUS_KM, RADIUS_KM)).toBe(1);
    expect(surfaceDetailBlend(RADIUS_KM, RADIUS_KM)).toBe(1);
    expect(surfaceDetailBlend(4 * RADIUS_KM, RADIUS_KM)).toBeLessThan(
      surfaceDetailBlend(2 * RADIUS_KM, RADIUS_KM),
    );
  });

  it('limits procedural breakup to the closest range', () => {
    expect(surfaceDetailProceduralBlend(1.5 * RADIUS_KM, RADIUS_KM)).toBe(0);
    expect(surfaceDetailProceduralBlend(1.35 * RADIUS_KM, RADIUS_KM)).toBeGreaterThan(0);
    expect(surfaceDetailProceduralBlend(1.2 * RADIUS_KM, RADIUS_KM)).toBe(1);
  });

  it.each([
    [Number.NaN, RADIUS_KM],
    [-1, RADIUS_KM],
    [RADIUS_KM, 0],
    [RADIUS_KM, Number.POSITIVE_INFINITY],
  ])('rejects nonphysical distance inputs (%s, %s)', (distanceKm, radiusKm) => {
    expect(() => surfaceDetailBlend(distanceKm, radiusKm)).toThrow(RangeError);
    expect(() => surfaceDetailProceduralBlend(distanceKm, radiusKm)).toThrow(RangeError);
  });
});

describe('surface detail material extension', () => {
  it('injects one guarded, stable two-octave standard-material extension', () => {
    const material = new MeshStandardMaterial();
    const previousCompile = vi.fn();
    material.onBeforeCompile = previousCompile;
    const loadedDetail = detail();
    const prepared = prepareSurfaceDetail(material, loadedDetail);
    const cacheKey = material.customProgramCacheKey();
    const shader = shaderFixture();

    material.onBeforeCompile(shader as never, {} as WebGLRenderer);

    expect(previousCompile).toHaveBeenCalledOnce();
    expect(material.customProgramCacheKey()).toBe(cacheKey);
    expect(cacheKey).toContain('solar-voyager-surface-detail-v1');
    expect(shader.uniforms).toMatchObject({
      uSurfaceDetailAlbedo: { value: loadedDetail.albedo },
      uSurfaceDetailNormal: { value: loadedDetail.normal },
      uSurfaceDetailBlend: { value: 0 },
      uSurfaceProceduralBlend: { value: 0 },
      uSurfaceTilesPerEquator: { value: 512 },
    });
    expect(shader.fragmentShader).toContain('if ( uSurfaceDetailBlend > 0.0 )');
    expect(shader.fragmentShader).toContain('uSurfaceTilesPerEquator * 7.73');
    expect(shader.fragmentShader).toContain('mat2( 0.8829, 0.4695, -0.4695, 0.8829 )');
    expect(shader.vertexShader).toContain('surfaceDetailFbm3');
    expect(shader.vertexShader).toContain('surfaceDetailPeriodicWave3');
    expect(shader.fragmentShader).not.toContain('vec3 surfaceDetailPeriodicWave3');
    expect(shader.fragmentShader).toContain('vec3( 0.21404114 )');
    expect(shader.fragmentShader).toContain('#include <map_fragment>');
    expect(shader.fragmentShader).toContain('#include <normal_fragment_maps>');
    expect(shader.fragmentShader).toContain('#include <roughnessmap_fragment>');
    expect(shader.vertexShader).toContain('vSurfaceProceduralNoise');
    expect(shader.vertexShader).toContain('vSurfaceDetailUv');

    prepared.dispose();
  });

  it('keeps seeds separated by the previous 16-bit truncation distinct', () => {
    const firstMaterial = new MeshStandardMaterial();
    const secondMaterial = new MeshStandardMaterial();
    const firstShader = shaderFixture();
    const secondShader = shaderFixture();
    prepareSurfaceDetail(firstMaterial, detail(1));
    prepareSurfaceDetail(secondMaterial, detail(65_537));

    firstMaterial.onBeforeCompile(firstShader as never, {} as WebGLRenderer);
    secondMaterial.onBeforeCompile(secondShader as never, {} as WebGLRenderer);

    expect(firstShader.uniforms.uSurfaceDetailSeed).not.toEqual(
      secondShader.uniforms.uSurfaceDetailSeed,
    );
  });

  it('reuses uniform objects while distance and the control toggle change', () => {
    const material = new MeshStandardMaterial();
    const prepared = prepareSurfaceDetail(material, detail());
    const shader = shaderFixture();
    material.onBeforeCompile(shader as never, {} as WebGLRenderer);
    const detailUniform = shader.uniforms.uSurfaceDetailBlend as { value: number };
    const proceduralUniform = shader.uniforms.uSurfaceProceduralBlend as { value: number };

    prepared.setDistance(3 * RADIUS_KM, RADIUS_KM);
    expect(shader.uniforms.uSurfaceDetailBlend).toBe(detailUniform);
    expect(detailUniform.value).toBe(surfaceDetailBlend(3 * RADIUS_KM, RADIUS_KM));
    expect(proceduralUniform.value).toBe(0);

    prepared.setDistance(1.2 * RADIUS_KM, RADIUS_KM);
    expect(detailUniform.value).toBe(1);
    expect(proceduralUniform.value).toBe(1);
    prepared.setEnabled(false);
    expect(detailUniform.value).toBe(0);
    expect(proceduralUniform.value).toBe(0);
    prepared.setEnabled(true);
    expect(detailUniform.value).toBe(1);
    expect(proceduralUniform.value).toBe(1);
  });

  it('disposes each owned texture once', () => {
    const loadedDetail = detail();
    const albedoDispose = vi.spyOn(loadedDetail.albedo, 'dispose');
    const normalDispose = vi.spyOn(loadedDetail.normal, 'dispose');
    const prepared = prepareSurfaceDetail(new MeshStandardMaterial(), loadedDetail);

    prepared.dispose();
    prepared.dispose();

    expect(albedoDispose).toHaveBeenCalledOnce();
    expect(normalDispose).toHaveBeenCalledOnce();
  });
});
