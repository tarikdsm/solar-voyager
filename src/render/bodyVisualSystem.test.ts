import {
  DataTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  RGBAFormat,
  Texture,
  type Material,
  type Object3D,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { LoadedBodyModel, LoadedSurfaceDetail } from './bodyAssetLoader.js';
import type { BodyVisualAssetLoader, BodyVisualDefinition } from './bodyVisualSystem.js';
import { BodyVisualSystem, EARTH_NIGHT_EMISSIVE_INTENSITY } from './bodyVisualSystem.js';
import type { ProceduralSunMaterialPort } from './proceduralSun.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';

const AU_KM = 149_597_870.7;
const PROCEDURAL_SUN_STUB: ProceduralSunMaterialPort = {
  prepareMaterial: () => undefined,
};

function definitions(): BodyVisualDefinition[] {
  return [
    {
      id: 'sun',
      category: 'sun',
      meanRadiusKm: 10,
      muKm3S2: 1_000,
      axialTiltRad: 0,
      polarRadiusRatio: 1,
      geometricAlbedo: 1,
      albedoColor: 0xffdd88,
      proceduralSeed: 10,
    },
    {
      id: 'earth',
      category: 'planet',
      meanRadiusKm: 1,
      muKm3S2: 10,
      axialTiltRad: 0.409,
      polarRadiusRatio: 0.996,
      geometricAlbedo: 0.434,
      albedoColor: 0x4488ff,
      proceduralSeed: 399,
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
  return { root, materials: [material], surfaceDetail: null };
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
      PROCEDURAL_SUN_STUB,
    );

    const points = spaceScene.scene.children.filter((child) => child.type === 'Points');
    const spheres = spaceScene.scene.children.filter(
      (child): child is Mesh => child instanceof Mesh,
    );
    expect(points).toHaveLength(1);
    expect(spheres).toHaveLength(4);
    expect(spheres.every((sphere) => sphere.geometry === spheres[0]?.geometry)).toBe(true);
    expect(spheres.every((sphere) => sphere.material instanceof MeshLambertMaterial)).toBe(true);
    expect(spheres.map((sphere) => sphere.scale.x)).toEqual([10, 10, 1, 1]);
    expect(spheres.every((sphere) => sphere.visible)).toBe(true);
    const sunFallback = spaceScene.scene.getObjectByName('sun-sphere-fallback') as Mesh<
      never,
      MeshLambertMaterial
    >;
    const earthFallback = spaceScene.scene.getObjectByName('earth-sphere-fallback') as Mesh<
      never,
      MeshLambertMaterial
    >;
    expect(sunFallback.material.emissive.getHex()).toBe(0xffdd88);
    expect(sunFallback.material.emissiveIntensity).toBeGreaterThan(1);
    expect(earthFallback.material.emissive.getHex()).toBe(0x000000);
    expect(spaceScene.scene.children).toHaveLength(5);
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
      PROCEDURAL_SUN_STUB,
    );

    await system.initializeEager();

    expect(loader.preloadHeroSpheres).toHaveBeenCalledOnce();
    expect(loadSphereAlbedo).toHaveBeenCalledTimes(2);
    expect(loader.loadModel).not.toHaveBeenCalled();
  });

  it('raises an authored Sun model above the HDR bloom threshold', async () => {
    const sunMaterial = new MeshStandardMaterial({
      emissive: 0xffaa55,
      emissiveIntensity: 0.5,
    });
    const sunModel = loadedModel(sunMaterial);
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async (id: string) => (id === 'sun' ? sunModel : null)),
    };
    const prepareMaterial = vi.fn();
    const compileModel = vi.fn(async () => {
      expect(prepareMaterial).toHaveBeenCalledTimes(3);
    });
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      definitions(),
      positions(),
      loader,
      compileModel,
      { prepareMaterial },
    );

    expect(prepareMaterial).toHaveBeenCalledTimes(2);
    system.update({ x: 11, y: 0, z: 0 }, 1_000, 1, 0);

    await vi.waitFor(() => expect(system.getLoadState('sun')).toBe('ready'));
    expect(compileModel).toHaveBeenCalledOnce();
    expect(sunMaterial.emissiveIntensity).toBeGreaterThan(1);
    expect(sunMaterial.emissive.getHex()).toBe(0xffaa55);
  });

  it('exposes authored Earth night lights at the ACES gameplay exposure', async () => {
    const earthMaterial = new MeshStandardMaterial({
      emissive: 0xffffff,
      emissiveIntensity: 1,
      emissiveMap: new Texture(),
    });
    const cloudsMaterial = new MeshStandardMaterial({
      map: new Texture(),
      transparent: true,
    });
    cloudsMaterial.name = 'mat_clouds';
    const earthRoot = new Group();
    earthRoot.add(new Mesh(undefined, earthMaterial), new Mesh(undefined, cloudsMaterial));
    const earthModel: LoadedBodyModel = {
      root: earthRoot,
      materials: [earthMaterial, cloudsMaterial],
      surfaceDetail: null,
    };
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async (id: string) => (id === 'earth' ? earthModel : null)),
    };
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      definitions(),
      positions(),
      loader,
      vi.fn(async () => undefined),
      PROCEDURAL_SUN_STUB,
    );

    system.update(cameraAtEarthDistance(5), 1_000, 1, 0);

    await vi.waitFor(() => expect(system.getLoadState('earth')).toBe('ready'));
    expect(earthMaterial.emissiveIntensity).toBe(EARTH_NIGHT_EMISSIVE_INTENSITY);
    expect(cloudsMaterial.alphaMap).toBe(cloudsMaterial.map);
    expect(cloudsMaterial.depthWrite).toBe(false);
  });

  it('prepares only the Earth surface detail and atmosphere before model compilation', async () => {
    const surfaceMaterial = new MeshStandardMaterial({ map: new Texture() });
    surfaceMaterial.name = 'mat_surface';
    const cloudsMaterial = new MeshStandardMaterial({ map: new Texture() });
    cloudsMaterial.name = 'mat_clouds';
    const earthRoot = new Group();
    earthRoot.add(new Mesh(undefined, surfaceMaterial), new Mesh(undefined, cloudsMaterial));
    const surfaceDetail: LoadedSurfaceDetail = {
      albedo: new Texture(),
      normal: new Texture(),
      tilesPerEquator: 512,
      seed: 399,
    };
    const earthModel: LoadedBodyModel = {
      root: earthRoot,
      materials: [surfaceMaterial, cloudsMaterial],
      surfaceDetail,
    };
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async (id: string) => (id === 'earth' ? earthModel : null)),
    };
    const compileModel = vi.fn(async (root: Object3D) => {
      expect(root.getObjectByName('earth-atmosphere-rim')).toBeDefined();
      expect(surfaceMaterial.customProgramCacheKey()).toContain('solar-voyager-surface-detail-v1');
      expect(cloudsMaterial.customProgramCacheKey()).not.toContain(
        'solar-voyager-surface-detail-v1',
      );
    });
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      definitions(),
      positions(),
      loader,
      compileModel,
      PROCEDURAL_SUN_STUB,
    );

    system.update(cameraAtEarthDistance(5), 1_000, 1, 0);
    await vi.waitFor(() => expect(system.getLoadState('earth')).toBe('ready'));
    expect(compileModel).toHaveBeenCalledOnce();

    system.update(cameraAtEarthDistance(6), 1_000, 1, 100);
    expect(system.getSurfaceDetailBlend('earth')).toBe(0);
    system.update(cameraAtEarthDistance(3), 1_000, 1, 200);
    expect(system.getSurfaceDetailBlend('earth')).toBeGreaterThan(0);
    expect(system.getSurfaceDetailBlend('earth')).toBeLessThan(1);
    system.update(cameraAtEarthDistance(1.2), 1_000, 1, 300);
    expect(system.getSurfaceDetailBlend('earth')).toBe(1);
    system.setSurfaceDetailEnabled('earth', false);
    expect(system.getSurfaceDetailBlend('earth')).toBe(0);
  });

  it('prepares a ringed giant before compilation and forwards simulation and quality state', async () => {
    const tilt = 0.4665265090580843;
    const saturnX = 10 * AU_KM;
    const ringRadiusKm = (66_900 + 140_612) / 2;
    const ringCamera = {
      x: saturnX + Math.cos(tilt) * ringRadiusKm,
      y: Math.sin(tilt) * ringRadiusKm,
      z: 0,
    };
    const ringDefinitions: BodyVisualDefinition[] = [
      definitions()[0] as BodyVisualDefinition,
      {
        id: 'saturn',
        category: 'planet',
        axialTiltRad: tilt,
        meanRadiusKm: 58_232,
        muKm3S2: 37_931_207.8,
        polarRadiusRatio: 0.9020375655405853,
        geometricAlbedo: 0.499,
        albedoColor: 0xd8c49a,
        proceduralSeed: 699,
      },
    ];
    const surface = new MeshStandardMaterial({ map: new Texture() });
    surface.name = 'mat_surface';
    const rings = new MeshStandardMaterial();
    rings.name = 'mat_rings';
    rings.map = new DataTexture(new Uint8Array([255, 220, 180, 200]), 1, 1, RGBAFormat);
    const root = new Group();
    root.add(new Mesh(undefined, surface), new Mesh(undefined, rings));
    const surfaceDetail: LoadedSurfaceDetail = {
      albedo: new Texture(),
      normal: new Texture(),
      tilesPerEquator: 512,
      seed: 699,
    };
    const model: LoadedBodyModel = { root, materials: [surface, rings], surfaceDetail };
    const compileModel = vi.fn(async () => {
      expect(root.rotation.z).toBeCloseTo(tilt);
      expect(root.getObjectByName('saturn_ring_particles')).toBeDefined();
      const cacheKey = surface.customProgramCacheKey();
      expect(cacheKey).toContain('solar-voyager-gas-giant-v1');
      expect(cacheKey).toContain('solar-voyager-surface-detail-v1');
      expect(cacheKey.indexOf('solar-voyager-gas-giant-v1')).toBeLessThan(
        cacheKey.indexOf('solar-voyager-surface-detail-v1'),
      );
    });
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async (id: string) => (id === 'saturn' ? model : null)),
    };
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      ringDefinitions,
      new Float64Array([0, 0, 0, saturnX, 0, 0]),
      loader,
      compileModel,
      PROCEDURAL_SUN_STUB,
    );

    system.update(ringCamera, 1_000, 1, 0, 123_456);
    await vi.waitFor(() => expect(system.getLoadState('saturn')).toBe('ready'));
    expect(root.scale.x).toBe(60_268);
    expect(system.getGasGiantOctaves('saturn')).toBe(4);

    system.setRingParticleCount(1024);
    system.update(ringCamera, 1_000, 1, 300, 123_457);
    expect(system.getGasGiantBandPhase('saturn', 0)).toBeGreaterThan(0);
    system.setProceduralQuality('minimum');
    expect(system.getGasGiantOctaves('saturn')).toBe(1);
    system.setGasGiantAnimationEnabled('saturn', false);
    expect(system.getRingBlend('saturn')).toBe(1);
    expect((root.getObjectByName('saturn_ring_particles') as Mesh).count).toBe(1024);
    expect(compileModel).toHaveBeenCalledOnce();
  });

  it('unwinds every chained giant hook and controller when model compilation fails', async () => {
    const sun = definitions()[0];
    if (sun === undefined) throw new Error('Sun fixture is missing.');
    const saturn: BodyVisualDefinition = {
      id: 'saturn',
      category: 'planet',
      axialTiltRad: 0.4665,
      meanRadiusKm: 58_232,
      muKm3S2: 37_931_207.8,
      polarRadiusRatio: 0.902,
      geometricAlbedo: 0.499,
      albedoColor: 0xd8c49a,
      proceduralSeed: 699,
    };
    const surface = new MeshStandardMaterial({ map: new Texture() });
    surface.name = 'mat_surface';
    const rings = new MeshStandardMaterial();
    rings.name = 'mat_rings';
    rings.map = new DataTexture(new Uint8Array([255, 220, 180, 200]), 1, 1, RGBAFormat);
    const previousSurfaceCompile = vi.fn();
    const previousRingCompile = vi.fn();
    const previousSurfaceKey = vi.fn(() => 'surface-authored');
    const previousRingKey = vi.fn(() => 'ring-authored');
    surface.onBeforeCompile = previousSurfaceCompile;
    rings.onBeforeCompile = previousRingCompile;
    surface.customProgramCacheKey = previousSurfaceKey;
    rings.customProgramCacheKey = previousRingKey;
    const root = new Group();
    root.add(new Mesh(undefined, surface), new Mesh(undefined, rings));
    const albedo = new Texture();
    const normal = new Texture();
    const albedoDispose = vi.spyOn(albedo, 'dispose');
    const normalDispose = vi.spyOn(normal, 'dispose');
    const model: LoadedBodyModel = {
      root,
      materials: [surface, rings],
      surfaceDetail: { albedo, normal, tilesPerEquator: 512, seed: 699 },
    };
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(async (id: string) => (id === 'saturn' ? model : null)),
    };
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      [sun, saturn],
      new Float64Array([0, 0, 0, 10 * AU_KM, 0, 0]),
      loader,
      vi.fn(async () => Promise.reject(new Error('compile failed'))),
      PROCEDURAL_SUN_STUB,
    );

    system.update({ x: 10 * AU_KM + 1, y: 0, z: 0 }, 1_000, 1, 0, 123_456);
    await vi.waitFor(() => expect(system.getLoadState('saturn')).toBe('failed'));

    expect(surface.onBeforeCompile).toBe(previousSurfaceCompile);
    expect(rings.onBeforeCompile).toBe(previousRingCompile);
    expect(surface.customProgramCacheKey).toBe(previousSurfaceKey);
    expect(rings.customProgramCacheKey).toBe(previousRingKey);
    expect(system.getGasGiantOctaves('saturn')).toBeNull();
    expect(system.getSurfaceDetailBlend('saturn')).toBe(0);
    expect(system.getRingBlend('saturn')).toBe(0);
    expect(albedoDispose).toHaveBeenCalledOnce();
    expect(normalDispose).toHaveBeenCalledOnce();
    expect(root.visible).toBe(false);
  });
});

