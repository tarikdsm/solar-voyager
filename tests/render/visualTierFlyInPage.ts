import { AmbientLight, DirectionalLight, Mesh, WebGLRenderTarget, WebGLRenderer } from 'three';

import { loadAssetManifest } from '../../src/render/assetManifest.js';
import { BodyAssetLoader } from '../../src/render/bodyAssetLoader.js';
import { writeBodyAttitudeInto } from '../../src/render/bodySpin.js';
import {
  BodyVisualSystem,
  type BodyVisualDefinition,
  type BodyModelLoadState,
} from '../../src/render/bodyVisualSystem.js';
import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';
import type { VisualTier } from '../../src/render/visualTier.js';

const AU_KM = 149_597_870.7;
const EARTH_RADIUS_KM = 6_371.0084;
const PLUTO_RADIUS_KM = 1_188.3;
const SATURN_RADIUS_KM = 58_232;
const SATURN_TILT_RAD = 0.466_526_509_058_084_3;
const VIEWPORT_SIZE = 256;
const VERTICAL_FOV_RAD = Math.PI / 3;
const TARGET_SAMPLE_MIN = 96;
const TARGET_SAMPLE_MAX = 160;
/** Silhouette sampling stays inside this radius so nothing off-axis leaks in. */
const SILHOUETTE_RADIUS_PX = 120;
const SILHOUETTE_LUMINANCE = 0;
const SATURN_POSITION_KM = { x: -5 * AU_KM, y: -10 * AU_KM, z: 0 };

interface SilhouetteMetrics {
  /** Lit pixels inside the sampling disc. */
  readonly area: number;
  /** Minor/major axis ratio from the second moments; the projected flattening. */
  readonly axisRatio: number;
  readonly majorAxisPx: number;
  readonly minorAxisPx: number;
  readonly boundsWidthPx: number;
  readonly boundsHeightPx: number;
}

interface VisualTierSnapshot {
  readonly id: string;
  readonly tier: VisualTier;
  readonly loadState: BodyModelLoadState;
  readonly pointOpacity: number;
  readonly sphereOpacity: number;
  readonly modelOpacity: number;
  readonly opacitySum: number;
  readonly litPixels: number;
  readonly glError: number;
}

interface VisualTierHarness {
  stepEarthDistance(distanceKm: number, nowMs: number, simTimeSec?: number): VisualTierSnapshot;
  stepPlutoDistance(distanceKm: number, nowMs: number, simTimeSec?: number): VisualTierSnapshot;
  stepSaturnDistance(distanceKm: number, nowMs: number, simTimeSec?: number): VisualTierSnapshot;
  renderEarthDarkControl(nowMs: number): VisualTierSnapshot;
  snapshotState(id: string): Omit<VisualTierSnapshot, 'litPixels' | 'glError'>;
  /** Second-moment silhouette of the last rendered frame. */
  silhouette(): SilhouetteMetrics;
  /** Published attitude and spin angle, plus the analytic value they must match. */
  attitude(id: string): {
    readonly quaternion: readonly number[];
    readonly spinAngleRad: number;
    readonly expected: readonly number[];
    readonly sphereQuaternion: readonly number[];
    readonly modelQuaternion: readonly number[] | null;
    readonly cloudRotationY: number | null;
  };
  radii(id: string): { readonly equatorialKm: number; readonly polarKm: number };
  setRingsVisible(visible: boolean): void;
  /** Frame-loop allocation probe: repeated updates at advancing simulation time. */
  stress(iterations: number): { readonly heapDeltaBytes: number | null };
}

declare global {
  var __visualTierHarness: VisualTierHarness | undefined;
}

const canvas = document.querySelector('#visual-tier-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Visual-tier canvas is missing.');

const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_SIZE, VIEWPORT_SIZE, false);
renderer.setClearColor(0x000000, 1);

const spaceScene = new CameraRelativeSpaceScene();
spaceScene.camera.fov = 60;
spaceScene.camera.aspect = 1;
spaceScene.camera.rotation.y = -Math.PI / 2;
spaceScene.camera.updateProjectionMatrix();
spaceScene.camera.updateMatrix();
const ambient = new AmbientLight(0xffffff, 0.1);
const directional = new DirectionalLight(0xffffff, 2);
directional.position.set(-1, 1, 1);
spaceScene.scene.add(ambient, directional);

