import {
  DataTexture,
  EquirectangularReflectionMapping,
  MeshStandardMaterial,
  RGBAFormat,
  type Material,
  type Object3D,
  type Texture,
} from 'three';

import type { ReadonlyVec3 } from '../core/vec3.js';
import { writeForwardFromQuaternionInto } from '../sim/ship/attitude.js';
import { STATE_RX, STATE_RY, STATE_RZ } from '../sim/ship/relativity.js';
import type { LoadedBodyModel } from './bodyAssetLoader.js';
import type { BodyPointCloud } from './bodyPointCloud.js';
import type { BodyModelLoadState } from './bodyVisualSystem.js';
import { addMagnitudes } from './plumeRadiance.js';
import { AMBIENT_LIGHT_INTENSITY } from './solarLighting.js';
import type { CameraRelativeSpaceScene } from './spaceScene.js';
import {
  apparentMagnitude,
  pointIntensityForMagnitude,
  projectedDiameterPx,
  selectResolvedRepresentation,
  TIER_FADE_DURATION_MS,
} from './visualTier.js';

/** Manifest id of the ship asset built by `tools/blender/build_ship.py`. */
export const SHIP_ASSET_ID = 'ship';

/** `EXPECTED_LENGTH_METERS` in the builder; one Blender unit is one metre. */
export const SHIP_LENGTH_M = 26.12;

/** Model units are metres; the render frame is kilometres. */
export const SHIP_MODEL_SCALE_KM_PER_UNIT = 1e-3;

/** Half the hull length: the nose/tail extent dominates the bounding sphere. */
export const SHIP_BOUNDING_RADIUS_KM = (SHIP_LENGTH_M * SHIP_MODEL_SCALE_KM_PER_UNIT) / 2;

/** Hull geometric albedo used by the shared apparent-magnitude path. */
export const SHIP_HULL_GEOMETRIC_ALBEDO = 0.45;

/** Neutral hull white for the ship's slot in the shared additive point cloud. */
export const SHIP_POINT_COLOR = 0xdf_e6_ef;

/** Node whose world offset from the model root is the authored nose direction. */
export const SHIP_NOSE_NODE_NAME = 'hull_tip';

/**
 * Rotation from the glTF model frame to the ADR-025 physics body frame.
 *
 * Measured from the committed asset: glTF `+X` is the nose (`hull_nose` at
 * `[9.5,0,0]`), `+Y` is up (`canopy` at `[6.6,1.55,0]`) and `±Z` is lateral
 * (`radiator_P/S` at `[2,0,∓4.2]`). ADR-025 §4 makes the body frame `+X` nose,
 * pitch about `+Y` (lateral) and yaw about `+Z` (up), so the two frames agree on
 * the nose and differ by a quarter turn of roll about it. `+90°` about `X` maps
 * model `+Y` onto body `+Z`.
 */
const MODEL_TO_BODY_X = Math.SQRT1_2;
const MODEL_TO_BODY_W = Math.SQRT1_2;

const LOAD_IDLE = 0;
const LOAD_LOADING = 1;
const LOAD_READY = 2;
const LOAD_FAILED = 3;

const AMBIENT_SKY_WIDTH = 8;
const AMBIENT_SKY_HEIGHT = 4;

/**
 * `envMapIntensity` for a white (1.0) sky texel, chosen so the environment's
 * radiance equals the scene ambient.
 *
 * three.js 0.185.1 `getIBLIrradiance` returns `PI * envMapColor * envMapIntensity`
 * — an irradiance — while `AmbientLight.intensity` is already an irradiance. The
 * `1/PI` therefore converts the ambient irradiance into the sky radiance that
 * produces it, instead of over-driving the environment by a factor of PI.
 */
const AMBIENT_SKY_ENV_MAP_INTENSITY = AMBIENT_LIGHT_INTENSITY / Math.PI;

export interface ShipVisualAssetLoader {
  loadModel(id: string): Promise<LoadedBodyModel | null>;
}

export type ShipModelCompiler = (root: Object3D) => Promise<void>;

/**
 * Notified once, when the lazily fetched model is bound and ready.
 *
 * T0122's effects are precompiled long before the asset arrives, so they need a
 * moment to verify their transcribed anchors against the real nodes and to adopt
 * the authored light materials.
 */
