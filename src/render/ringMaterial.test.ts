import { DataTexture, DoubleSide, MeshStandardMaterial, RGBAFormat } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { ringDefinitionFor } from './ringCatalog.js';
import { prepareRingMaterials } from './ringMaterial.js';

function shader() {
  return {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader:
      '#include <common>\n#include <map_fragment>\n#include <lights_fragment_begin>\n#include <output_fragment>',
  };
}

describe('ring material preparation', () => {
  it('injects analytic planet shadow, ring shadow, and bounded backlight once', () => {
    const surface = new MeshStandardMaterial();
    surface.name = 'mat_surface';
    const rings = new MeshStandardMaterial();
    rings.name = 'mat_rings';
    rings.map = new DataTexture(new Uint8Array([255, 220, 180, 128]), 1, 1, RGBAFormat);
    const previousSurfaceCompile = vi.fn();
    const previousRingCompile = vi.fn();
    surface.onBeforeCompile = previousSurfaceCompile;
    rings.onBeforeCompile = previousRingCompile;
    surface.customProgramCacheKey = () => 'surface-base';
    rings.customProgramCacheKey = () => 'rings-base';
    const definition = ringDefinitionFor('neptune');
    if (definition === null) throw new Error('Missing Neptune test definition.');

    const prepared = prepareRingMaterials(surface, rings, definition, 0.98);
    const surfaceShader = shader();
    const ringShader = shader();
    surface.onBeforeCompile(surfaceShader as never, {} as never);
    rings.onBeforeCompile(ringShader as never, {} as never);

    expect(previousSurfaceCompile).toHaveBeenCalledOnce();
    expect(previousRingCompile).toHaveBeenCalledOnce();
    expect(surfaceShader.fragmentShader).toContain('ringPlaneIntersection');
    expect(surfaceShader.fragmentShader).toContain('uRingOpacityMap');
    expect(ringShader.fragmentShader).toContain('ringPlanetOcclusion');
    expect(ringShader.fragmentShader).toContain('RING_MAX_TRANSMISSION 0.22');
    expect(ringShader.fragmentShader).toContain('Fraternite');
    expect(rings.side).toBe(DoubleSide);
    expect(rings.transparent).toBe(true);
    expect(rings.depthWrite).toBe(false);
    expect(surface.customProgramCacheKey()).toBe('surface-base|solar-voyager-rings-neptune-v1');
    expect(rings.customProgramCacheKey()).toBe('rings-base|solar-voyager-rings-neptune-v1');
    expect(prepared.texture).toBe(rings.map);
  });

  it('reuses uniform objects while normalizing Sun direction and clamping blend', () => {
    const surface = new MeshStandardMaterial();
    const rings = new MeshStandardMaterial();
    rings.map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
    const definition = ringDefinitionFor('saturn');
    if (definition === null) throw new Error('Missing Saturn test definition.');
    const prepared = prepareRingMaterials(surface, rings, definition, 0.9);
    const direction = prepared.sunDirection;

    prepared.updateSunDirection(3, 4, 0);
    expect(prepared.sunDirection).toBe(direction);
    expect(direction.toArray()).toEqual([0.6, 0.8, 0]);
    prepared.setRepresentationBlend(2);
    expect(prepared.representationBlend).toBe(1);
    prepared.setRepresentationBlend(-1);
    expect(prepared.representationBlend).toBe(0);
    expect(() => prepared.updateSunDirection(0, 0, 0)).toThrow(/Sun direction/u);
    expect(() => prepared.setRepresentationBlend(Number.NaN)).toThrow(/blend/u);
  });
});
