import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Texture,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeAssetEntry, RuntimeAssetManifest } from './assetManifest.js';
import {
  BodyAssetLoader,
  type BodyAssetBackend,
  type BodyAssetBackendFactory,
} from './bodyAssetLoader.js';

function entry(
  id: string,
  category: RuntimeAssetEntry['category'],
  files: string[],
): RuntimeAssetEntry {
  return { id, category, triangles: 1, files };
}

function manifest(...assets: RuntimeAssetEntry[]): RuntimeAssetManifest {
  return { schemaVersion: 2, assets };
}

const renderer = {} as WebGLRenderer;

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
    await expect(first).resolves.toEqual({ root, materials: [shared, secondary] });
    expect(loadModel).toHaveBeenCalledOnce();
    expect(loadModel).toHaveBeenCalledWith('/assets/models/earth.glb');
    root.traverse((object) => expect(object.matrixAutoUpdate).toBe(false));
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
