import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  Texture,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import type {
  RuntimeAssetEntry,
  RuntimeAssetManifest,
  RuntimeSurfaceDetail,
} from './assetManifest.js';
import {
  BodyAssetLoader,
  type BodyAssetBackend,
  type BodyAssetBackendFactory,
} from './bodyAssetLoader.js';

function entry(
  id: string,
  category: RuntimeAssetEntry['category'],
  files: string[],
  surfaceDetail?: RuntimeSurfaceDetail,
): RuntimeAssetEntry {
  return surfaceDetail === undefined
    ? { id, category, triangles: 1, files }
    : { id, category, triangles: 1, files, surfaceDetail };
}

function manifest(...assets: RuntimeAssetEntry[]): RuntimeAssetManifest {
  return { schemaVersion: 2, assets };
}

const renderer = {
  capabilities: { getMaxAnisotropy: () => 16 },
} as unknown as WebGLRenderer;

describe('BodyAssetLoader', () => {
  it('returns one cached promise per sphere URL', async () => {
    const texture = new Texture();
    const loadTexture = vi.fn(async () => texture);
    const factory = vi.fn(async (): Promise<BodyAssetBackend> => ({
      loadTexture,
      loadModel: vi.fn(),
    }));
    const loader = new BodyAssetLoader(
      renderer,
      manifest(entry('earth', 'planet', ['models/earth.glb', 'textures/earth_albedo_tier2.ktx2'])),
      factory,
      '/solar-voyager/',
    );

    const first = loader.loadSphereAlbedo('earth', 'planet');
    const second = loader.loadSphereAlbedo('earth', 'planet');

    expect(first).toBe(second);
    await expect(first).resolves.toBe(texture);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(loadTexture).toHaveBeenCalledOnce();
    expect(loadTexture).toHaveBeenCalledWith(
      '/solar-voyager/assets/textures/earth_albedo_tier2.ktx2',
    );
  });

  it('preloads only available Sun, Earth, and Moon sphere resources', async () => {
    const textureUrls: string[] = [];
    const modelUrls: string[] = [];
    const factory: BodyAssetBackendFactory = async () => ({
      loadTexture: async (url) => {
        textureUrls.push(url);
        return new Texture();
      },
      loadModel: async (url) => {
        modelUrls.push(url);
        return new Group();
      },
    });
    const loader = new BodyAssetLoader(
      renderer,
      manifest(
        entry('earth', 'planet', ['textures/earth_albedo_tier2.ktx2', 'models/earth.glb']),
        entry('moon', 'moon', ['textures/moon_albedo_tier2.ktx2', 'models/moon.glb']),
        entry('sun', 'sun', ['models/sun.glb']),
        entry('pluto', 'dwarf', ['textures/pluto_albedo_tier2.ktx2', 'models/pluto.glb']),
      ),
      factory,
      '/game/',
    );

    await loader.preloadHeroSpheres();

    expect(textureUrls).toEqual([
      '/game/assets/textures/earth_albedo_tier2.ktx2',
      '/game/assets/textures/moon_albedo_tier2.ktx2',
    ]);
    expect(modelUrls).toEqual([]);
  });

  it('loads and caches one model, collecting each material once', async () => {
    const shared = new MeshStandardMaterial();
    const secondary = new MeshBasicMaterial();
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), shared));
    root.add(new Mesh(new BoxGeometry(), [shared, secondary]));
    const loadModel = vi.fn(async () => root);
    const loader = new BodyAssetLoader(
      renderer,
      manifest(entry('earth', 'planet', ['models/earth.glb'])),
      async () => ({ loadTexture: vi.fn(), loadModel }),
      '/',
    );

    const first = loader.loadModel('earth');
    const second = loader.loadModel('earth');

    expect(first).toBe(second);
    await expect(first).resolves.toEqual({
      root,
      materials: [shared, secondary],
      surfaceDetail: null,
    });
    expect(loadModel).toHaveBeenCalledOnce();
    expect(loadModel).toHaveBeenCalledWith('/assets/models/earth.glb');
    root.traverse((object) => expect(object.matrixAutoUpdate).toBe(false));
  });

  it('loads and configures one cached optional surface-detail pair with the model', async () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    const albedo = new Texture();
    const normal = new Texture();
    const loadTexture = vi.fn(async (url: string) => (url.includes('albedo') ? albedo : normal));
    const loadModel = vi.fn(async () => root);
    const detail: RuntimeSurfaceDetail = {
      albedo: 'textures/earth_detail_albedo.ktx2',
      normal: 'textures/earth_detail_normal.ktx2',
      tilesPerEquator: 512,
      seed: 399,
    };
    const loader = new BodyAssetLoader(
      renderer,
      manifest(
        entry('earth', 'planet', ['models/earth.glb', detail.albedo, detail.normal], detail),
      ),
      async () => ({ loadTexture, loadModel }),
      '/game/',
    );

    const first = loader.loadModel('earth');
    const second = loader.loadModel('earth');
    expect(first).toBe(second);
    const result = await first;

    expect(result?.surfaceDetail).toEqual({ albedo, normal, tilesPerEquator: 512, seed: 399 });
    expect(loadModel).toHaveBeenCalledOnce();
    expect(loadTexture).toHaveBeenCalledTimes(2);
    expect(loadTexture).toHaveBeenNthCalledWith(
      1,
      '/game/assets/textures/earth_detail_albedo.ktx2',
    );
    expect(loadTexture).toHaveBeenNthCalledWith(
      2,
      '/game/assets/textures/earth_detail_normal.ktx2',
    );
    expect(albedo.wrapS).toBe(RepeatWrapping);
    expect(albedo.wrapT).toBe(RepeatWrapping);
    expect(normal.wrapS).toBe(RepeatWrapping);
    expect(normal.wrapT).toBe(RepeatWrapping);
    expect(albedo.anisotropy).toBe(4);
    expect(normal.anisotropy).toBe(4);
  });

  it('selects a capped texture variant only for the next uncached lazy load', async () => {
    const earthRoot = new Group();
    const moonRoot = new Group();
    const loadTexture = vi.fn(async (url: string) => {
      void url;
      return new Texture();
    });
    const detail = (id: string): RuntimeSurfaceDetail => ({
      albedo: `textures/${id}_detail_albedo.ktx2`,
      normal: `textures/${id}_detail_normal.ktx2`,
      tilesPerEquator: 32,
      seed: 1,
    });
    const earthDetail = detail('earth');
    const moonDetail = detail('moon');
    const variantFiles = (value: RuntimeSurfaceDetail) => [
      value.albedo,
      value.normal,
      value.albedo.replace('.ktx2', '_2k.ktx2'),
      value.normal.replace('.ktx2', '_2k.ktx2'),
      value.albedo.replace('.ktx2', '_1k.ktx2'),
      value.normal.replace('.ktx2', '_1k.ktx2'),
    ];
    const loader = new BodyAssetLoader(
      renderer,
      manifest(
        entry('earth', 'planet', ['models/earth.glb', ...variantFiles(earthDetail)], earthDetail),
        entry('moon', 'moon', ['models/moon.glb', ...variantFiles(moonDetail)], moonDetail),
      ),
      async () => ({
        loadTexture,
        loadModel: async (url) => (url.includes('earth') ? earthRoot : moonRoot),
      }),
      '/',
    );

    loader.setTextureTierCap('2k');
    await loader.loadModel('earth');
    loader.setTextureTierCap('1k');
    await loader.loadModel('earth');
    await loader.loadModel('moon');

    expect(loadTexture.mock.calls.map(([url]) => url)).toEqual([
      '/assets/textures/earth_detail_albedo_2k.ktx2',
      '/assets/textures/earth_detail_normal_2k.ktx2',
      '/assets/textures/moon_detail_albedo_1k.ktx2',
      '/assets/textures/moon_detail_normal_1k.ktx2',
    ]);
  });

  it('keeps a loaded model when its optional detail pair fails and never retries', async () => {
    const root = new Group();
    const loadTexture = vi.fn(async (url: string) => {
      if (url.includes('normal')) throw new Error('detail decode failed');
      return new Texture();
    });
    const loadModel = vi.fn(async () => root);
    const reportError = vi.fn();
    const detail: RuntimeSurfaceDetail = {
      albedo: 'textures/moon_detail_albedo.ktx2',
      normal: 'textures/moon_detail_normal.ktx2',
      tilesPerEquator: 256,
      seed: 301,
    };
    const loader = new BodyAssetLoader(
      renderer,
      manifest(entry('moon', 'moon', ['models/moon.glb', detail.albedo, detail.normal], detail)),
      async () => ({ loadTexture, loadModel }),
      '/',
      reportError,
    );

    await expect(loader.loadModel('moon')).resolves.toEqual({
      root,
      materials: [],
      surfaceDetail: null,
    });
    await expect(loader.loadModel('moon')).resolves.toEqual({
      root,
      materials: [],
      surfaceDetail: null,
    });
    expect(loadModel).toHaveBeenCalledOnce();
    expect(loadTexture).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]?.[0]).toContain('surface detail');
  });

  it('returns cached null without initializing loaders for absent or mismatched tiers', async () => {
    const factory = vi.fn<BodyAssetBackendFactory>();
    const loader = new BodyAssetLoader(
      renderer,
      manifest(entry('earth', 'planet', ['models/earth.glb'])),
      factory,
      '/',
    );

    const missingFirst = loader.loadSphereAlbedo('pluto', 'dwarf');
    const missingSecond = loader.loadSphereAlbedo('pluto', 'dwarf');
    const mismatch = loader.loadSphereAlbedo('earth', 'moon');

    expect(missingFirst).toBe(missingSecond);
    await expect(missingFirst).resolves.toBeNull();
    await expect(mismatch).resolves.toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('turns a rejected URL into one permanent failed result', async () => {
    const loadTexture = vi.fn(async () => {
      throw new Error('decode failed');
    });
    const reportError = vi.fn();
    const loader = new BodyAssetLoader(
      renderer,
      manifest(entry('moon', 'moon', ['textures/moon_albedo_tier2.ktx2'])),
      async () => ({ loadTexture, loadModel: vi.fn() }),
      '/',
      reportError,
    );

    const first = loader.loadSphereAlbedo('moon', 'moon');
    await expect(first).resolves.toBeNull();
    await expect(loader.loadSphereAlbedo('moon', 'moon')).resolves.toBeNull();

    expect(loadTexture).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]?.[0]).toContain('moon_albedo_tier2.ktx2');
  });
});