export type ShipModelReadyObserver = (root: Object3D, materials: readonly Material[]) => void;

export interface ShipVisualOptions {
  readonly spaceScene: CameraRelativeSpaceScene;
  readonly pointCloud: BodyPointCloud;
  /** Packed float64 positions whose trailing triple belongs to the ship. */
  readonly positionsKm: Float64Array;
  /** Index of the ship's triple, which is also its point-cloud slot. */
  readonly shipIndex: number;
  readonly sunIndex: number;
  readonly assetLoader: ShipVisualAssetLoader;
  readonly compileModel: ShipModelCompiler;
  readonly lazyLoadingEnabled?: boolean;
}

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
      throw new Error('Unknown ship model load state.');
  }
}

/**
 * Builds the isotropic sky the ship's metals reflect.
 *
 * three.js routes `AmbientLight` into the diffuse term only, and a metal has no
 * diffuse term, so an authored metallic hull renders black without an
 * environment. A constant environment at the scene's ambient radiance gives
 * metal a sky to reflect, rather than inventing a studio fill light the spec
 * rejects.
 *
 * It is not an exact equivalence: the ship keeps its `AmbientLight` term as well,
 * so its *dielectrics* receive ambient irradiance twice (0.04 rather than 0.02)
 * while every other object receives it once. That is deliberate. Suppressing the
 * double count would require either removing the ship from the ambient light or
 * halving the sky, and halving the sky would misstate the radiance the metals —
 * the reason this exists — actually reflect. At 0.04 against roughly 3.14 of
 * direct solar irradiance the difference is 1.3 % of the lit hull and invisible;
 * the honest fix is real planetshine (Front C), not a fudged constant.
 */
