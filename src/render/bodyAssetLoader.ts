import {
  RepeatWrapping,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';

import type {
  RuntimeAssetCategory,
  RuntimeAssetEntry,
  RuntimeAssetManifest,
} from './assetManifest.js';
import type { TextureQualityCap } from './perfGovernor.js';

export interface LoadedBodyModel {
  readonly root: Object3D;
  readonly materials: Material[];
  readonly surfaceDetail: LoadedSurfaceDetail | null;
}

export interface LoadedSurfaceDetail {
  readonly albedo: Texture;
  readonly normal: Texture;
  readonly tilesPerEquator: number;
  readonly seed: number;
}

export interface BodyAssetBackend {
  loadTexture(url: string): Promise<Texture>;
  loadModel(url: string): Promise<Object3D>;
}

export type BodyAssetBackendFactory = (
  renderer: WebGLRenderer,
  baseUrl: string,
) => Promise<BodyAssetBackend>;

export type BodyAssetErrorReporter = (message: string, error: unknown) => void;

const HERO_IDS = ['sun', 'earth', 'moon'] as const;

function isStartupHero(id: string): boolean {
  for (const heroId of HERO_IDS) if (heroId === id) return true;
  return false;
}
const NULL_TEXTURE_PROMISE: Promise<Texture | null> = Promise.resolve(null);
const NULL_MODEL_PROMISE: Promise<LoadedBodyModel | null> = Promise.resolve(null);

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function defaultErrorReporter(message: string, error: unknown): void {
  console.error(message, error);
}

function findFile(entry: RuntimeAssetEntry, expectedPath: string): string | null {
  for (const file of entry.files) {
    if (file === expectedPath) return file;
  }
  return null;
}

function collectMaterials(root: Object3D): Material[] {
  const materials: Material[] = [];
  const uniqueMaterials = new Set<Material>();

  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const candidate of material) {
        if (!uniqueMaterials.has(candidate)) {
          uniqueMaterials.add(candidate);
          materials.push(candidate);
        }
      }
    } else if (!uniqueMaterials.has(material)) {
      uniqueMaterials.add(material);
      materials.push(material);
    }
  });

  return materials;
}

function freezeStaticModel(root: Object3D): void {
  root.traverse((object) => {
    object.updateMatrix();
    object.matrixAutoUpdate = false;
  });
}

export async function createThreeAssetBackend(
  renderer: WebGLRenderer,
  baseUrl: string,
): Promise<BodyAssetBackend> {
  const [{ KTX2Loader }, { GLTFLoader }, { DRACOLoader }] = await Promise.all([
    import('three/addons/loaders/KTX2Loader.js'),
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/DRACOLoader.js'),
  ]);
  const assetBaseUrl = `${normalizeBaseUrl(baseUrl)}assets/`;
  const ktx2Loader = new KTX2Loader()
    .setTranscoderPath(`${assetBaseUrl}codecs/basis/`)
    .detectSupport(renderer);
  const dracoLoader = new DRACOLoader().setDecoderPath(`${assetBaseUrl}codecs/draco/`);
  const gltfLoader = new GLTFLoader().setKTX2Loader(ktx2Loader).setDRACOLoader(dracoLoader);

  return {
    loadTexture: (url) => ktx2Loader.loadAsync(url),
    loadModel: async (url) => (await gltfLoader.loadAsync(url)).scene,
  };
}

/** Owns lazy, failure-stable promise caches for body sphere and model tiers. */
export class BodyAssetLoader {
  private readonly entries = new Map<string, RuntimeAssetEntry>();
  private readonly spherePromises = new Map<string, Promise<Texture | null>>();
  private readonly modelPromises = new Map<string, Promise<LoadedBodyModel | null>>();
  private readonly baseUrl: string;
  private backendPromise: Promise<BodyAssetBackend> | null = null;
  private textureTierCap: TextureQualityCap = 'full';

  constructor(
    private readonly renderer: WebGLRenderer,
    manifest: RuntimeAssetManifest,
    private readonly createBackend: BodyAssetBackendFactory = createThreeAssetBackend,
    baseUrl = import.meta.env.BASE_URL,
    private readonly reportError: BodyAssetErrorReporter = defaultErrorReporter,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    for (const entry of manifest.assets) this.entries.set(entry.id, entry);
  }

