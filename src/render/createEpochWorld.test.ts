import bodiesDocument from '../../data/bodies.json';
import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Points,
  Vector3,
  type BufferAttribute,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { BodyVisualAssetLoader } from './bodyVisualSystem.js';
import { createEpochWorld } from './createEpochWorld.js';
import type { StarCatalog } from './starCatalog.js';
import { SYSTEM_MAP_ORBIT_SEGMENTS } from './systemMapScene.js';

function expectAttributeRangeInFrustum(
  attribute: BufferAttribute,
  start: number,
  count: number,
  camera: import('three').PerspectiveCamera,
): void {
  const projected = new Vector3();
  for (let index = start; index < start + count; index += 1) {
    projected.fromBufferAttribute(attribute, index).project(camera);
    expect(Math.abs(projected.x)).toBeLessThanOrEqual(1.000_001);
    expect(Math.abs(projected.y)).toBeLessThanOrEqual(1.000_001);
    expect(projected.z).toBeGreaterThanOrEqual(-1.000_001);
    expect(projected.z).toBeLessThanOrEqual(1.000_001);
  }
}

describe('createEpochWorld', () => {
  it('registers every J2026 body with shared geometry and no scaffold cube', async () => {
    const compileAsync = vi.fn(async () => undefined);
    const renderer = { compileAsync, getPixelRatio: () => 2 } as unknown as WebGLRenderer;
    const earthModelRoot = new Group();
    const earthModelMaterial = new MeshBasicMaterial();
    earthModelRoot.add(new Mesh(undefined, earthModelMaterial));
    const assetLoader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async (id: string) =>
        id === 'earth'
          ? { root: earthModelRoot, materials: [earthModelMaterial], surfaceDetail: null }
          : null,
      ),
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
      initialViewportWidthPx: 1_280,
      initialViewportHeightPx: 720,
      starCatalog,
    });
    const bodyCount = bodiesDocument.bodies.length;

    expect(world.spaceScene.camera.position.toArray()).toEqual([0, 0, 0]);
    expect(world.cameraController.focusId).toBe('earth');
    expect(world.systemMap.cameraController.focusId).toBe('sun');
    expect(world.systemMap.cameraPositionKm).toBe(
      world.systemMap.cameraController.cameraPositionKm,
    );
    expect(world.systemMap.diagnostics.bodyCount).toBe(bodyCount);
    expect(world.systemMap.diagnostics.iconDrawCount).toBe(1);
    expect(world.systemMap.diagnostics.orbitDrawCount).toBe(1);
    expect(world.systemMap.diagnostics.selectedVisible).toBe(true);
    expect(world.systemMap.spaceScene.camera.aspect).toBeCloseTo(16 / 9, 12);
    expect(world.systemMap.bodyIcons.parent).toBe(world.systemMap.spaceScene.scene);
    expect(world.systemMap.orbitLines.parent).toBe(world.systemMap.spaceScene.scene);
    expectAttributeRangeInFrustum(
      world.systemMap.bodyIcons.geometry.getAttribute('position') as BufferAttribute,
      0,
      bodyCount,
      world.systemMap.spaceScene.camera,
    );
    expectAttributeRangeInFrustum(
      world.systemMap.orbitLines.geometry.getAttribute('position') as BufferAttribute,
      0,
      (bodyCount - 1) * SYSTEM_MAP_ORBIT_SEGMENTS * 2,
      world.systemMap.spaceScene.camera,
    );

    for (const bodyId of ['mercury', 'neptune', 'eris']) {
      const bodyIndex = bodiesDocument.bodies.findIndex((body) => body.id === bodyId);
      expect(bodyIndex).toBeGreaterThan(0);
      expect(world.systemMap.focusBody(bodyId)).toBe(true);
      world.systemMap.update(2);
      expect(world.systemMap.diagnostics.selectedVisible).toBe(true);
      const semiMajorAxisKm = Math.abs(
        bodiesDocument.bodies[bodyIndex]?.elements?.semiMajorAxisKm ?? 0,
      );
      expect(semiMajorAxisKm).toBeGreaterThan(0);
      expect(world.systemMap.diagnostics.selectedOrbitAlignmentKm).toBeLessThan(
        semiMajorAxisKm * 0.002,
      );
      expect(world.systemMap.diagnostics.selectedOrbitAlignmentPx).toBeLessThan(1);
      expectAttributeRangeInFrustum(
        world.systemMap.orbitLines.geometry.getAttribute('position') as BufferAttribute,
        (bodyIndex - 1) * SYSTEM_MAP_ORBIT_SEGMENTS * 2,
        SYSTEM_MAP_ORBIT_SEGMENTS * 2,
        world.systemMap.spaceScene.camera,
      );
    }
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
    await vi.waitFor(() => expect(compileAsync).toHaveBeenCalledTimes(3));
    expect(compileAsync).toHaveBeenCalledWith(world.spaceScene.scene, world.spaceScene.camera);
    expect(compileAsync).toHaveBeenCalledWith(
      world.systemMap.spaceScene.scene,
      world.systemMap.spaceScene.camera,
    );
    expect(compileAsync).toHaveBeenCalledWith(
      earthModelRoot,
      world.spaceScene.camera,
      world.spaceScene.scene,
    );

    let hasCube = false;
    world.spaceScene.scene.traverse((object: Object3D) => {
      if (object instanceof Mesh && object.geometry instanceof BoxGeometry) hasCube = true;
    });
    expect(hasCube).toBe(false);

    const mapIconPosition = world.systemMap.bodyIcons.geometry.getAttribute('position');
    world.positionsKm[0] = (world.positionsKm[0] as number) + 12_345;
    world.systemMap.update(0);
    world.systemMap.spaceScene.updateCameraRelative({ x: 0, y: 0, z: 0 });
    expect(mapIconPosition.getX(0)).toBe(Math.fround(world.positionsKm[0] as number));
  });
});