const definitions: BodyVisualDefinition[] = [
  {
    id: 'sun',
    category: 'sun',
    axialTiltRad: 0,
    siderealRotationPeriodSec: 2_164_320,
    meanRadiusKm: 695_700,
    muKm3S2: 132_712_440_041.9394,
    polarRadiusRatio: 1,
    geometricAlbedo: 1,
    albedoColor: 0xfff4d6,
    proceduralSeed: 10,
  },
  {
    id: 'earth',
    category: 'planet',
    axialTiltRad: 0.409,
    siderealRotationPeriodSec: 86_164.100_352,
    meanRadiusKm: EARTH_RADIUS_KM,
    muKm3S2: 398_600.435507,
    polarRadiusRatio: 0.9966604474686819,
    geometricAlbedo: 0.434,
    albedoColor: 0x4f78a8,
    proceduralSeed: 399,
  },
  {
    id: 'pluto',
    category: 'dwarf',
    axialTiltRad: 2.138551932468652,
    siderealRotationPeriodSec: -551_854.08,
    meanRadiusKm: PLUTO_RADIUS_KM,
    muKm3S2: 869.3,
    polarRadiusRatio: 1,
    geometricAlbedo: 0.3,
    albedoColor: 0xb7a28c,
    proceduralSeed: 999,
  },
  {
    id: 'saturn',
    category: 'planet',
    axialTiltRad: SATURN_TILT_RAD,
    siderealRotationPeriodSec: 38_362.464,
    meanRadiusKm: SATURN_RADIUS_KM,
    muKm3S2: 37_931_207.8,
    polarRadiusRatio: 0.9020375655405853,
    geometricAlbedo: 0.499,
    albedoColor: 0xd8c49a,
    proceduralSeed: 699,
  },
];
const positionsKm = new Float64Array([
  -2 * AU_KM,
  0,
  0,
  0,
  0,
  0,
  2 * AU_KM,
  10 * AU_KM,
  0,
  SATURN_POSITION_KM.x,
  SATURN_POSITION_KM.y,
  SATURN_POSITION_KM.z,
]);
const cameraPositionKm = { x: -AU_KM, y: 0, z: 0 };
const manifest = await loadAssetManifest(`${import.meta.env.BASE_URL}assets/manifest.json`);
const assetLoader = new BodyAssetLoader(renderer, manifest);
const visualSystem = new BodyVisualSystem(
  spaceScene,
  definitions,
  positionsKm,
  assetLoader,
  async () => {
    await renderer.compileAsync(spaceScene.scene, spaceScene.camera);
  },
  { prepareMaterial: () => undefined },
);
await visualSystem.initializeEager();
spaceScene.updateCameraRelative(cameraPositionKm);
await renderer.compileAsync(spaceScene.scene, spaceScene.camera);

const renderTarget = new WebGLRenderTarget(VIEWPORT_SIZE, VIEWPORT_SIZE);
const pixels = new Uint8Array(VIEWPORT_SIZE * VIEWPORT_SIZE * 4);
const attitudeScratch = new Float64Array(4);
const publishedAttitude = new Float64Array(4);

function stateWithoutPixels(id: string): Omit<VisualTierSnapshot, 'litPixels' | 'glError'> {
  return {
    id,
    tier: visualSystem.getTier(id),
    loadState: visualSystem.getLoadState(id),
    pointOpacity: visualSystem.getOpacity(id, 1),
    sphereOpacity: visualSystem.getOpacity(id, 2),
    modelOpacity: visualSystem.getOpacity(id, 3),
    opacitySum: visualSystem.getOpacitySum(id),
  };
}

function renderSnapshot(id: string): VisualTierSnapshot {
  renderer.setRenderTarget(renderTarget);
  renderer.clear();
  renderer.render(spaceScene.scene, spaceScene.camera);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, VIEWPORT_SIZE, VIEWPORT_SIZE, pixels);
  renderer.setRenderTarget(null);
  let litPixels = 0;
  for (let y = TARGET_SAMPLE_MIN; y < TARGET_SAMPLE_MAX; y += 1) {
    for (let x = TARGET_SAMPLE_MIN; x < TARGET_SAMPLE_MAX; x += 1) {
      const offset = (y * VIEWPORT_SIZE + x) * 4;
      if ((pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0) > 0) {
        litPixels += 1;
      }
    }
  }
  return {
    ...stateWithoutPixels(id),
    litPixels,
    glError: renderer.getContext().getError(),
  };
}

