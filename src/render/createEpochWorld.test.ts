import bodiesDocument from '../../data/bodies.json';
import {
  BoxGeometry,
  Mesh,
  Points,
  Vector3,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { BodyVisualAssetLoader } from './bodyVisualSystem.js';
import { createEpochWorld } from './createEpochWorld.js';

describe('createEpochWorld', () => {
  it('registers every J2026 body with shared geometry and no scaffold cube', async () => {
    const compileAsync = vi.fn(async () => undefined);
    const renderer = { compileAsync } as unknown as WebGLRenderer;
    const assetLoader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async () => null),
    };

    const world = await createEpochWorld(renderer, { assetLoader });
    const bodyCount = bodiesDocument.bodies.length;

    expect(world.spaceScene.camera.position.toArray()).toEqual([0, 0, 0]);
    expect(world.spaceScene.camera.getWorldDirection(new Vector3()).length()).toBeCloseTo(1, 12);
    const spheres = world.spaceScene.scene.children.filter(
      (child): child is Mesh => child instanceof Mesh,
    );
    const points = world.spaceScene.scene.children.filter(
      (child): child is Points => child instanceof Points,
    );
    expect(spheres).toHaveLength(bodyCount);
    expect(points).toHaveLength(1);
    expect(points[0]?.geometry.getAttribute('position').count).toBe(bodyCount);
    expect(spheres.every((sphere) => sphere.geometry === spheres[0]?.geometry)).toBe(true);
    expect(world.visualSystem.getTier('sun')).toBe(1);
    expect(world.visualSystem.getTier('earth')).toBe(1);
    expect(assetLoader.loadModel).not.toHaveBeenCalled();
    expect(compileAsync).toHaveBeenCalledOnce();

    let hasCube = false;
    world.spaceScene.scene.traverse((object: Object3D) => {
      if (object instanceof Mesh && object.geometry instanceof BoxGeometry) hasCube = true;
    });
    expect(hasCube).toBe(false);
  });
});