function createAmbientSkyEnvironment(): Texture {
  const texels = new Uint8Array(AMBIENT_SKY_WIDTH * AMBIENT_SKY_HEIGHT * 4).fill(255);
  const texture = new DataTexture(texels, AMBIENT_SKY_WIDTH, AMBIENT_SKY_HEIGHT, RGBAFormat);
  texture.mapping = EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Renders the player vessel: a lit mesh once it resolves, and a slot in the
 * shared additive point cloud whenever it does not.
 *
 * Position and attitude come from `SimSnapshot`; the position is written into
 * the caller-owned packed float64 array that `CameraRelativeSpaceScene`,
 * `SolarLighting` and `OrbitCameraController` already read, so the ship needs no
 * bespoke camera, lighting or precision machinery. The normal frame path
 * allocates nothing.
 */
export class ShipVisual {
  private readonly spaceScene: CameraRelativeSpaceScene;
  private readonly pointCloud: BodyPointCloud;
  private readonly positionsKm: Float64Array;
  private readonly shipIndex: number;
  private readonly sunIndex: number;
  private readonly positionOffset: number;
  private readonly assetLoader: ShipVisualAssetLoader;
  private readonly compileModel: ShipModelCompiler;

  private readonly renderQuaternion = new Float64Array([0, 0, 0, 1]);
  private readonly attitudeQuaternion = new Float64Array([0, 0, 0, 1]);
  private readonly forwardScratch = new Float64Array(3);
  private readonly noseScratch = new Float64Array(3);

  private lazyLoadingEnabled: boolean;
  private modelLoadState = LOAD_IDLE;
  private modelRoot: Object3D | null = null;
  private noseNode: Object3D | null = null;
  private modelMaterials: Material[] | null = null;
  private baseOpacities: Float32Array | null = null;
  private baseDepthWrites: Uint8Array | null = null;
  private baseTransparencies: Uint8Array | null = null;
  private baseForceSinglePasses: Uint8Array | null = null;

  private resolvedRepresentation = false;
  private displayResolved = false;
  private currentDiameterPx = 0;
  private currentPointOpacity = 1;
  private currentModelOpacity = 0;
  private fadeActive = false;
  private fadeStartMs = 0;
  private fadePointStart = 1;
  private fadeModelStart = 0;
  private plumeMagnitude = Number.POSITIVE_INFINITY;
  private currentPointMagnitude = Number.POSITIVE_INFINITY;
  private modelReadyObserver: ShipModelReadyObserver | null = null;

  constructor(options: ShipVisualOptions) {
    const { positionsKm, shipIndex } = options;
    if (!Number.isInteger(shipIndex) || shipIndex < 0 || shipIndex * 3 + 2 >= positionsKm.length) {
      throw new RangeError('Ship index must address one packed xyz triple.');
    }
    if (
      !Number.isInteger(options.sunIndex) ||
      options.sunIndex < 0 ||
      options.sunIndex * 3 + 2 >= positionsKm.length
    ) {
      throw new RangeError('Sun index must address one packed xyz triple.');
    }

    this.spaceScene = options.spaceScene;
    this.pointCloud = options.pointCloud;
    this.positionsKm = positionsKm;
    this.shipIndex = shipIndex;
    this.sunIndex = options.sunIndex;
    this.positionOffset = shipIndex * 3;
    this.assetLoader = options.assetLoader;
    this.compileModel = options.compileModel;
    this.lazyLoadingEnabled = options.lazyLoadingEnabled ?? true;
  }

  /** Publishes one simulation snapshot's ship position and attitude. */
  writeState(shipStateKm: Float64Array, attitudeQuaternion: Float64Array): void {
    const x = shipStateKm[STATE_RX] as number;
    const y = shipStateKm[STATE_RY] as number;
    const z = shipStateKm[STATE_RZ] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new RangeError('Ship state must contain finite kilometre coordinates.');
    }
    this.positionsKm[this.positionOffset] = x;
    this.positionsKm[this.positionOffset + 1] = y;
    this.positionsKm[this.positionOffset + 2] = z;

    const attitudeX = attitudeQuaternion[0] as number;
    const attitudeY = attitudeQuaternion[1] as number;
    const attitudeZ = attitudeQuaternion[2] as number;
    const attitudeW = attitudeQuaternion[3] as number;
    if (
      !Number.isFinite(attitudeX) ||
      !Number.isFinite(attitudeY) ||
      !Number.isFinite(attitudeZ) ||
      !Number.isFinite(attitudeW)
    ) {
      throw new RangeError('Ship attitude quaternion must contain finite components.');
    }
    this.attitudeQuaternion[0] = attitudeX;
    this.attitudeQuaternion[1] = attitudeY;
    this.attitudeQuaternion[2] = attitudeZ;
    this.attitudeQuaternion[3] = attitudeW;

    // q_render = q_attitude (x) q_modelToBody, so the model's local +X nose is
    // carried onto the physics forward direction. Written out longhand to keep
    // the frame path free of a scratch Quaternion.
    const renderX = attitudeW * MODEL_TO_BODY_X + attitudeX * MODEL_TO_BODY_W;
    const renderY = attitudeY * MODEL_TO_BODY_W + attitudeZ * MODEL_TO_BODY_X;
    const renderZ = attitudeZ * MODEL_TO_BODY_W - attitudeY * MODEL_TO_BODY_X;
    const renderW = attitudeW * MODEL_TO_BODY_W - attitudeX * MODEL_TO_BODY_X;
    this.renderQuaternion[0] = renderX;
    this.renderQuaternion[1] = renderY;
    this.renderQuaternion[2] = renderZ;
    this.renderQuaternion[3] = renderW;
    this.modelRoot?.quaternion.set(renderX, renderY, renderZ, renderW);
  }

  /** Selects the representation and writes its appearance, without allocating. */
  update(
    cameraPositionKm: ReadonlyVec3,
    viewportHeightPx: number,
    verticalFovRad: number,
    nowMs: number,
  ): void {
    if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite.');

    const deltaX = (this.positionsKm[this.positionOffset] as number) - cameraPositionKm.x;
    const deltaY = (this.positionsKm[this.positionOffset + 1] as number) - cameraPositionKm.y;
    const deltaZ = (this.positionsKm[this.positionOffset + 2] as number) - cameraPositionKm.z;
    const distanceKm = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
    const diameterPx = projectedDiameterPx(
      SHIP_BOUNDING_RADIUS_KM,
      distanceKm,
      viewportHeightPx,
      verticalFovRad,
    );
    this.currentDiameterPx = diameterPx;
    this.resolvedRepresentation = selectResolvedRepresentation(
      this.resolvedRepresentation,
      diameterPx,
    );

    if (
      this.lazyLoadingEnabled &&
      this.resolvedRepresentation &&
      this.modelLoadState === LOAD_IDLE
    ) {
      this.beginModelLoad();
    }

    const displayResolved = this.resolvedRepresentation && this.modelLoadState === LOAD_READY;
    if (displayResolved !== this.displayResolved) this.beginFade(displayResolved, nowMs);
    this.advanceFade(nowMs);

    const reflectedMagnitude = apparentMagnitude(
      this.shipIndex,
      this.sunIndex,
      SHIP_BOUNDING_RADIUS_KM,
      SHIP_HULL_GEOMETRIC_ALBEDO,
      this.positionsKm,
      cameraPositionKm,
    );
    // T0122 — the artificial star. A burning photon drive radiates `P = m·α·c`,
    // which is 16 magnitudes brighter than the reflected hull at 1 AU, so the
    // plume is added into this same slot in *flux* (rendering-spec §3.4) rather
    // than through a second sprite with its own brightness ladder.
    const magnitude = addMagnitudes(reflectedMagnitude, this.plumeMagnitude);
    this.currentPointMagnitude = magnitude;
    this.pointCloud.writeAppearance(
      this.shipIndex,
      diameterPx,
      this.currentPointOpacity,
      pointIntensityForMagnitude(magnitude),
    );
    this.pointCloud.commitAppearance();
    this.applyModelOpacity();
  }

  /** Allows the model fetch once the space phase owns the frame loop. */
  enableLazyLoading(): void {
    this.lazyLoadingEnabled = true;
  }

  /**
   * Registers the one-shot model-ready hook, firing immediately if it is late.
   *
   * Setup-time only: the observer is a closure and the frame path never touches
   * it (`docs/performance-spec.md` §5).
   */
  setModelReadyObserver(observer: ShipModelReadyObserver): void {
    this.modelReadyObserver = observer;
    const root = this.modelRoot;
    const materials = this.modelMaterials;
    if (this.modelLoadState === LOAD_READY && root !== null && materials !== null) {
      observer(root, materials);
    }
  }

  /**
   * Adds one frame's plume flux to the point sprite (T0122).
   *
   * `Number.POSITIVE_INFINITY` — the default and the coasting value — is zero
   * flux, so a ship with no plume system wired renders exactly as it did before.
   * `ShipEffects` writes this immediately before {@link update}.
   */
  setPlumeMagnitude(magnitude: number): void {
    this.plumeMagnitude = Number.isNaN(magnitude) ? Number.POSITIVE_INFINITY : magnitude;
  }

  /**
   * Copies the composed model-to-world quaternion out, without allocating.
   *
   * The VFX root has to carry exactly the ship's rendered orientation. Handing
   * out the number rather than re-deriving `q_attitude ⊗ q_modelToBody` in a
   * second module is what keeps the two from drifting apart.
   */
  writeRenderQuaternionInto(target: Float64Array): void {
    if (target.length < 4) throw new RangeError('Quaternion target must hold four components.');
    target[0] = this.renderQuaternion[0] as number;
    target[1] = this.renderQuaternion[1] as number;
    target[2] = this.renderQuaternion[2] as number;
    target[3] = this.renderQuaternion[3] as number;
  }

  get loadState(): BodyModelLoadState {
    return loadStateName(this.modelLoadState);
  }

  get resolved(): boolean {
    return this.resolvedRepresentation;
  }

  get diameterPx(): number {
    return this.currentDiameterPx;
  }

  get pointOpacity(): number {
    return this.currentPointOpacity;
  }

  get modelOpacity(): number {
    return this.currentModelOpacity;
  }

  /** Combined reflected + plume magnitude last written to the point cloud. */
  get pointMagnitude(): number {
    return this.currentPointMagnitude;
  }

  get root(): Object3D | null {
    return this.modelRoot;
  }

  /**
   * Cosine between the rendered nose and the physics forward direction.
   *
   * ADR-025 makes the ship's local `+X` both the nose and the thrust axis, so
   * this is `1` exactly when the model frame correction, the quaternion
   * component order and the multiplication order are all right.
   */
  get noseAlignment(): number {
    writeForwardFromQuaternionInto(this.noseScratch, this.renderQuaternion);
    writeForwardFromQuaternionInto(this.forwardScratch, this.attitudeQuaternion);
    return (
      (this.noseScratch[0] as number) * (this.forwardScratch[0] as number) +
      (this.noseScratch[1] as number) * (this.forwardScratch[1] as number) +
      (this.noseScratch[2] as number) * (this.forwardScratch[2] as number)
    );
  }

  /**
   * Same cosine, measured through the loaded asset's own geometry.
   *
   * Uses the world offset of the authored nose node from the model root, so it
   * fails if the `.glb` is ever re-exported with a different nose axis. Returns
   * `-2` when no model is loaded — an impossible cosine, so a caller cannot
   * mistake "not measured" for "aligned".
   */
  get noseNodeAlignment(): number {
    const root = this.modelRoot;
    const nose = this.noseNode;
    if (root === null || nose === null) return -2;
    // The bound root recomposes its matrix inside `updateCameraRelative`; this
    // getter may be read between a `writeState` and that recomposition, so it
    // repeats the same idempotent compose rather than measuring a stale pose.
    // Diagnostics/tests only: this mutates render state (the same idempotent
    // compose `updateCameraRelative` performs) and walks the model's children,
    // so it must never be polled from the frame loop.
    root.updateMatrix();
    root.updateMatrixWorld(true);
    const offsetX = nose.matrixWorld.elements[12] as number;
    const offsetY = nose.matrixWorld.elements[13] as number;
    const offsetZ = nose.matrixWorld.elements[14] as number;
    const rootX = root.matrixWorld.elements[12] as number;
    const rootY = root.matrixWorld.elements[13] as number;
    const rootZ = root.matrixWorld.elements[14] as number;
    const noseX = offsetX - rootX;
    const noseY = offsetY - rootY;
    const noseZ = offsetZ - rootZ;
    const length = Math.hypot(noseX, noseY, noseZ);
    if (!Number.isFinite(length) || length === 0) return -2;
    writeForwardFromQuaternionInto(this.forwardScratch, this.attitudeQuaternion);
    return (
      (noseX / length) * (this.forwardScratch[0] as number) +
      (noseY / length) * (this.forwardScratch[1] as number) +
      (noseZ / length) * (this.forwardScratch[2] as number)
    );
  }

  private beginModelLoad(): void {
    this.modelLoadState = LOAD_LOADING;
    void this.assetLoader
      .loadModel(SHIP_ASSET_ID)
      .then((model) => this.prepareModel(model))
      .catch(() => {
        this.modelLoadState = LOAD_FAILED;
      });
  }

  private async prepareModel(model: LoadedBodyModel | null): Promise<void> {
    if (model === null) {
      this.modelLoadState = LOAD_FAILED;
      return;
    }
    const previousParent = model.root.parent;
    const previousMatrixAutoUpdate = model.root.matrixAutoUpdate;
    let bound = false;
    let preparedMaterialCount = 0;
    const baseOpacities = new Float32Array(model.materials.length);
    const baseDepthWrites = new Uint8Array(model.materials.length);
    const baseTransparencies = new Uint8Array(model.materials.length);
    const baseForceSinglePasses = new Uint8Array(model.materials.length);
    let environment: Texture | null = null;
    try {
      if (model.surfaceDetail !== null) {
        model.surfaceDetail.albedo.dispose();
        model.surfaceDetail.normal.dispose();
      }
      environment = createAmbientSkyEnvironment();
      for (let index = 0; index < model.materials.length; index += 1) {
        const material = model.materials[index];
        if (material === undefined) throw new Error('Ship model material array is sparse.');
        if (material instanceof MeshStandardMaterial) {
          material.envMap = environment;
          material.envMapIntensity = AMBIENT_SKY_ENV_MAP_INTENSITY;
          material.needsUpdate = true;
        }
        baseOpacities[index] = material.opacity;
        baseDepthWrites[index] = material.depthWrite ? 1 : 0;
        baseTransparencies[index] = material.transparent ? 1 : 0;
        baseForceSinglePasses[index] = material.forceSinglePass ? 1 : 0;
        preparedMaterialCount += 1;
        material.transparent = true;
        material.forceSinglePass = true;
        material.opacity = 0;
        material.depthWrite = false;
      }

      model.root.scale.setScalar(SHIP_MODEL_SCALE_KM_PER_UNIT);
      model.root.quaternion.set(
        this.renderQuaternion[0] as number,
        this.renderQuaternion[1] as number,
        this.renderQuaternion[2] as number,
        this.renderQuaternion[3] as number,
      );
      model.root.visible = false;
      this.spaceScene.bindPackedVisual(model.root, this.positionsKm, this.positionOffset);
      bound = true;
      await this.compileModel(model.root);

      this.modelRoot = model.root;
      this.noseNode = model.root.getObjectByName(SHIP_NOSE_NODE_NAME) ?? null;
      this.modelMaterials = model.materials;
      this.baseOpacities = baseOpacities;
      this.baseDepthWrites = baseDepthWrites;
      this.baseTransparencies = baseTransparencies;
      this.baseForceSinglePasses = baseForceSinglePasses;
      this.modelLoadState = LOAD_READY;
      this.modelReadyObserver?.(model.root, model.materials);
    } catch {
      if (bound) {
        this.spaceScene.unbindVisual(model.root);
        previousParent?.add(model.root);
        model.root.matrixAutoUpdate = previousMatrixAutoUpdate;
      }
      for (let index = 0; index < preparedMaterialCount; index += 1) {
        const material = model.materials[index];
        if (material === undefined) break;
        material.opacity = baseOpacities[index] ?? material.opacity;
        material.depthWrite = baseDepthWrites[index] === 1;
        material.transparent = baseTransparencies[index] === 1;
        material.forceSinglePass = baseForceSinglePasses[index] === 1;
      }
      environment?.dispose();
      model.root.visible = false;
      this.modelLoadState = LOAD_FAILED;
    }
  }

  private beginFade(displayResolved: boolean, nowMs: number): void {
    this.fadePointStart = this.currentPointOpacity;
    this.fadeModelStart = this.currentModelOpacity;
    this.fadeStartMs = nowMs;
    this.fadeActive = true;
    this.displayResolved = displayResolved;
  }

  private advanceFade(nowMs: number): void {
    if (!this.fadeActive) return;
    const progress = Math.min(1, Math.max(0, (nowMs - this.fadeStartMs) / TIER_FADE_DURATION_MS));
    const pointTarget = this.displayResolved ? 0 : 1;
    const modelTarget = this.displayResolved ? 1 : 0;
    this.currentPointOpacity = this.fadePointStart + (pointTarget - this.fadePointStart) * progress;
    this.currentModelOpacity = this.fadeModelStart + (modelTarget - this.fadeModelStart) * progress;
    if (progress >= 1) this.fadeActive = false;
  }

  private applyModelOpacity(): void {
    const root = this.modelRoot;
    const materials = this.modelMaterials;
    const baseOpacities = this.baseOpacities;
    const baseDepthWrites = this.baseDepthWrites;
    const baseTransparencies = this.baseTransparencies;
    const baseForceSinglePasses = this.baseForceSinglePasses;
    if (
      root === null ||
      materials === null ||
      baseOpacities === null ||
      baseDepthWrites === null ||
      baseTransparencies === null ||
      baseForceSinglePasses === null
    ) {
      return;
    }
    const modelOpacity = this.currentModelOpacity;
    root.visible = modelOpacity > 0;
    for (let index = 0; index < materials.length; index += 1) {
      const material = materials[index];
      if (material === undefined) throw new Error('Ship model material array is sparse.');
      material.opacity = (baseOpacities[index] ?? 1) * modelOpacity;
      if (modelOpacity >= 1) {
        material.transparent = baseTransparencies[index] === 1;
        material.depthWrite = baseDepthWrites[index] === 1;
        material.forceSinglePass = baseForceSinglePasses[index] === 1;
      } else {
        material.transparent = true;
        material.depthWrite = false;
        material.forceSinglePass = true;
      }
    }
  }
}
