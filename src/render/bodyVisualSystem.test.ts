import { Group, Mesh, MeshBasicMaterial, Texture, type Material } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { LoadedBodyModel } from './bodyAssetLoader.js';
import type { BodyVisualAssetLoader, BodyVisualDefinition } from './bodyVisualSystem.js';
import { BodyVisualSystem } from './bodyVisualSystem.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';

const AU_KM = 149_597_870.7;

function definitions(): BodyVisualDefinition[] {
  return [
    {
      id: 'sun',
      category: 'sun',
      meanRadiusKm: 10,
      geometricAlbedo: 1,
      albedoColor: 0xffdd88,
    },
    {
      id: 'earth',
      category: 'planet',
      meanRadiusKm: 1,
      geometricAlbedo: 0.434,
      albedoColor: 0x4488ff,
    },
  ];
}

function positions(): Float64Array {
  return new Float64Array([0, 0, 0, AU_KM, 0, 0]);
}

function cameraAtEarthDistance(distanceKm: number): { x: number; y: number; z: number } {
  return { x: AU_KM + distanceKm, y: 0, z: 0 };
}

function loadedModel(material: Material = new MeshBasicMaterial()): LoadedBodyModel {
  const root = new Group();
  root.add(new Mesh(undefined, material));
  return { root, materials: [material] };
}

describe('BodyVisualSystem structure', () => {
  it('creates one point cloud, one shared sphere geometry, and true-radius scales', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async () => null),
    };
    new BodyVisualSystem(
      spaceScene,
      definitions(),
      positions(),
      loader,
      vi.fn(async () => undefined),
    );

    const points = spaceScene.scene.children.filter((child) => child.type === 'Points');
    const spheres = spaceScene.scene.children.filter(
      (child): child is Mesh => child instanceof Mesh,
    );
    expect(points).toHaveLength(1);
    expect(spheres).toHaveLength(2);
    expect(spheres[0]?.geometry).toBe(spheres[1]?.geometry);
    expect(spheres.map((sphere) => sphere.scale.x)).toEqual([10, 1]);
    expect(spheres.every((sphere) => sphere.visible)).toBe(true);
    expect(spaceScene.scene.children).toHaveLength(3);
  });

  it('preloads hero sphere textures without requesting a model', async () => {
    const earthTexture = new Texture();
    const loadSphereAlbedo = vi.fn(async (id: string) => (id === 'earth' ? earthTexture : null));
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo,
      loadModel: vi.fn(async () => null),
    };
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      definitions(),
      positions(),
      loader,
      vi.fn(async () => undefined),
    );

    await system.initializeEager();

    expect(loader.preloadHeroSpheres).toHaveBeenCalledOnce();
    expect(loadSphereAlbedo).toHaveBeenCalledTimes(2);
    expect(loader.loadModel).not.toHaveBeenCalled();
  });
});

describe('BodyVisualSystem transitions', () => {
  it('does not request a non-hero sphere before its first approach', async () => {
    const sun = definitions()[0];
    if (sun === undefined) throw new Error('Sun fixture is missing.');
    const loadSphereAlbedo = vi.fn(async () => new Texture());
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo,
      loadModel: vi.fn(async () => null),
    };
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      [
        sun,
        {
          id: 'pluto',
          category: 'dwarf',
          meanRadiusKm: 1,
          geometricAlbedo: 0.52,
          albedoColor: 0xccaa88,
        },
      ],
      positions(),
      loader,
      vi.fn(async () => undefined),
    );

    system.update(cameraAtEarthDistance(2_000), 1_000, 1, 0);
    expect(loadSphereAlbedo).not.toHaveBeenCalled();

    system.update(cameraAtEarthDistance(100), 1_000, 1, 100);
    system.update(cameraAtEarthDistance(100), 1_000, 1, 200);
    await vi.waitFor(() => expect(loadSphereAlbedo).toHaveBeenCalledOnce());
    expect(loadSphereAlbedo).toHaveBeenCalledWith('pluto', 'dwarf');
  });

  it('flies point → sphere → model → sphere → point without darkness or duplicate loads', async () => {
    let resolveCompile!: () => void;
    const compilePromise = new Promise<void>((resolve) => {
      resolveCompile = resolve;
    });
    const model = loadedModel();
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async () => model),
    };
    const compile = vi.fn(() => compilePromise);
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      definitions(),
      positions(),
      loader,
      compile,
    );
    const fov = 1;
    const height = 1_000;

    system.update(cameraAtEarthDistance(2_000), height, fov, 0);
    expect(system.getTier('earth')).toBe(1);
    expect(system.getOpacity('earth', 1)).toBe(1);

    system.update(cameraAtEarthDistance(100), height, fov, 100);
    expect(system.getTier('earth')).toBe(2);
    system.update(cameraAtEarthDistance(100), height, fov, 225);
    expect(system.getOpacity('earth', 1)).toBeCloseTo(0.5, 5);
    expect(system.getOpacity('earth', 2)).toBeCloseTo(0.5, 5);
    expect(system.getOpacitySum('earth')).toBeGreaterThan(0);

    system.update(cameraAtEarthDistance(5), height, fov, 400);
    system.update(cameraAtEarthDistance(5), height, fov, 410);
    expect(system.getTier('earth')).toBe(3);
    expect(system.getLoadState('earth')).toBe('loading');
    expect(system.getOpacity('earth', 3)).toBe(0);
    expect(loader.loadModel).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(compile).toHaveBeenCalledOnce());
    expect(system.getLoadState('earth')).toBe('loading');

    resolveCompile();
    await compilePromise;
    await vi.waitFor(() => expect(system.getLoadState('earth')).toBe('ready'));
    system.update(cameraAtEarthDistance(5), height, fov, 500);
    system.update(cameraAtEarthDistance(5), height, fov, 625);
    expect(system.getOpacity('earth', 2)).toBeCloseTo(0.5, 5);
    expect(system.getOpacity('earth', 3)).toBeCloseTo(0.5, 5);
    expect(system.getOpacitySum('earth')).toBeGreaterThan(0);
    system.update(cameraAtEarthDistance(5), height, fov, 750);
    expect(system.getOpacity('earth', 3)).toBe(1);

    system.update(cameraAtEarthDistance(20), height, fov, 800);
    expect(system.getTier('earth')).toBe(2);
    system.update(cameraAtEarthDistance(20), height, fov, 1_050);
    expect(system.getOpacity('earth', 2)).toBe(1);

    system.update(cameraAtEarthDistance(2_000), height, fov, 1_100);
    expect(system.getTier('earth')).toBe(1);
    system.update(cameraAtEarthDistance(2_000), height, fov, 1_225);
    expect(system.getOpacitySum('earth')).toBeCloseTo(1, 5);
    system.update(cameraAtEarthDistance(2_000), height, fov, 1_350);
    expect(system.getOpacity('earth', 1)).toBe(1);
    expect(loader.loadModel).toHaveBeenCalledTimes(1);
  });

  it('marks an absent model failed once and keeps the sphere fallback', async () => {
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async () => null),
    };
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      definitions(),
      positions(),
      loader,
      vi.fn(async () => undefined),
    );

    system.update(cameraAtEarthDistance(5), 1_000, 1, 0);
    await vi.waitFor(() => expect(system.getLoadState('earth')).toBe('failed'));
    system.update(cameraAtEarthDistance(5), 1_000, 1, 300);

    expect(system.getTier('earth')).toBe(3);
    expect(system.getOpacity('earth', 2)).toBe(1);
    expect(loader.loadModel).toHaveBeenCalledOnce();
  });
});