describe('BodyVisualSystem transitions', () => {
  it('snaps the setup view to its loaded fallback before the first rendered frame', () => {
    const loader: BodyVisualAssetLoader = {
      preloadHeroSpheres: vi.fn(async () => undefined),
      loadSphereAlbedo: vi.fn(async () => null),
      loadModel: vi.fn(() => new Promise<LoadedBodyModel | null>(() => undefined)),
    };
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      definitions(),
      positions(),
      loader,
      vi.fn(async () => undefined),
      PROCEDURAL_SUN_STUB,
    );

    system.initializeView(cameraAtEarthDistance(5), 1_000, 1);

    expect(system.getTier('earth')).toBe(3);
    expect(system.getLoadState('earth')).toBe('loading');
    expect(system.getOpacity('earth', 1)).toBe(0);
    expect(system.getOpacity('earth', 2)).toBe(1);
    expect(system.getOpacity('earth', 3)).toBe(0);
    expect(loader.loadModel).toHaveBeenCalledOnce();
  });

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
          axialTiltRad: 0,
          meanRadiusKm: 1,
          muKm3S2: 1,
          polarRadiusRatio: 1,
          geometricAlbedo: 0.52,
          albedoColor: 0xccaa88,
          proceduralSeed: 999,
        },
      ],
      positions(),
      loader,
      vi.fn(async () => undefined),
      PROCEDURAL_SUN_STUB,
    );

    system.update(cameraAtEarthDistance(2_000), 1_000, 1, 0);
    expect(loadSphereAlbedo).not.toHaveBeenCalled();

    system.update(cameraAtEarthDistance(100), 1_000, 1, 100);
    system.update(cameraAtEarthDistance(100), 1_000, 1, 200);
    await vi.waitFor(() => expect(loadSphereAlbedo).toHaveBeenCalledOnce());
    expect(loadSphereAlbedo).toHaveBeenCalledWith('pluto', 'dwarf');
  });

  it('preserves apparent-magnitude flux below the former visibility floor', () => {
    const system = new BodyVisualSystem(
      new CameraRelativeSpaceScene(),
      definitions(),
      positions(),
      {
        preloadHeroSpheres: vi.fn(async () => undefined),
        loadSphereAlbedo: vi.fn(async () => null),
        loadModel: vi.fn(async () => null),
      },
      vi.fn(async () => undefined),
      PROCEDURAL_SUN_STUB,
    );

    system.update(cameraAtEarthDistance(2_000), 1_000, 1, 0);

    const intensity = system.pointCloud.points.geometry.getAttribute('aIntensity').getX(1);
    expect(intensity).toBeGreaterThanOrEqual(0);
    expect(intensity).toBeLessThan(0.001);
  });

  it('crossfades a lazy sphere texture from an untinted fallback', async () => {
    let resolveTexture!: (texture: Texture) => void;
    const texturePromise = new Promise<Texture>((resolve) => {
      resolveTexture = resolve;
    });
    const spaceScene = new CameraRelativeSpaceScene();
    const system = new BodyVisualSystem(
      spaceScene,
      definitions(),
      positions(),
      {
        preloadHeroSpheres: vi.fn(async () => undefined),
        loadSphereAlbedo: vi.fn(() => texturePromise),
        loadModel: vi.fn(async () => null),
      },
      vi.fn(async () => undefined),
      PROCEDURAL_SUN_STUB,
    );
    const fallback = spaceScene.scene.getObjectByName('earth-sphere-fallback') as Mesh;
    const textured = spaceScene.scene.getObjectByName('earth-sphere-textured') as Mesh;

    system.update(cameraAtEarthDistance(100), 1_000, 1, 0);
    system.update(cameraAtEarthDistance(100), 1_000, 1, 250);
    expect((fallback.material as MeshBasicMaterial).opacity).toBe(1);
    expect((textured.material as MeshBasicMaterial).opacity).toBe(0);

    const texture = new Texture();
    resolveTexture(texture);
    await vi.waitFor(() => expect((textured.material as MeshBasicMaterial).map).toBe(texture));
    expect((fallback.material as MeshBasicMaterial).opacity).toBe(1);
    expect((textured.material as MeshBasicMaterial).opacity).toBe(0);

    system.update(cameraAtEarthDistance(100), 1_000, 1, 300);
    system.update(cameraAtEarthDistance(100), 1_000, 1, 425);
    expect((fallback.material as MeshBasicMaterial).opacity).toBeCloseTo(0.5, 5);
    expect((textured.material as MeshBasicMaterial).opacity).toBeCloseTo(0.5, 5);
    expect((textured.material as MeshBasicMaterial).color.getHex()).toBe(0xffffff);

    system.update(cameraAtEarthDistance(100), 1_000, 1, 550);
    expect((fallback.material as MeshBasicMaterial).opacity).toBe(0);
    expect((textured.material as MeshBasicMaterial).opacity).toBe(1);
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
      PROCEDURAL_SUN_STUB,
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
    expect(model.materials[0]?.transparent).toBe(true);
    expect(model.materials[0]?.depthWrite).toBe(false);
    system.update(cameraAtEarthDistance(5), height, fov, 750);
    expect(system.getOpacity('earth', 3)).toBe(1);
    expect(model.materials[0]?.transparent).toBe(false);
    expect(model.materials[0]?.depthWrite).toBe(true);

    system.update(cameraAtEarthDistance(20), height, fov, 800);
    expect(system.getTier('earth')).toBe(2);
    system.update(cameraAtEarthDistance(20), height, fov, 1_050);
    expect(system.getOpacity('earth', 2)).toBe(1);

    system.update(cameraAtEarthDistance(2_000), height, fov, 1_100);
    expect(system.getTier('earth')).toBe(1);
    expect(system.getOpacity('earth', 1)).toBeGreaterThan(0);
    expect(system.getOpacitySum('earth')).toBeCloseTo(1, 5);
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
      PROCEDURAL_SUN_STUB,
    );

    system.update(cameraAtEarthDistance(5), 1_000, 1, 0);
    await vi.waitFor(() => expect(system.getLoadState('earth')).toBe('failed'));
    system.update(cameraAtEarthDistance(5), 1_000, 1, 300);

    expect(system.getTier('earth')).toBe(3);
    expect(system.getOpacity('earth', 2)).toBe(1);
    expect(loader.loadModel).toHaveBeenCalledOnce();
  });
});
