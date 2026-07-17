import {
  AdditiveBlending,
  MeshBasicMaterial,
  MeshLambertMaterial,
  ShaderMaterial,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { ProceduralSun, SUN_BILLBOARD_DIAMETER_IN_RADII } from './proceduralSun.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';

const SUN_RADIUS_KM = 695_700;

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

function createFixture(): {
  readonly positionsKm: Float64Array;
  readonly spaceScene: CameraRelativeSpaceScene;
  readonly sun: ProceduralSun;
} {
  const positionsKm = new Float64Array([10, 20, 30]);
  const spaceScene = new CameraRelativeSpaceScene();
  const sun = new ProceduralSun(spaceScene, positionsKm, 0, SUN_RADIUS_KM, 10);
  return { positionsKm, spaceScene, sun };
}

describe('ProceduralSun', () => {
  it('creates one preallocated additive billboard with bounded shader work', () => {
    const { spaceScene, sun } = createFixture();

    expect(sun.billboard.name).toBe('sun-glare');
    expect(sun.billboard.material).toBeInstanceOf(ShaderMaterial);
    expect(sun.billboard.material.blending).toBe(AdditiveBlending);
    expect(sun.billboard.material.depthTest).toBe(true);
    expect(sun.billboard.material.depthWrite).toBe(false);
    expect(sun.billboard.material.transparent).toBe(true);
    expect(sun.billboard.frustumCulled).toBe(true);
    expect(sun.billboard.geometry.boundingSphere?.radius).toBe(
      (SUN_RADIUS_KM * SUN_BILLBOARD_DIAMETER_IN_RADII) / 2,
    );
    expect(sun.billboard.matrixAutoUpdate).toBe(false);
    expect(sun.billboard.material.vertexShader).toContain('sunCenterView.xy += position.xy');
    expect(sun.billboard.material.fragmentShader).toContain('sunProminenceArc');
    expect(sun.billboard.material.fragmentShader).toContain('sunCorona');
    expect(sun.billboard.material.uniforms.uSunBillboardDiameterKm?.value).toBe(
      SUN_RADIUS_KM * SUN_BILLBOARD_DIAMETER_IN_RADII,
    );
    expect(spaceScene.scene.getObjectByName('sun-glare')).toBe(sun.billboard);
  });

  it('shares time, quality, and fallback uniforms with every prepared disc material', () => {
    const { sun } = createFixture();
    const material = new MeshLambertMaterial();
    const previousCompile = material.onBeforeCompile;
    sun.prepareMaterial(material);
    const shader = shaderFixture();
    material.onBeforeCompile(shader as never, {} as WebGLRenderer);

    expect(shader.uniforms.uSunTimePhases).toBe(sun.billboard.material.uniforms.uSunTimePhases);
    expect(shader.uniforms.uSunOctaves).toBe(sun.billboard.material.uniforms.uSunOctaves);
    expect(shader.uniforms.uSunEnabled).toBe(sun.billboard.material.uniforms.uSunEnabled);

    const phaseUniform = shader.uniforms.uSunTimePhases;
    sun.update(150);
    expect(shader.uniforms.uSunTimePhases).toBe(phaseUniform);
    expect((phaseUniform?.value as { y: number }).y).toBeCloseTo(1, 12);

    sun.setQuality('minimum');
    expect(shader.uniforms.uSunOctaves?.value).toBe(1);
    sun.setEnabled(false);
    expect(shader.uniforms.uSunEnabled?.value).toBe(0);
    expect(sun.billboard.visible).toBe(false);
    sun.setEnabled(true);
    expect(sun.billboard.visible).toBe(true);

    sun.dispose();
    expect(material.onBeforeCompile).toBe(previousCompile);
  });

  it('rejects unsupported material preparation', () => {
    const { sun } = createFixture();
    expect(() => sun.prepareMaterial(new MeshBasicMaterial())).toThrow(TypeError);
  });

  it('disposes owned and prepared resources once', () => {
    const { spaceScene, sun } = createFixture();
    const material = new MeshLambertMaterial();
    const previousCompile = material.onBeforeCompile;
    sun.prepareMaterial(material);
    const geometryDispose = vi.spyOn(sun.billboard.geometry, 'dispose');
    const materialDispose = vi.spyOn(sun.billboard.material, 'dispose');

    sun.dispose();
    sun.dispose();

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(material.onBeforeCompile).toBe(previousCompile);
    expect(spaceScene.scene.getObjectByName('sun-glare')).toBeUndefined();
    expect(() => sun.prepareMaterial(new MeshLambertMaterial())).toThrow(/disposed/iu);
  });

  it('rejects malformed packed positions, offsets, radii, and seeds', () => {
    const scene = new CameraRelativeSpaceScene();
    const positions = new Float64Array([0, 0, 0]);

    expect(() => new ProceduralSun(scene, new Float64Array([0, 0]), 0, 1, 10)).toThrow(/packed/iu);
    expect(() => new ProceduralSun(scene, positions, 3, 1, 10)).toThrow(/offset/iu);
    expect(() => new ProceduralSun(scene, positions, 0, 0, 10)).toThrow(/radius/iu);
    expect(() => new ProceduralSun(scene, positions, 0, 1, -1)).toThrow(/seed/iu);
  });
});