/**
 * Ellipse fitted to the lit silhouette by second moments.
 *
 * Orientation-free on purpose: a tilted pole projects the flattening onto an
 * arbitrary screen axis, and the eigenvalue ratio of the pixel covariance
 * recovers the projected minor/major ratio whatever that axis is.
 */
function silhouetteMetrics(): SilhouetteMetrics {
  const center = VIEWPORT_SIZE / 2;
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < VIEWPORT_SIZE; y += 1) {
    for (let x = 0; x < VIEWPORT_SIZE; x += 1) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      if (dx * dx + dy * dy > SILHOUETTE_RADIUS_PX * SILHOUETTE_RADIUS_PX) continue;
      const offset = (y * VIEWPORT_SIZE + x) * 4;
      const luminance =
        (pixels[offset] ?? 0) * 0.2126 +
        (pixels[offset + 1] ?? 0) * 0.7152 +
        (pixels[offset + 2] ?? 0) * 0.0722;
      if (luminance <= SILHOUETTE_LUMINANCE) continue;
      area += 1;
      sumX += x + 0.5;
      sumY += y + 0.5;
    }
  }
  if (area === 0) {
    return {
      area: 0,
      axisRatio: 0,
      majorAxisPx: 0,
      minorAxisPx: 0,
      boundsWidthPx: 0,
      boundsHeightPx: 0,
    };
  }
  const meanX = sumX / area;
  const meanY = sumY / area;
  let varianceX = 0;
  let varianceY = 0;
  let covariance = 0;
  for (let y = 0; y < VIEWPORT_SIZE; y += 1) {
    for (let x = 0; x < VIEWPORT_SIZE; x += 1) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      if (dx * dx + dy * dy > SILHOUETTE_RADIUS_PX * SILHOUETTE_RADIUS_PX) continue;
      const offset = (y * VIEWPORT_SIZE + x) * 4;
      const luminance =
        (pixels[offset] ?? 0) * 0.2126 +
        (pixels[offset + 1] ?? 0) * 0.7152 +
        (pixels[offset + 2] ?? 0) * 0.0722;
      if (luminance <= SILHOUETTE_LUMINANCE) continue;
      const centeredX = x + 0.5 - meanX;
      const centeredY = y + 0.5 - meanY;
      varianceX += centeredX * centeredX;
      varianceY += centeredY * centeredY;
      covariance += centeredX * centeredY;
    }
  }
  varianceX /= area;
  varianceY /= area;
  covariance /= area;
  const trace = varianceX + varianceY;
  const gap = Math.sqrt((varianceX - varianceY) ** 2 + 4 * covariance * covariance);
  const major = Math.sqrt(Math.max(0, (trace + gap) / 2)) * 4;
  const minor = Math.sqrt(Math.max(0, (trace - gap) / 2)) * 4;
  let minimumX = VIEWPORT_SIZE;
  let maximumX = 0;
  let minimumY = VIEWPORT_SIZE;
  let maximumY = 0;
  for (let y = 0; y < VIEWPORT_SIZE; y += 1) {
    for (let x = 0; x < VIEWPORT_SIZE; x += 1) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      if (dx * dx + dy * dy > SILHOUETTE_RADIUS_PX * SILHOUETTE_RADIUS_PX) continue;
      const offset = (y * VIEWPORT_SIZE + x) * 4;
      const luminance =
        (pixels[offset] ?? 0) * 0.2126 +
        (pixels[offset + 1] ?? 0) * 0.7152 +
        (pixels[offset + 2] ?? 0) * 0.0722;
      if (luminance <= SILHOUETTE_LUMINANCE) continue;
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);
    }
  }
  return {
    area,
    axisRatio: major === 0 ? 0 : minor / major,
    majorAxisPx: major,
    minorAxisPx: minor,
    boundsWidthPx: maximumX - minimumX + 1,
    boundsHeightPx: maximumY - minimumY + 1,
  };
}

function updateAndRender(id: string, nowMs: number, simTimeSec: number): VisualTierSnapshot {
  visualSystem.update(cameraPositionKm, VIEWPORT_SIZE, VERTICAL_FOV_RAD, nowMs, simTimeSec);
  spaceScene.updateCameraRelative(cameraPositionKm);
  return renderSnapshot(id);
}

