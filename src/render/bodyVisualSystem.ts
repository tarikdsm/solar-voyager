import {
  DataTexture,
  IcosahedronGeometry,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  RGBAFormat,
  type Material,
  type Object3D,
  type Texture,
} from 'three';

import type { ReadonlyVec3 } from '../core/vec3.js';
import type { LoadedBodyModel } from './bodyAssetLoader.js';
import type { RuntimeAssetCategory } from './assetManifest.js';
import { BodyPointCloud } from './bodyPointCloud.js';
import {
  prepareEarthSurfaceLayers,
  type PreparedEarthSurfaceLayers,
} from './earthSurfaceLayers.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';
import { prepareGasGiantAnimation, type GasGiantAnimation } from './gasGiantAnimation.js';
import type { ProceduralSunMaterialPort } from './proceduralSun.js';
import type { ProceduralQuality } from './proceduralSunState.js';
import type { TextureQualityCap } from './perfGovernor.js';
import { ringDefinitionFor } from './ringCatalog.js';
import { prepareRingSystem, type PreparedRingSystem } from './ringSystem.js';
import { prepareSurfaceDetail, type PreparedSurfaceDetail } from './surfaceDetail.js';
import {
  apparentMagnitude,
  projectedDiameterPx,
  selectVisualTier,
  type VisualTier,
} from './visualTier.js';

export interface BodyVisualDefinition {
  readonly id: string;
  readonly category: RuntimeAssetCategory;
  readonly axialTiltRad: number;
  readonly meanRadiusKm: number;
  readonly muKm3S2: number;
  readonly polarRadiusRatio: number;
  readonly geometricAlbedo: number;
  readonly albedoColor: number;
  readonly proceduralSeed: number;
}

export interface BodyVisualAssetLoader {
  preloadHeroSpheres(): Promise<void>;
  loadSphereAlbedo(id: string, category: RuntimeAssetCategory): Promise<Texture | null>;
  loadModel(id: string): Promise<LoadedBodyModel | null>;
  setTextureTierCap?(cap: TextureQualityCap): void;
}

export type BodyModelCompiler = (root: Object3D) => Promise<void>;
export type BodyModelLoadState = 'idle' | 'loading' | 'ready' | 'failed';

const FADE_DURATION_MS = 250;
const INITIAL_POINT_FADE_OPACITY = 1 / 15;
const LOAD_IDLE = 0;
const LOAD_LOADING = 1;
const LOAD_READY = 2;
const LOAD_FAILED = 3;
const HERO_IDS = new Set(['sun', 'earth', 'moon']);
export const SUN_EMISSIVE_INTENSITY = 4;
export const EARTH_NIGHT_EMISSIVE_INTENSITY = 4;

function loadStateName(state: number): BodyModelLoadState {
  switch (state) {
    case LOAD_IDLE:
      return 'idle';
    case LOAD_LOADING:
      return 'loading';
    case LOAD_READY:
      return 'ready';
    case LOAD_FAILED:
      return 'failed';
    default:
      throw new Error('Unknown body model load state.');
  }
}

/** Owns setup-time body visuals and an allocation-free normal frame update. */
export class BodyVisualSystem {
  readonly pointCloud: BodyPointCloud;

  private readonly idToIndex = new Map<string, number>();
  private readonly sphereFallbackMeshes: Mesh<IcosahedronGeometry, MeshLambertMaterial>[] = [];
  private readonly sphereTexturedMeshes: Mesh<IcosahedronGeometry, MeshLambertMaterial>[] = [];
  private readonly sphereFallbackMaterials: MeshLambertMaterial[] = [];
  private readonly sphereTexturedMaterials: MeshLambertMaterial[] = [];
  private readonly sphereLoadStates: Uint8Array;
  private readonly sphereTextureMixes: Float32Array;
  private readonly sphereTextureFadeActive: Uint8Array;
  private readonly sphereTextureFadePending: Uint8Array;
  private readonly sphereTextureFadeStartMs: Float64Array;
  private readonly modelLoadStates: Uint8Array;
  private readonly modelRoots: Array<Object3D | null>;
  private readonly modelMaterials: Array<Material[] | null>;
  private readonly modelBaseOpacities: Array<Float32Array | null>;
  private readonly modelBaseDepthWrites: Array<Uint8Array | null>;
  private readonly modelBaseTransparencies: Array<Uint8Array | null>;
  private readonly modelBaseForceSinglePasses: Array<Uint8Array | null>;
  private readonly surfaceDetails: Array<PreparedSurfaceDetail | null>;
  private readonly gasGiantAnimations: Array<GasGiantAnimation | null>;
  private readonly earthSurfaceLayers: Array<PreparedEarthSurfaceLayers | null>;
  private readonly ringSystems: Array<PreparedRingSystem | null>;
  private readonly selectedTiers: Uint8Array;
  private readonly displayTargetTiers: Uint8Array;
  private readonly fadeActive: Uint8Array;
  private readonly fadeStartMs: Float64Array;
  private readonly pointOpacities: Float32Array;
  private readonly sphereOpacities: Float32Array;
  private readonly modelOpacities: Float32Array;
  private readonly fadePointStarts: Float32Array;
  private readonly fadeSphereStarts: Float32Array;
  private readonly fadeModelStarts: Float32Array;
  private readonly sunIndex: number;
  private modelThresholdScale = 1;
  private ringParticleCount = 4096;
  private proceduralQuality: ProceduralQuality = 'full';

