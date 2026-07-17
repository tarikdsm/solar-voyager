import { AmbientLight, DirectionalLight } from 'three';
import { describe, expect, it } from 'vitest';

import { AU_KM } from '../core/constants.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';
import { AMBIENT_LIGHT_INTENSITY, SolarLighting } from './solarLighting.js';

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
  it('owns one inverse-square solar light and the ambient floor without visual effects', () => {
    const { lighting, spaceScene } = createFixture();
    const ambientLights = spaceScene.scene.children.filter(
      (child): child is AmbientLight => child instanceof AmbientLight,
    );
    const directionalLights = spaceScene.scene.children.filter(
      (child): child is DirectionalLight => child instanceof DirectionalLight,
    );

    expect(ambientLights).toEqual([lighting.ambientLight]);
    expect(directionalLights).toEqual([lighting.directionalLight]);
    expect(lighting.ambientLight.intensity).toBe(AMBIENT_LIGHT_INTENSITY);
    expect(lighting.directionalLight.intensity).toBeCloseTo(Math.PI, 12);
    expect(lighting.directionalLight.position.toArray()).toEqual([-1, 0, 0]);
    expect(lighting.directionalLight.matrixAutoUpdate).toBe(false);
    expect(lighting.directionalLight.target.matrixAutoUpdate).toBe(false);
    expect(lighting.directionalLight.target.parent).toBe(spaceScene.scene);

    expect(spaceScene.scene.getObjectByName('sun-glare')).toBeUndefined();
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

  it('removes its scene lights on disposal', () => {
    const { lighting, spaceScene } = createFixture();

    lighting.dispose();

    expect(lighting.ambientLight.parent).toBeNull();
    expect(lighting.directionalLight.parent).toBeNull();
    expect(lighting.directionalLight.target.parent).toBeNull();
    expect(spaceScene.scene.getObjectByName('sun-glare')).toBeUndefined();
  });
});