function aimAt(bodyX: number, bodyY: number, bodyZ: number, distanceKm: number): void {
  cameraPositionKm.x = bodyX - distanceKm;
  cameraPositionKm.y = bodyY;
  cameraPositionKm.z = bodyZ;
  spaceScene.camera.rotation.y = -Math.PI / 2;
  spaceScene.camera.updateMatrix();
}

function definitionFor(id: string): BodyVisualDefinition {
  const definition = definitions.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`Unknown harness body ${id}.`);
  return definition;
}

function quaternionOf(name: string): readonly number[] | null {
  const object = spaceScene.scene.getObjectByName(name);
  if (object === undefined) return null;
  return [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w];
}

/**
 * Every asset's scene root is called `Scene`, so it is addressed through the
 * body-named node the exporter writes underneath it.
 */
function modelRootQuaternion(id: string): readonly number[] | null {
  const parent = spaceScene.scene.getObjectByName(id)?.parent;
  if (parent === null || parent === undefined) return null;
  return [parent.quaternion.x, parent.quaternion.y, parent.quaternion.z, parent.quaternion.w];
}

globalThis.__visualTierHarness = {
  stepEarthDistance(distanceKm, nowMs, simTimeSec = 0) {
    aimAt(0, 0, 0, distanceKm);
    return updateAndRender('earth', nowMs, simTimeSec);
  },
  stepPlutoDistance(distanceKm, nowMs, simTimeSec = 0) {
    aimAt(2 * AU_KM, 10 * AU_KM, 0, distanceKm);
    return updateAndRender('pluto', nowMs, simTimeSec);
  },
  stepSaturnDistance(distanceKm, nowMs, simTimeSec = 0) {
    aimAt(SATURN_POSITION_KM.x, SATURN_POSITION_KM.y, SATURN_POSITION_KM.z, distanceKm);
    return updateAndRender('saturn', nowMs, simTimeSec);
  },
  renderEarthDarkControl(nowMs) {
    positionsKm[4] = -10 * AU_KM;
    const snapshot = updateAndRender('earth', nowMs, 0);
    positionsKm[4] = 0;
    return snapshot;
  },
  snapshotState(id) {
    return stateWithoutPixels(id);
  },
  silhouette() {
    return silhouetteMetrics();
  },
  attitude(id) {
    visualSystem.readAttitudeInto(publishedAttitude, id);
    const spinAngleRad = visualSystem.getSpinAngleRad(id);
    writeBodyAttitudeInto(attitudeScratch, 0, definitionFor(id).axialTiltRad, spinAngleRad);
    const cloudMesh = spaceScene.scene.getObjectByName('earth_clouds');
    return {
      quaternion: Array.from(publishedAttitude),
      spinAngleRad,
      expected: Array.from(attitudeScratch),
      sphereQuaternion: quaternionOf(`${id}-sphere-fallback`) ?? [],
      modelQuaternion: modelRootQuaternion(id),
      cloudRotationY: id === 'earth' && cloudMesh !== undefined ? cloudMesh.rotation.y : null,
    };
  },
  radii(id) {
    return {
      equatorialKm: visualSystem.getEquatorialRadiusKm(id),
      polarKm: visualSystem.getPolarRadiusKm(id),
    };
  },
  setRingsVisible(visible) {
    spaceScene.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some((material) => /rings?/iu.test(material.name))) object.visible = visible;
    });
  },
  stress(iterations) {
    if (!Number.isInteger(iterations) || iterations <= 0) {
      throw new RangeError('Visual-tier stress iterations must be a positive integer.');
    }
    const performanceWithMemory = performance as Performance & {
      readonly memory?: { readonly usedJSHeapSize: number };
    };
    const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    collectGarbage?.();
    collectGarbage?.();
    const beforeHeap = performanceWithMemory.memory?.usedJSHeapSize ?? null;
    for (let index = 0; index < iterations; index += 1) {
      visualSystem.update(
        cameraPositionKm,
        VIEWPORT_SIZE,
        VERTICAL_FOV_RAD,
        100_000 + index,
        index * 37.5,
      );
    }
    collectGarbage?.();
    collectGarbage?.();
    const afterHeap = performanceWithMemory.memory?.usedJSHeapSize ?? null;
    return {
      heapDeltaBytes: beforeHeap === null || afterHeap === null ? null : afterHeap - beforeHeap,
    };
  },
};
