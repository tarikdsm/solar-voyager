import {
  AdditiveBlending,
  AmbientLight,
  DataTexture,
  DirectionalLight,
  Sprite,
  SpriteMaterial,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { AU_KM } from '../core/constants.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';
import {
  AMBIENT_LIGHT_INTENSITY,
  GLARE_TEXTURE_SIZE,
  SUN_GLARE_DIAMETER_IN_RADII,
  SolarLighting,
} from './solarLighting.js';

const SUN_RADIUS_KM = 695_700;

function createFixture(): {
  readonly positionsKm: Float64Array;
  readonly spaceScene: CameraRelativeSpaceScene;
  readonly lighting: SolarLighting;
} {
  const positionsKm = new Float64Array([0, 0, 0, AU_KM, 0, 0, 2 * AU_KM, 0, 0]);
  const spaceScene = new CameraRelativeSpaceScene();
  const lighting = new SolarLighting(spaceScene, positionsKm, 0, 3, SUN_RADIUS_KM);
  return { positionsKm, spaceScene, lighting };
}

describe('SolarLighting', () => {
  it('owns one inverse-square solar light, the ambient floor, and a static glare', () => {
    const { lighting, spaceScene } = createFixture();
    const ambientLights = spaceScene.scene.children.filter(
      (child): child is AmbientLight => child instanceof AmbientLight,
    );
    const directionalLights = spaceScene.scene.children.filter(
      (child): child is DirectionalLight => child instanceof DirectionalLight,
    );
    const sprites = spaceScene.scene.children.filter(
      (child): child is Sprite => child instanceof Sprite,
    );

    expect(ambientLights).toEqual([lighting.ambientLight]);
    expect(directionalLights).toEqual([lighting.directionalLight]);
    expect(lighting.ambientLight.intensity).toBe(AMBIENT_LIGHT_INTENSITY);
    expect(lighting.directionalLight.intensity).toBeCloseTo(Math.PI, 12);
    expect(lighting.directionalLight.position.toArray()).toEqual([-1, 0, 0]);
    expect(lighting.directionalLight.matrixAutoUpdate).toBe(false);
    expect(lighting.directionalLight.target.matrixAutoUpdate).toBe(false);
    expect(lighting.directionalLight.target.parent).toBe(spaceScene.scene);

    expect(sprites).toEqual([lighting.glare]);
    expect(lighting.glare.name).toBe('sun-glare');
    expect(lighting.glare.scale.toArray()).toEqual([
      SUN_RADIUS_KM * SUN_GLARE_DIAMETER_IN_RADII,
      SUN_RADIUS_KM * SUN_GLARE_DIAMETER_IN_RADII,
      1,
    ]);
    expect(lighting.glare.matrixAutoUpdate).toBe(false);
    expect(lighting.glare.frustumCulled).toBe(true);
    expect(lighting.glare.material).toBeInstanceOf(SpriteMaterial);
    expect(lighting.glare.material.blending).toBe(AdditiveBlending);
    expect(lighting.glare.material.depthTest).toBe(true);
    expect(lighting.glare.material.depthWrite).toBe(false);
    expect(lighting.glare.material.toneMapped).toBe(true);
  });

  it('updates in place at 2 AU and remains finite at coincident Sun focus', () => {
    const { lighting, positionsKm } = createFixture();
    const originalPosition = lighting.directionalLight.position;

    lighting.setFocusPositionOffset(6);
    lighting.update();

    expect(lighting.directionalLight.position).toBe(originalPosition);
    expect(lighting.directionalLight.position.toArray()).toEqual([-1, 0, 0]);
    expect(lighting.directionalLight.intensity).toBeCloseTo(Math.PI / 4, 12);

    lighting.setFocusPositionOffset(0);
    lighting.update();

    expect(lighting.directionalLight.position.toArray()).toEqual([-1, 0, 0]);
    expect(lighting.directionalLight.intensity).toBeCloseTo(
      Math.PI * (AU_KM / SUN_RADIUS_KM) ** 2,
      8,
    );
    expect(Number.isFinite(lighting.directionalLight.intensity)).toBe(true);
    expect(positionsKm.byteLength).toBe(9 * Float64Array.BYTES_PER_ELEMENT);
  });

  it('rejects malformed packed positions, offsets, and solar radii', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const valid = new Float64Array([0, 0, 0, AU_KM, 0, 0]);

    expect(() => new SolarLighting(spaceScene, new Float64Array([0, 0]), 0, 0, 1)).toThrow(
      /packed positions/iu,
    );
    expect(() => new SolarLighting(spaceScene, valid, 1, 3, 1)).toThrow(/offset/iu);
    expect(() => new SolarLighting(spaceScene, valid, 0, 6, 1)).toThrow(/offset/iu);
    expect(() => new SolarLighting(spaceScene, valid, 0, 3, 0)).toThrow(/solar radius/iu);

    const lighting = new SolarLighting(spaceScene, valid, 0, 3, 1);
    expect(() => lighting.setFocusPositionOffset(-3)).toThrow(/offset/iu);
  });

  it('creates a radial texture with transparent edges and an opaque centre', () => {
    const { lighting } = createFixture();
    const texture = lighting.glare.material.map;

    expect(texture).toBeInstanceOf(DataTexture);
    const image = texture?.image as {
      readonly data: unknown;
      readonly height: number;
      readonly width: number;
    };
    expect(image.width).toBe(GLARE_TEXTURE_SIZE);
    expect(image.height).toBe(GLARE_TEXTURE_SIZE);
    const data = image.data;
    expect(data).toBeInstanceOf(Uint8Array);
    if (!(data instanceof Uint8Array)) throw new Error('Expected glare byte texture.');
    const alphaAt = (x: number, y: number): number =>
      data[(y * GLARE_TEXTURE_SIZE + x) * 4 + 3] ?? -1;
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(GLARE_TEXTURE_SIZE - 1, 0)).toBe(0);
    expect(alphaAt(0, GLARE_TEXTURE_SIZE - 1)).toBe(0);
    expect(alphaAt(GLARE_TEXTURE_SIZE - 1, GLARE_TEXTURE_SIZE - 1)).toBe(0);
    expect(alphaAt(GLARE_TEXTURE_SIZE / 2, GLARE_TEXTURE_SIZE / 2)).toBeGreaterThan(250);
  });

  it('disposes owned GPU resources and removes its scene objects', () => {
    const { lighting, spaceScene } = createFixture();
    const texture = lighting.glare.material.map;
    if (texture === null) throw new Error('Expected glare texture.');
    const textureDispose = vi.spyOn(texture, 'dispose');
    const materialDispose = vi.spyOn(lighting.glare.material, 'dispose');

    lighting.dispose();

    expect(textureDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(lighting.ambientLight.parent).toBeNull();
    expect(lighting.directionalLight.parent).toBeNull();
    expect(lighting.directionalLight.target.parent).toBeNull();
    expect(lighting.glare.parent).toBeNull();
    expect(spaceScene.scene.children).not.toContain(lighting.glare);
  });
});