  loadSphereAlbedo(id: string, category: RuntimeAssetCategory): Promise<Texture | null> {
    const cacheKey = `${category}:${id}`;
    const cached = this.spherePromises.get(cacheKey);
    if (cached !== undefined) return cached;

    const entry = this.entries.get(id);
    if (entry === undefined || entry.category !== category) {
      this.spherePromises.set(cacheKey, NULL_TEXTURE_PROMISE);
      return NULL_TEXTURE_PROMISE;
    }
    const startupFile = isStartupHero(id)
      ? findFile(entry, `textures/${id}_albedo_tier2.ktx2`)
      : null;
    const canonicalFile =
      startupFile ??
      findFile(entry, `textures/${id}_albedo.ktx2`) ??
      findFile(entry, `textures/${id}_albedo_tier2.ktx2`);
    const file = canonicalFile === null ? null : this.cappedTextureFile(entry, canonicalFile);
    if (file === null) {
      this.spherePromises.set(cacheKey, NULL_TEXTURE_PROMISE);
      return NULL_TEXTURE_PROMISE;
    }

    const url = `${this.baseUrl}assets/${file}`;
    const promise = this.getBackend()
      .then((backend) => backend.loadTexture(url))
      .catch((error: unknown) => {
        this.reportError(`Failed to load sphere texture ${url}.`, error);
        return null;
      });
    this.spherePromises.set(cacheKey, promise);
    return promise;
  }

  loadModel(id: string): Promise<LoadedBodyModel | null> {
    const cached = this.modelPromises.get(id);
    if (cached !== undefined) return cached;

    const entry = this.entries.get(id);
    if (entry === undefined) {
      this.modelPromises.set(id, NULL_MODEL_PROMISE);
      return NULL_MODEL_PROMISE;
    }
    const canonicalFile = findFile(entry, `models/${id}.glb`);
    if (canonicalFile === null) {
      this.modelPromises.set(id, NULL_MODEL_PROMISE);
      return NULL_MODEL_PROMISE;
    }
    const cappedFile =
      this.textureTierCap === 'full'
        ? null
        : findFile(entry, `models/${id}_${this.textureTierCap}.glb`);
    const file = cappedFile ?? canonicalFile;

    const url = `${this.baseUrl}assets/${file}`;
    const promise = this.getBackend()
      .then((backend) => backend.loadModel(url))
      .then(async (root): Promise<LoadedBodyModel> => {
        const surfaceDetail = await this.loadSurfaceDetail(entry, await this.getBackend());
        freezeStaticModel(root);
        return { root, materials: collectMaterials(root), surfaceDetail };
      })
      .catch((error: unknown) => {
        this.reportError(`Failed to load body model ${url}.`, error);
        return null;
      });
    this.modelPromises.set(id, promise);
    return promise;
  }

  async preloadHeroSpheres(): Promise<void> {
    const promises: Promise<Texture | null>[] = [];
    for (const id of HERO_IDS) {
      const entry = this.entries.get(id);
      if (entry !== undefined) promises.push(this.loadSphereAlbedo(id, entry.category));
    }
    await Promise.all(promises);
  }

  setTextureTierCap(cap: TextureQualityCap): void {
    if (cap !== 'full' && cap !== '2k' && cap !== '1k') {
      throw new RangeError('Unknown texture tier cap.');
    }
    this.textureTierCap = cap;
  }

  private getBackend(): Promise<BodyAssetBackend> {
    this.backendPromise ??= this.createBackend(this.renderer, this.baseUrl);
    return this.backendPromise;
  }

  private async loadSurfaceDetail(
    entry: RuntimeAssetEntry,
    backend: BodyAssetBackend,
  ): Promise<LoadedSurfaceDetail | null> {
    const detail = entry.surfaceDetail;
    if (detail === undefined) return null;
    const albedoUrl = `${this.baseUrl}assets/${this.cappedTextureFile(entry, detail.albedo)}`;
    const normalUrl = `${this.baseUrl}assets/${this.cappedTextureFile(entry, detail.normal)}`;
    const [albedoResult, normalResult] = await Promise.allSettled([
      backend.loadTexture(albedoUrl),
      backend.loadTexture(normalUrl),
    ]);
    if (albedoResult.status === 'rejected' || normalResult.status === 'rejected') {
      if (albedoResult.status === 'fulfilled') albedoResult.value.dispose();
      if (normalResult.status === 'fulfilled') normalResult.value.dispose();
      let error: unknown;
      if (albedoResult.status === 'rejected') error = albedoResult.reason;
      else if (normalResult.status === 'rejected') error = normalResult.reason;
      this.reportError(`Failed to load surface detail for body ${entry.id}.`, error);
      return null;
    }

    const anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    for (const texture of [albedoResult.value, normalResult.value]) {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.anisotropy = anisotropy;
      texture.needsUpdate = true;
    }
    return {
      albedo: albedoResult.value,
      normal: normalResult.value,
      tilesPerEquator: detail.tilesPerEquator,
      seed: detail.seed,
    };
  }

  private cappedTextureFile(entry: RuntimeAssetEntry, canonicalFile: string): string {
    if (this.textureTierCap === 'full') return canonicalFile;
    const candidate = canonicalFile.replace(/\.ktx2$/u, `_${this.textureTierCap}.ktx2`);
    return findFile(entry, candidate) ?? canonicalFile;
  }
}
