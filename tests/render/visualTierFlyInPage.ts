import { AmbientLight, DirectionalLight, WebGLRenderTarget, WebGLRenderer } from 'three';

import { loadAssetManifest } from '../../src/render/assetManifest.js';
import { BodyAssetLoader } from '../../src/render/bodyAssetLoader.js';
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
const VIEWPORT_SIZE = 256;
const VERTICAL_FOV_RAD = Math.PI / 3;
const TARGET_SAMPLE_MIN = 96;
const TARGET_SAMPLE_MAX = 160;

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
  stepEarthDistance(distanceKm: number, nowMs: number): VisualTierSnapshot;
  stepPlutoDistance(distanceKm: number, nowMs: number): VisualTierSnapshot;
  renderEarthDarkControl(nowMs: number): VisualTierSnapshot;
  snapshotState(id: string): Omit<VisualTierSnapshot, 'litPixels' | 'glError'>;
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
    meanRadiusKm: PLUTO_RADIUS_KM,
    muKm3S2: 869.3,
    polarRadiusRatio: 1,
    geometricAlbedo: 0.3,
    albedoColor: 0xb7a28c,
    proceduralSeed: 999,
  },
];
const positionsKm = new Float64Array([-2 * AU_KM, 0, 0, 0, 0, 0, 2 * AU_KM, 10 * AU_KM, 0]);
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

function updateAndRender(id: string, nowMs: number): VisualTierSnapshot {
  visualSystem.update(cameraPositionKm, VIEWPORT_SIZE, VERTICAL_FOV_RAD, nowMs);
  spaceScene.updateCameraRelative(cameraPositionKm);
  return renderSnapshot(id);
}

globalThis.__visualTierHarness = {
  stepEarthDistance(distanceKm, nowMs) {
    cameraPositionKm.x = -distanceKm;
    cameraPositionKm.y = 0;
    cameraPositionKm.z = 0;
    spaceScene.camera.rotation.y = -Math.PI / 2;
    spaceScene.camera.updateMatrix();
    return updateAndRender('earth', nowMs);
  },
  stepPlutoDistance(distanceKm, nowMs) {
    cameraPositionKm.x = 2 * AU_KM - distanceKm;
    cameraPositionKm.y = 10 * AU_KM;
    cameraPositionKm.z = 0;
    spaceScene.camera.rotation.y = -Math.PI / 2;
    spaceScene.camera.updateMatrix();
    return updateAndRender('pluto', nowMs);
  },
  renderEarthDarkControl(nowMs) {
    positionsKm[4] = -10 * AU_KM;
    const snapshot = updateAndRender('earth', nowMs);
    positionsKm[4] = 0;
    return snapshot;
  },
  snapshotState(id) {
    return stateWithoutPixels(id);
  },
};
