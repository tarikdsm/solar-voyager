import {
  AdditiveBlending,
  BackSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  type Material,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { prepareEarthSurfaceLayers } from './earthSurfaceLayers.js';

function earthFixture(): {
  root: Group;
  surface: Mesh<SphereGeometry, MeshStandardMaterial>;
  clouds: Mesh<SphereGeometry, MeshStandardMaterial>;
  materials: Material[];
} {
  const root = new Group();
  const surface = new Mesh(new SphereGeometry(1, 8, 8), new MeshStandardMaterial());
  surface.material.name = 'mat_surface';
  const clouds = new Mesh(new SphereGeometry(1.01, 8, 8), new MeshStandardMaterial());
  clouds.material.name = 'mat_clouds';
  clouds.matrixAutoUpdate = false;
  clouds.updateMatrix();
  root.add(surface, clouds);
  return { root, surface, clouds, materials: [surface.material, clouds.material] };
}

describe('Earth surface layers', () => {
  it('adds one shared-geometry back-face Fresnel atmosphere during setup', () => {
    const fixture = earthFixture();
    const prepared = prepareEarthSurfaceLayers(fixture.root, fixture.materials);

    expect(prepared).not.toBeNull();
    const atmosphere = fixture.root.getObjectByName('earth-atmosphere-rim');
    expect(atmosphere).toBeInstanceOf(Mesh);
    if (!(atmosphere instanceof Mesh) || !(atmosphere.material instanceof MeshBasicMaterial)) {
      throw new Error('Atmosphere fixture was not prepared.');
    }
    expect(atmosphere.geometry).toBe(fixture.clouds.geometry);
    expect(atmosphere.material.side).toBe(BackSide);
    expect(atmosphere.material.blending).toBe(AdditiveBlending);
    expect(atmosphere.material.transparent).toBe(true);
    expect(atmosphere.material.depthTest).toBe(true);
    expect(atmosphere.material.depthWrite).toBe(false);
    expect(fixture.materials).toContain(atmosphere.material);

    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\nvec4 diffuseColor = vec4( diffuse, opacity );',
    };
    const key = atmosphere.material.customProgramCacheKey();
    atmosphere.material.onBeforeCompile(shader as never, {} as WebGLRenderer);
    expect(atmosphere.material.customProgramCacheKey()).toBe(key);
    expect(key).toContain('solar-voyager-earth-atmosphere-v1');
    expect(shader.vertexShader).toContain('vAtmosphereNormal');
    expect(shader.fragmentShader).toContain('atmosphereFresnel');
  });

  it('updates only the existing cloud transform and allocates no replacement layer objects', () => {
    const fixture = earthFixture();
    const surfaceMatrix = fixture.surface.matrix;
    const cloudMatrix = fixture.clouds.matrix;
    const prepared = prepareEarthSurfaceLayers(fixture.root, fixture.materials);
    if (prepared === null) throw new Error('Earth layers were not prepared.');
    const atmosphere = fixture.root.getObjectByName('earth-atmosphere-rim');
    const atmosphereMaterial = atmosphere instanceof Mesh ? atmosphere.material : null;
    const before = fixture.clouds.matrix.elements.slice();

    prepared.update(0);
    prepared.update(10_000);

    expect(fixture.surface.matrix).toBe(surfaceMatrix);
    expect(fixture.clouds.matrix).toBe(cloudMatrix);
    expect(fixture.clouds.matrix.elements).not.toEqual(before);
    expect(fixture.root.getObjectByName('earth-atmosphere-rim')).toBe(atmosphere);
    expect(atmosphere instanceof Mesh ? atmosphere.material : null).toBe(atmosphereMaterial);
  });

  it('returns null without a cloud shell and disposes only its owned atmosphere', () => {
    const root = new Group();
    expect(prepareEarthSurfaceLayers(root, [])).toBeNull();

    const fixture = earthFixture();
    const prepared = prepareEarthSurfaceLayers(fixture.root, fixture.materials);
    if (prepared === null) throw new Error('Earth layers were not prepared.');
    const atmosphere = fixture.root.getObjectByName('earth-atmosphere-rim');
    if (!(atmosphere instanceof Mesh) || !(atmosphere.material instanceof MeshBasicMaterial)) {
      throw new Error('Atmosphere fixture was not prepared.');
    }
    const dispose = vi.spyOn(atmosphere.material, 'dispose');

    prepared.dispose();
    prepared.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(atmosphere.parent).toBeNull();
    expect(fixture.clouds.geometry).toBeDefined();
  });
});