  constructor(
    private readonly spaceScene: CameraRelativeSpaceScene,
    private readonly definitions: readonly BodyVisualDefinition[],
    private readonly positionsKm: Float64Array,
    private readonly assetLoader: BodyVisualAssetLoader,
    private readonly compileModel: BodyModelCompiler,
    private readonly proceduralSun: ProceduralSunMaterialPort,
    private lazyLoadingEnabled = true,
  ) {
    if (definitions.length === 0 || positionsKm.length !== definitions.length * 3) {
      throw new RangeError('Body definitions and packed positions must have matching counts.');
    }

    const count = definitions.length;
    const colors = new Uint32Array(count);
    let foundSunIndex = -1;
    for (let index = 0; index < count; index += 1) {
      const definition = definitions[index];
      if (definition === undefined) throw new Error('Body definition array is sparse.');
      if (this.idToIndex.has(definition.id)) {
        throw new Error(`Duplicate body visual id "${definition.id}".`);
      }
      if (!Number.isFinite(definition.meanRadiusKm) || definition.meanRadiusKm <= 0) {
        throw new RangeError(`Body "${definition.id}" must have a positive finite radius.`);
      }
      if (!Number.isFinite(definition.muKm3S2) || definition.muKm3S2 <= 0) {
        throw new RangeError(
          `Body "${definition.id}" must have a positive finite gravitational parameter.`,
        );
      }
      if (!Number.isFinite(definition.axialTiltRad) || definition.axialTiltRad < 0) {
        throw new RangeError(`Body "${definition.id}" must have a finite nonnegative axial tilt.`);
      }
      if (
        !Number.isFinite(definition.polarRadiusRatio) ||
        definition.polarRadiusRatio <= 0 ||
        definition.polarRadiusRatio > 1
      ) {
        throw new RangeError(`Body "${definition.id}" must have a physical polar-radius ratio.`);
      }
      if (!Number.isFinite(definition.geometricAlbedo) || definition.geometricAlbedo < 0) {
        throw new RangeError(`Body "${definition.id}" must have a finite nonnegative albedo.`);
      }
      if (
        !Number.isInteger(definition.proceduralSeed) ||
        definition.proceduralSeed < 0 ||
        definition.proceduralSeed > 0xffff_ffff
      ) {
        throw new RangeError(`Body "${definition.id}" must have a uint32 procedural seed.`);
      }
      this.idToIndex.set(definition.id, index);
      colors[index] = definition.albedoColor;
      if (definition.id === 'sun') foundSunIndex = index;
    }
    if (foundSunIndex < 0) throw new Error('Body visuals require a catalogued Sun.');
    this.sunIndex = foundSunIndex;

    this.sphereLoadStates = new Uint8Array(count);
    this.sphereTextureMixes = new Float32Array(count);
    this.sphereTextureFadeActive = new Uint8Array(count);
    this.sphereTextureFadePending = new Uint8Array(count);
    this.sphereTextureFadeStartMs = new Float64Array(count);
    this.modelLoadStates = new Uint8Array(count);
    this.modelRoots = new Array<Object3D | null>(count).fill(null);
    this.modelMaterials = new Array<Material[] | null>(count).fill(null);
    this.modelBaseOpacities = new Array<Float32Array | null>(count).fill(null);
    this.modelBaseDepthWrites = new Array<Uint8Array | null>(count).fill(null);
    this.modelBaseTransparencies = new Array<Uint8Array | null>(count).fill(null);
    this.modelBaseForceSinglePasses = new Array<Uint8Array | null>(count).fill(null);
    this.surfaceDetails = new Array<PreparedSurfaceDetail | null>(count).fill(null);
    this.gasGiantAnimations = new Array<GasGiantAnimation | null>(count).fill(null);
    this.earthSurfaceLayers = new Array<PreparedEarthSurfaceLayers | null>(count).fill(null);
    this.ringSystems = new Array<PreparedRingSystem | null>(count).fill(null);
    this.selectedTiers = new Uint8Array(count);
    this.selectedTiers.fill(1);
    this.displayTargetTiers = new Uint8Array(count);
    this.displayTargetTiers.fill(1);
    this.fadeActive = new Uint8Array(count);
    this.fadeStartMs = new Float64Array(count);
    this.pointOpacities = new Float32Array(count);
    this.pointOpacities.fill(1);
    this.sphereOpacities = new Float32Array(count);
    this.modelOpacities = new Float32Array(count);
    this.fadePointStarts = new Float32Array(count);
    this.fadeSphereStarts = new Float32Array(count);
    this.fadeModelStarts = new Float32Array(count);

    this.pointCloud = new BodyPointCloud(colors);
    this.spaceScene.bindPackedPointPositions(this.pointCloud.points, positionsKm);

    const sphereGeometry = new IcosahedronGeometry(1, 2);
    const whiteTexture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
    whiteTexture.needsUpdate = true;
    for (let index = 0; index < count; index += 1) {
      const definition = definitions[index];
      if (definition === undefined) throw new Error('Body definition array is sparse.');
      const isSun = definition.category === 'sun';
      const fallbackMaterial = new MeshLambertMaterial({
        color: definition.albedoColor,
        emissive: isSun ? definition.albedoColor : 0x000000,
        emissiveIntensity: isSun ? SUN_EMISSIVE_INTENSITY : 1,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const texturedMaterial = new MeshLambertMaterial({
        color: 0xffffff,
        emissive: isSun ? 0xffffff : 0x000000,
        emissiveIntensity: isSun ? SUN_EMISSIVE_INTENSITY : 1,
        map: whiteTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      if (isSun) {
        this.proceduralSun.prepareMaterial(fallbackMaterial);
        this.proceduralSun.prepareMaterial(texturedMaterial);
      }
      const fallbackSphere = new Mesh(sphereGeometry, fallbackMaterial);
      const texturedSphere = new Mesh(sphereGeometry, texturedMaterial);
      fallbackSphere.name = `${definition.id}-sphere-fallback`;
      texturedSphere.name = `${definition.id}-sphere-textured`;
      fallbackSphere.scale.setScalar(definition.meanRadiusKm);
      texturedSphere.scale.setScalar(definition.meanRadiusKm);
      fallbackSphere.visible = true;
      texturedSphere.visible = true;
      this.sphereFallbackMaterials.push(fallbackMaterial);
      this.sphereTexturedMaterials.push(texturedMaterial);
      this.sphereFallbackMeshes.push(fallbackSphere);
      this.sphereTexturedMeshes.push(texturedSphere);
      this.spaceScene.bindPackedVisual(fallbackSphere, positionsKm, index * 3);
      this.spaceScene.bindPackedVisual(texturedSphere, positionsKm, index * 3);
    }
  }

  async initializeEager(): Promise<void> {
    await this.assetLoader.preloadHeroSpheres();
    for (let index = 0; index < this.definitions.length; index += 1) {
      const definition = this.definitions[index];
      if (definition !== undefined && HERO_IDS.has(definition.id)) {
        await this.loadSphereNow(index);
      }
    }
  }

  /** Selects and displays the best loaded tier before the first rendered frame. */
  initializeView(
    cameraPositionKm: ReadonlyVec3,
    viewportHeightPx: number,
    verticalFovRad: number,
  ): void {
    this.update(cameraPositionKm, viewportHeightPx, verticalFovRad, 0);
    for (let index = 0; index < this.definitions.length; index += 1) {
      const targetTier = this.displayTargetTiers[index];
      this.pointOpacities[index] = targetTier === 1 ? 1 : 0;
      this.sphereOpacities[index] = targetTier === 2 ? 1 : 0;
      this.modelOpacities[index] = targetTier === 3 ? 1 : 0;
      this.fadeActive[index] = 0;
      if (this.sphereLoadStates[index] === LOAD_READY) {
        this.sphereTextureMixes[index] = 1;
        this.sphereTextureFadeActive[index] = 0;
        this.sphereTextureFadePending[index] = 0;
      }
    }
    this.update(cameraPositionKm, viewportHeightPx, verticalFovRad, 0);
  }

  update(
    cameraPositionKm: ReadonlyVec3,
    viewportHeightPx: number,
    verticalFovRad: number,
    nowMs: number,
    simTimeSec = 0,
  ): void {
    if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite.');
    if (!Number.isFinite(simTimeSec)) throw new RangeError('simTimeSec must be finite.');

    const sunOffset = this.sunIndex * 3;
    const sunX = this.positionsKm[sunOffset] ?? Number.NaN;
    const sunY = this.positionsKm[sunOffset + 1] ?? Number.NaN;
    const sunZ = this.positionsKm[sunOffset + 2] ?? Number.NaN;

    for (let index = 0; index < this.definitions.length; index += 1) {
      this.advanceFade(index, nowMs);
      this.advanceSphereTextureFade(index, nowMs);
      const definition = this.definitions[index];
      const offset = index * 3;
      const x = this.positionsKm[offset] ?? Number.NaN;
      const y = this.positionsKm[offset + 1] ?? Number.NaN;
      const z = this.positionsKm[offset + 2] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new RangeError('Packed body positions must remain finite.');
      }
      if (definition === undefined) throw new Error('Body definition array is sparse.');

      const deltaX = x - cameraPositionKm.x;
      const deltaY = y - cameraPositionKm.y;
      const deltaZ = z - cameraPositionKm.z;
      const distanceKm = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
      const surfaceDetail = this.surfaceDetails[index];
      if (surfaceDetail !== null && surfaceDetail !== undefined) {
        surfaceDetail.setDistance(distanceKm, definition.meanRadiusKm);
      }
      const gasGiantAnimation = this.gasGiantAnimations[index];
      if (gasGiantAnimation !== null && gasGiantAnimation !== undefined) {
        gasGiantAnimation.update(simTimeSec);
      }
      const earthLayers = this.earthSurfaceLayers[index];
      if (earthLayers !== null && earthLayers !== undefined) earthLayers.update(nowMs);
      const ringSystem = this.ringSystems[index];
      if (ringSystem !== null && ringSystem !== undefined) {
        ringSystem.update(
          cameraPositionKm.x - x,
          cameraPositionKm.y - y,
          cameraPositionKm.z - z,
          sunX - x,
          sunY - y,
          sunZ - z,
          simTimeSec,
        );
      }
      const diameterPx = projectedDiameterPx(
        definition.meanRadiusKm,
        distanceKm,
        viewportHeightPx,
        verticalFovRad,
      );
      const selectedTier = selectVisualTier(
        this.selectedTiers[index] as VisualTier,
        diameterPx,
        this.modelThresholdScale,
      );
      this.selectedTiers[index] = selectedTier;

      if (
        this.lazyLoadingEnabled &&
        selectedTier >= 2 &&
        this.sphereLoadStates[index] === LOAD_IDLE
      ) {
        this.beginSphereLoad(index);
      }
      if (
        this.lazyLoadingEnabled &&
        selectedTier === 3 &&
        this.modelLoadStates[index] === LOAD_IDLE
      ) {
        this.beginModelLoad(index);
      }

      const effectiveTier =
        selectedTier === 1
          ? 1
          : selectedTier === 3 && this.modelLoadStates[index] === LOAD_READY
            ? 3
            : 2;
      if (this.displayTargetTiers[index] !== effectiveTier) {
        this.beginFade(index, effectiveTier, nowMs);
      }

      const magnitude = apparentMagnitude(
        index,
        this.sunIndex,
        definition.meanRadiusKm,
        definition.geometricAlbedo,
        this.positionsKm,
        cameraPositionKm,
      );
      const intensity = Math.min(8, Math.pow(10, -0.4 * (magnitude - 6)));
      this.pointCloud.writeAppearance(
        index,
        diameterPx,
        this.pointOpacities[index] ?? 0,
        intensity,
      );
      this.applyNearOpacity(index);
    }
    this.pointCloud.commitAppearance();
  }

  getTier(id: string): VisualTier {
    return this.selectedTiers[this.indexForId(id)] as VisualTier;
  }

  setModelThresholdScale(scale: number): void {
    if (!Number.isFinite(scale) || scale < 1) {
      throw new RangeError('Model threshold scale must be finite and at least one.');
    }
    this.modelThresholdScale = scale;
  }

  enableLazyLoading(): void {
    this.lazyLoadingEnabled = true;
  }

  setRingParticleCount(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > 4096) {
      throw new RangeError('Ring particle count must be an integer from 0 to 4096.');
    }
    if (count === this.ringParticleCount) return;
    this.ringParticleCount = count;
    for (const ringSystem of this.ringSystems) ringSystem?.setParticleCount(count);
  }

  setProceduralQuality(quality: ProceduralQuality): void {
    if (quality !== 'full' && quality !== 'half' && quality !== 'minimum') {
      throw new RangeError('Unknown body procedural quality.');
    }
    this.proceduralQuality = quality;
    for (let index = 0; index < this.gasGiantAnimations.length; index += 1) {
      this.gasGiantAnimations[index]?.setQuality(quality);
    }
  }

  getGasGiantOctaves(id: string): number | null {
    return this.gasGiantAnimations[this.indexForId(id)]?.state.uniforms.uGasOctaves.value ?? null;
  }

  getGasGiantBandPhase(id: string, zone: number): number | null {
    if (!Number.isInteger(zone) || zone < 0 || zone > 3) {
      throw new RangeError('Gas-giant band zone must be an integer from zero to three.');
    }
    const animation = this.gasGiantAnimations[this.indexForId(id)];
    return animation?.state.uniforms.uGasBandPhases.value.getComponent(zone) ?? null;
  }

  setGasGiantAnimationEnabled(id: string, enabled: boolean): void {
    this.gasGiantAnimations[this.indexForId(id)]?.setEnabled(enabled);
  }

  getRingBlend(id: string): number {
    return this.ringSystems[this.indexForId(id)]?.blend ?? 0;
  }

  setTextureTierCap(cap: TextureQualityCap): void {
    this.assetLoader.setTextureTierCap?.(cap);
  }

  getLoadState(id: string): BodyModelLoadState {
    return loadStateName(this.modelLoadStates[this.indexForId(id)] ?? -1);
  }

  getOpacity(id: string, tier: VisualTier): number {
    const index = this.indexForId(id);
    if (tier === 1) return this.pointOpacities[index] ?? 0;
    if (tier === 2) return this.sphereOpacities[index] ?? 0;
    return this.modelOpacities[index] ?? 0;
  }

  getOpacitySum(id: string): number {
    const index = this.indexForId(id);
    return (
      (this.pointOpacities[index] ?? 0) +
      (this.sphereOpacities[index] ?? 0) +
      (this.modelOpacities[index] ?? 0)
    );
  }

  getSurfaceDetailBlend(id: string): number {
    return this.surfaceDetails[this.indexForId(id)]?.blend ?? 0;
  }

  setSurfaceDetailEnabled(id: string, enabled: boolean): void {
    this.surfaceDetails[this.indexForId(id)]?.setEnabled(enabled);
  }

  private indexForId(id: string): number {
    const index = this.idToIndex.get(id);
    if (index === undefined) throw new Error(`Unknown body visual id "${id}".`);
    return index;
  }

  private beginSphereLoad(index: number): void {
    this.sphereLoadStates[index] = LOAD_LOADING;
    const definition = this.definitions[index];
    if (definition === undefined) throw new Error('Body definition array is sparse.');
    void this.assetLoader
      .loadSphereAlbedo(definition.id, definition.category)
      .then((texture) => this.finishSphereLoad(index, texture))
      .catch(() => {
        this.sphereLoadStates[index] = LOAD_FAILED;
      });
  }

  private async loadSphereNow(index: number): Promise<void> {
    if (this.sphereLoadStates[index] !== LOAD_IDLE) return;
    this.sphereLoadStates[index] = LOAD_LOADING;
    const definition = this.definitions[index];
    if (definition === undefined) throw new Error('Body definition array is sparse.');
    try {
      const texture = await this.assetLoader.loadSphereAlbedo(definition.id, definition.category);
      this.finishSphereLoad(index, texture);
    } catch {
      this.sphereLoadStates[index] = LOAD_FAILED;
    }
  }

  private finishSphereLoad(index: number, texture: Texture | null): void {
    if (texture === null) {
      this.sphereLoadStates[index] = LOAD_FAILED;
      return;
    }
    const material = this.sphereTexturedMaterials[index];
    if (material === undefined) throw new Error('Sphere material array is out of sync.');
    material.map = texture;
    if (this.definitions[index]?.category === 'sun') material.emissiveMap = texture;
    this.sphereLoadStates[index] = LOAD_READY;
    this.sphereTextureFadePending[index] = 1;
  }

  private beginModelLoad(index: number): void {
    this.modelLoadStates[index] = LOAD_LOADING;
    const definition = this.definitions[index];
    if (definition === undefined) throw new Error('Body definition array is sparse.');
    void this.assetLoader
      .loadModel(definition.id)
      .then((model) => this.prepareModel(index, model))
      .catch(() => {
        this.modelLoadStates[index] = LOAD_FAILED;
      });
  }

  private async prepareModel(index: number, model: LoadedBodyModel | null): Promise<void> {
    if (model === null) {
      this.modelLoadStates[index] = LOAD_FAILED;
      return;
    }
    const definition = this.definitions[index];
    if (definition === undefined) throw new Error('Body definition array is sparse.');
    const surfaceMaterial = model.materials.find(
      (material): material is MeshStandardMaterial =>
        material instanceof MeshStandardMaterial && material.name === 'mat_surface',
    );
    let gasGiantAnimation: GasGiantAnimation | null = null;
    let ringSystem: PreparedRingSystem | null = null;
    let surfaceDetail: PreparedSurfaceDetail | null = null;
    let earthSurfaceLayers: PreparedEarthSurfaceLayers | null = null;
    let baseOpacities: Float32Array | null = null;
    let baseDepthWrites: Uint8Array | null = null;
    let baseTransparencies: Uint8Array | null = null;
    let baseForceSinglePasses: Uint8Array | null = null;
    let preparedMaterialCount = 0;
    let modelBound = false;
    const previousModelParent = model.root.parent;
    const previousMatrixAutoUpdate = model.root.matrixAutoUpdate;
    try {
      gasGiantAnimation =
        surfaceMaterial === undefined
          ? null
          : prepareGasGiantAnimation(definition.id, definition.proceduralSeed, surfaceMaterial);
      if (gasGiantAnimation !== null) {
        gasGiantAnimation.setQuality(this.proceduralQuality);
      } else if (
        definition.id === 'jupiter' ||
        definition.id === 'saturn' ||
        definition.id === 'uranus' ||
        definition.id === 'neptune'
      ) {
        throw new Error(`Gas-giant model "${definition.id}" is missing mat_surface.`);
      }

      const ringDefinition = ringDefinitionFor(definition.id);
      if (ringDefinition !== null) {
        ringSystem = prepareRingSystem(model.root, model.materials, ringDefinition, definition);
        if (ringSystem === null) {
          throw new Error(`Ring model "${definition.id}" is missing its required material pair.`);
        }
        ringSystem.setParticleCount(this.ringParticleCount);
      }

      if (model.surfaceDetail !== null) {
        if (surfaceMaterial === undefined) {
          model.surfaceDetail.albedo.dispose();
          model.surfaceDetail.normal.dispose();
        } else {
          surfaceDetail = prepareSurfaceDetail(surfaceMaterial, model.surfaceDetail);
        }
      }
      if (definition.id === 'earth') {
        earthSurfaceLayers = prepareEarthSurfaceLayers(model.root, model.materials);
      }

      baseOpacities = new Float32Array(model.materials.length);
      baseDepthWrites = new Uint8Array(model.materials.length);
      baseTransparencies = new Uint8Array(model.materials.length);
      baseForceSinglePasses = new Uint8Array(model.materials.length);
      for (let materialIndex = 0; materialIndex < model.materials.length; materialIndex += 1) {
        const material = model.materials[materialIndex];
        if (material === undefined) throw new Error('Loaded model material array is sparse.');
        if (definition.category === 'sun' && material instanceof MeshStandardMaterial) {
          material.emissiveIntensity = Math.max(SUN_EMISSIVE_INTENSITY, material.emissiveIntensity);
        }
        if (definition.category === 'sun') this.proceduralSun.prepareMaterial(material);
        if (
          definition.id === 'earth' &&
          material instanceof MeshStandardMaterial &&
          material.emissiveMap !== null
        ) {
          material.emissiveIntensity = Math.max(
            EARTH_NIGHT_EMISSIVE_INTENSITY,
            material.emissiveIntensity,
          );
        }
        if (
          definition.id === 'earth' &&
          material instanceof MeshStandardMaterial &&
          material.name === 'mat_clouds' &&
          material.map !== null
        ) {
          material.alphaMap = material.map;
          material.depthWrite = false;
          material.needsUpdate = true;
        }
        baseOpacities[materialIndex] = material.opacity;
        baseDepthWrites[materialIndex] = material.depthWrite ? 1 : 0;
        baseTransparencies[materialIndex] = material.transparent ? 1 : 0;
        baseForceSinglePasses[materialIndex] = material.forceSinglePass ? 1 : 0;
        preparedMaterialCount += 1;
        material.transparent = true;
        material.forceSinglePass = true;
        material.opacity = 0;
        material.depthWrite = false;
      }
      model.root.scale.setScalar(ringDefinition?.referenceRadiusKm ?? definition.meanRadiusKm);
      model.root.visible = true;
      this.spaceScene.bindPackedVisual(model.root, this.positionsKm, index * 3);
      modelBound = true;
      await this.compileModel(model.root);
      this.modelRoots[index] = model.root;
      this.modelMaterials[index] = model.materials;
      this.modelBaseOpacities[index] = baseOpacities;
      this.modelBaseDepthWrites[index] = baseDepthWrites;
      this.modelBaseTransparencies[index] = baseTransparencies;
      this.modelBaseForceSinglePasses[index] = baseForceSinglePasses;
      this.gasGiantAnimations[index] = gasGiantAnimation;
      this.ringSystems[index] = ringSystem;
      this.surfaceDetails[index] = surfaceDetail;
      this.earthSurfaceLayers[index] = earthSurfaceLayers;
      this.modelLoadStates[index] = LOAD_READY;
    } catch {
      if (modelBound) {
        this.spaceScene.unbindVisual(model.root);
        previousModelParent?.add(model.root);
        model.root.matrixAutoUpdate = previousMatrixAutoUpdate;
      }
      earthSurfaceLayers?.dispose();
      surfaceDetail?.dispose();
      ringSystem?.dispose();
      gasGiantAnimation?.dispose();
      if (
        baseOpacities !== null &&
        baseDepthWrites !== null &&
        baseTransparencies !== null &&
        baseForceSinglePasses !== null
      ) {
        for (let materialIndex = 0; materialIndex < preparedMaterialCount; materialIndex += 1) {
          const material = model.materials[materialIndex];
          if (material === undefined) break;
          material.opacity = baseOpacities[materialIndex] ?? material.opacity;
          material.depthWrite = baseDepthWrites[materialIndex] === 1;
          material.transparent = baseTransparencies[materialIndex] === 1;
          material.forceSinglePass = baseForceSinglePasses[materialIndex] === 1;
        }
      }
      model.root.visible = false;
      this.modelLoadStates[index] = LOAD_FAILED;
    }
  }

  private beginFade(index: number, targetTier: VisualTier, nowMs: number): void {
    const pointOpacity = this.pointOpacities[index] ?? 0;
    if (targetTier === 1 && pointOpacity < INITIAL_POINT_FADE_OPACITY) {
      const sphereOpacity = this.sphereOpacities[index] ?? 0;
      const modelOpacity = this.modelOpacities[index] ?? 0;
      const sourceOpacity = sphereOpacity + modelOpacity;
      if (sourceOpacity > 0) {
        const retainedSourceOpacity = 1 - INITIAL_POINT_FADE_OPACITY;
        const sourceScale = retainedSourceOpacity / sourceOpacity;
        this.pointOpacities[index] = INITIAL_POINT_FADE_OPACITY;
        this.sphereOpacities[index] = sphereOpacity * sourceScale;
        this.modelOpacities[index] = modelOpacity * sourceScale;
      }
    }
    this.fadePointStarts[index] = this.pointOpacities[index] ?? 0;
    this.fadeSphereStarts[index] = this.sphereOpacities[index] ?? 0;
    this.fadeModelStarts[index] = this.modelOpacities[index] ?? 0;
    this.fadeStartMs[index] = nowMs;
    this.fadeActive[index] = 1;
    this.displayTargetTiers[index] = targetTier;
  }

  private advanceFade(index: number, nowMs: number): void {
    if (this.fadeActive[index] === 0) return;
    const progress = Math.min(
      1,
      Math.max(0, (nowMs - (this.fadeStartMs[index] ?? 0)) / FADE_DURATION_MS),
    );
    const targetTier = this.displayTargetTiers[index];
    const pointTarget = targetTier === 1 ? 1 : 0;
    const sphereTarget = targetTier === 2 ? 1 : 0;
    const modelTarget = targetTier === 3 ? 1 : 0;
    const pointStart = this.fadePointStarts[index] ?? 0;
    const sphereStart = this.fadeSphereStarts[index] ?? 0;
    const modelStart = this.fadeModelStarts[index] ?? 0;
    this.pointOpacities[index] = pointStart + (pointTarget - pointStart) * progress;
    this.sphereOpacities[index] = sphereStart + (sphereTarget - sphereStart) * progress;
    this.modelOpacities[index] = modelStart + (modelTarget - modelStart) * progress;
    if (progress >= 1) this.fadeActive[index] = 0;
  }

  private advanceSphereTextureFade(index: number, nowMs: number): void {
    if (this.sphereTextureFadePending[index] !== 0) {
      this.sphereTextureFadePending[index] = 0;
      this.sphereTextureFadeActive[index] = 1;
      this.sphereTextureFadeStartMs[index] = nowMs;
      this.sphereTextureMixes[index] = 0;
    }
    if (this.sphereTextureFadeActive[index] === 0) return;
    const progress = Math.min(
      1,
      Math.max(0, (nowMs - (this.sphereTextureFadeStartMs[index] ?? 0)) / FADE_DURATION_MS),
    );
    this.sphereTextureMixes[index] = progress;
    if (progress >= 1) this.sphereTextureFadeActive[index] = 0;
  }

  private applyNearOpacity(index: number): void {
    const fallbackSphere = this.sphereFallbackMeshes[index];
    const texturedSphere = this.sphereTexturedMeshes[index];
    const fallbackMaterial = this.sphereFallbackMaterials[index];
    const texturedMaterial = this.sphereTexturedMaterials[index];
    if (
      fallbackSphere === undefined ||
      texturedSphere === undefined ||
      fallbackMaterial === undefined ||
      texturedMaterial === undefined
    ) {
      throw new Error('Sphere visual arrays are out of sync.');
    }
    const sphereOpacity = this.sphereOpacities[index] ?? 0;
    const textureMix = this.sphereTextureMixes[index] ?? 0;
    const fallbackOpacity = sphereOpacity * (1 - textureMix);
    const texturedOpacity = sphereOpacity * textureMix;
    fallbackSphere.visible = fallbackOpacity > 0;
    texturedSphere.visible = texturedOpacity > 0;
    fallbackMaterial.opacity = fallbackOpacity;
    fallbackMaterial.transparent = fallbackOpacity < 1;
    fallbackMaterial.depthWrite = fallbackOpacity >= 1;
    texturedMaterial.opacity = texturedOpacity;
    texturedMaterial.transparent = texturedOpacity < 1;
    texturedMaterial.depthWrite = texturedOpacity >= 1;

    const root = this.modelRoots[index];
    const materials = this.modelMaterials[index];
    const baseOpacities = this.modelBaseOpacities[index];
    const baseDepthWrites = this.modelBaseDepthWrites[index];
    const baseTransparencies = this.modelBaseTransparencies[index];
    const baseForceSinglePasses = this.modelBaseForceSinglePasses[index];
    if (
      root === null ||
      root === undefined ||
      materials === null ||
      materials === undefined ||
      baseOpacities === null ||
      baseOpacities === undefined ||
      baseDepthWrites === null ||
      baseDepthWrites === undefined ||
      baseTransparencies === null ||
      baseTransparencies === undefined ||
      baseForceSinglePasses === null ||
      baseForceSinglePasses === undefined
    ) {
      return;
    }
    const modelOpacity = this.modelOpacities[index] ?? 0;
    root.visible = modelOpacity > 0;
    for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
      const material = materials[materialIndex];
      if (material === undefined) throw new Error('Loaded model material array is sparse.');
      material.opacity = (baseOpacities[materialIndex] ?? 1) * modelOpacity;
      if (modelOpacity >= 1) {
        material.transparent = baseTransparencies[materialIndex] === 1;
        material.depthWrite = baseDepthWrites[materialIndex] === 1;
        material.forceSinglePass = baseForceSinglePasses[materialIndex] === 1;
      } else {
        material.transparent = true;
        material.depthWrite = false;
        material.forceSinglePass = true;
      }
    }
  }
}
