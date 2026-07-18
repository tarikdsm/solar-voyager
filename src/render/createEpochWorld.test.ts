import bodiesDocument from '../../data/bodies.json';
import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshLambertMaterial,
  Points,
  Vector3,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { BodyVisualAssetLoader } from './bodyVisualSystem.js';
import { createEpochWorld } from './createEpochWorld.js';
import type { StarCatalog } from './starCatalog.js';

describe('createEpochWorld', () => {
  it('registers every J2026 body with shared geometry and no scaffold cube', async () => {
    const compileAsync = vi.fn(async () => undefined);
    const renderer = { compileAsync, getPixelRatio: () => 2 } as unknown as WebGLRenderer;
    const assetLoader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async () => null),
    };
    const starCatalog: StarCatalog = {
      starCount: 3,
      strideFloats: 7,
      data: new Float32Array([
        1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0.8, 0.9, 1, 0, 0, 1, 2, 1, 0.9, 0.8,
      ]),
    };

    const world = await createEpochWorld(renderer, {
      assetLoader,
      initialViewportHeightPx: 720,
      starCatalog,
    });
    const bodyCount = bodiesDocument.bodies.length;

    expect(world.spaceScene.camera.position.toArray()).toEqual([0, 0, 0]);
    expect(world.cameraController.focusId).toBe('earth');
    expect(world.cameraPositionKm).toBe(world.cameraController.cameraPositionKm);
    expect(world.cameraController.focusBody('jupiter')).toBe(true);
    world.cameraController.update(1.5);
    expect(world.cameraController.focusId).toBe('jupiter');
    expect(world.spaceScene.camera.getWorldDirection(new Vector3()).length()).toBeCloseTo(1, 12);
    const spheres = world.spaceScene.scene.children.filter(
      (child): child is Mesh => child instanceof Mesh && child.name.includes('-sphere-'),
    );
    const points = world.spaceScene.scene.children.filter(
      (child): child is Points => child instanceof Points,
    );
    const ambientLights = world.spaceScene.scene.children.filter(
      (child): child is AmbientLight => child instanceof AmbientLight,
    );
    const directionalLights = world.spaceScene.scene.children.filter(
      (child): child is DirectionalLight => child instanceof DirectionalLight,
    );
    expect(spheres).toHaveLength(bodyCount * 2);
    expect(spheres.every((sphere) => sphere.material instanceof MeshLambertMaterial)).toBe(true);
    expect(points).toHaveLength(3);
    expect(ambientLights).toEqual([world.lighting.ambientLight]);
    expect(directionalLights).toEqual([world.lighting.directionalLight]);
    expect(world.proceduralSun.seed).toBe(10);
    expect(world.proceduralSun.billboard.name).toBe('sun-glare');
    expect(world.spaceScene.scene.getObjectByName('sun-glare')).toBe(world.proceduralSun.billboard);
    expect(world.lighting.directionalLight.intensity).toBeGreaterThan(0);
    expect(world.visualSystem.pointCloud.points.geometry.getAttribute('position').count).toBe(
      bodyCount,
    );
    expect(world.starfield.points.name).toBe('starfield');
    expect(world.starfield.points.parent).toBe(world.spaceScene.scene);
    expect(world.starfield.points.geometry.getAttribute('position').count).toBe(
      starCatalog.starCount,
    );
    expect(world.starfield.points.material.uniforms.uPixelRatio?.value).toBe(2);
    expect(world.osculatingConic.line.name).toBe('osculating-conic');
    expect(world.osculatingConic.line.parent?.name).toBe('osculating-conic-anchor');
    expect(world.spaceScene.scene.getObjectByName('osculating-conic')).toBe(
      world.osculatingConic.line,
    );
    expect(world.trajectoryOverlay.line.parent).toBe(world.spaceScene.scene);
    expect(world.trajectoryOverlay.markers.parent).toBe(world.spaceScene.scene);
    expect(world.spaceScene.scene.getObjectByName('predicted-trajectory')).toBe(
      world.trajectoryOverlay.line,
    );
    expect(world.spaceScene.scene.getObjectByName('trajectory-event-markers')).toBe(
      world.trajectoryOverlay.markers,
    );
    expect(spheres.every((sphere) => sphere.geometry === spheres[0]?.geometry)).toBe(true);
    expect(world.visualSystem.getTier('sun')).toBe(2);
    expect(world.visualSystem.getTier('earth')).toBe(3);
    expect(world.visualSystem.getOpacity('earth', 1)).toBe(0);
    expect(world.visualSystem.getOpacity('earth', 2)).toBe(1);
    expect(assetLoader.loadModel).toHaveBeenCalledOnce();
    expect(assetLoader.loadModel).toHaveBeenCalledWith('earth');
    expect(compileAsync).toHaveBeenCalledOnce();

    let hasCube = false;
    world.spaceScene.scene.traverse((object: Object3D) => {
      if (object instanceof Mesh && object.geometry instanceof BoxGeometry) hasCube = true;
    });
    expect(hasCube).toBe(false);
  });
});
