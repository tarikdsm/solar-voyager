import { WebGLRenderTarget, WebGLRenderer } from 'three';

import { loadAssetManifest } from '../../src/render/assetManifest.js';
import { BodyAssetLoader } from '../../src/render/bodyAssetLoader.js';
import { BodyPointCloud } from '../../src/render/bodyPointCloud.js';
import type { BodyModelLoadState } from '../../src/render/bodyVisualSystem.js';
import { ShipVisual, SHIP_BOUNDING_RADIUS_KM } from '../../src/render/shipVisual.js';
import { SolarLighting } from '../../src/render/solarLighting.js';
import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';
import { writeQuaternionFromForwardInto } from '../../src/sim/ship/attitude.js';

const AU_KM = 149_597_870.7;
const SOLAR_RADIUS_KM = 695_700;
const SUN_INDEX = 0;
const SHIP_INDEX = 1;
const VIEWPORT_SIZE = 256;
const VERTICAL_FOV_RAD = Math.PI / 3;
const SAMPLE_MIN = 64;
const SAMPLE_MAX = 192;

/** Camera side relative to the Sun: `sunward` sees the lit face. */
export type ShipViewSide = 'sunward' | 'antisunward';

interface ShipVisualSnapshot {
  readonly loadState: BodyModelLoadState;
  readonly resolved: boolean;
  readonly diameterPx: number;
  readonly pointOpacity: number;
  readonly modelOpacity: number;
  readonly noseAlignment: number;
  readonly noseNodeAlignment: number;
  readonly litPixels: number;
  readonly meanLuminance: number;
  readonly maximumLuminance: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly glError: number;
}

interface ShipVisualHarness {
  setForward(x: number, y: number, z: number): void;
  step(distanceKm: number, side: ShipViewSide, nowMs: number): ShipVisualSnapshot;
  snapshotState(): Omit<
    ShipVisualSnapshot,
    'litPixels' | 'meanLuminance' | 'maximumLuminance' | 'drawCalls' | 'triangles' | 'glError'
  >;
  distanceForDiameterPx(diameterPx: number): number;
}

declare global {
  var __shipVisualHarness: ShipVisualHarness | undefined;
}

const canvas = document.querySelector('#ship-visual-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Ship visual canvas is missing.');

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
spaceScene.camera.updateProjectionMatrix();

// Sun at the origin, ship one astronomical unit along +X: the same photometric
// geometry the epoch world puts the ship in at LEO, without a planet in frame.
const positionsKm = new Float64Array([0, 0, 0, AU_KM, 0, 0]);
const shipStateKm = new Float64Array([AU_KM, 0, 0, 0, 0, 0, 0]);
const attitudeQuaternion = new Float64Array(4);
const cameraPositionKm = { x: AU_KM, y: 0, z: 0 };
// Broadside by default: the camera looks along the X axis, so a nose pointing
// along +Y presents the full hull silhouette instead of a nose-on cross section.
writeQuaternionFromForwardInto(attitudeQuaternion, 0, 1, 0);

const pointCloud = new BodyPointCloud(new Uint32Array([0xff_f4_d6, 0xdf_e6_ef]));
spaceScene.bindPackedPointPositions(pointCloud.points, positionsKm);
// This fixture has no body visual system, so nothing owns the Sun's slot. Blank
// it once: an unwritten point defaults to a visible white dot, and the
// anti-sunward view looks straight at it.
pointCloud.writeAppearance(SUN_INDEX, 0, 0, 0);
pointCloud.commitAppearance();
const lighting = new SolarLighting(
  spaceScene,
  positionsKm,
  SUN_INDEX * 3,
  SHIP_INDEX * 3,
  SOLAR_RADIUS_KM,
);

const manifest = await loadAssetManifest(`${import.meta.env.BASE_URL}assets/manifest.json`);
const assetLoader = new BodyAssetLoader(renderer, manifest);
const shipVisual = new ShipVisual({
  spaceScene,
  pointCloud,
  positionsKm,
  shipIndex: SHIP_INDEX,
  sunIndex: SUN_INDEX,
  assetLoader,
  compileModel: async (root) => {
    await renderer.compileAsync(root, spaceScene.camera, spaceScene.scene);
  },
});
shipVisual.writeState(shipStateKm, attitudeQuaternion);

const renderTarget = new WebGLRenderTarget(VIEWPORT_SIZE, VIEWPORT_SIZE);
const pixels = new Uint8Array(VIEWPORT_SIZE * VIEWPORT_SIZE * 4);

function distanceForDiameterPx(diameterPx: number): number {
  const angularDiameterRad = (diameterPx * VERTICAL_FOV_RAD) / VIEWPORT_SIZE;
  return SHIP_BOUNDING_RADIUS_KM / Math.sin(angularDiameterRad / 2);
}

function stateWithoutPixels(): Omit<
  ShipVisualSnapshot,
  'litPixels' | 'meanLuminance' | 'maximumLuminance' | 'drawCalls' | 'triangles' | 'glError'
> {
  return {
    loadState: shipVisual.loadState,
    resolved: shipVisual.resolved,
    diameterPx: shipVisual.diameterPx,
    pointOpacity: shipVisual.pointOpacity,
    modelOpacity: shipVisual.modelOpacity,
    noseAlignment: shipVisual.noseAlignment,
    noseNodeAlignment: shipVisual.noseNodeAlignment,
  };
}

function renderSnapshot(): ShipVisualSnapshot {
  renderer.info.reset();
  renderer.setRenderTarget(renderTarget);
  renderer.clear();
  renderer.render(spaceScene.scene, spaceScene.camera);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, VIEWPORT_SIZE, VIEWPORT_SIZE, pixels);
  renderer.setRenderTarget(null);

  let litPixels = 0;
  let luminanceSum = 0;
  let maximumLuminance = 0;
  let sampleCount = 0;
  for (let y = SAMPLE_MIN; y < SAMPLE_MAX; y += 1) {
    for (let x = SAMPLE_MIN; x < SAMPLE_MAX; x += 1) {
      const offset = (y * VIEWPORT_SIZE + x) * 4;
      const luminance =
        0.2126 * (pixels[offset] ?? 0) +
        0.7152 * (pixels[offset + 1] ?? 0) +
        0.0722 * (pixels[offset + 2] ?? 0);
      if (luminance > 0) litPixels += 1;
      luminanceSum += luminance;
      maximumLuminance = Math.max(maximumLuminance, luminance);
      sampleCount += 1;
    }
  }

  const snapshot = {
    ...stateWithoutPixels(),
    litPixels,
    meanLuminance: luminanceSum / sampleCount,
    maximumLuminance,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    glError: renderer.getContext().getError(),
  };
  // Repeat the frame onto the visible canvas so the fixture can be inspected and
  // screenshotted; the measured counters above are already captured.
  renderer.render(spaceScene.scene, spaceScene.camera);
  return snapshot;
}

globalThis.__shipVisualHarness = {
  setForward(x, y, z) {
    writeQuaternionFromForwardInto(attitudeQuaternion, x, y, z);
    shipVisual.writeState(shipStateKm, attitudeQuaternion);
  },
  step(distanceKm, side, nowMs) {
    const sunward = side === 'sunward';
    cameraPositionKm.x = AU_KM + (sunward ? -distanceKm : distanceKm);
    cameraPositionKm.y = 0;
    cameraPositionKm.z = 0;
    spaceScene.camera.rotation.set(0, sunward ? -Math.PI / 2 : Math.PI / 2, 0);
    spaceScene.camera.updateMatrix();
    spaceScene.camera.updateMatrixWorld(true);

    shipVisual.writeState(shipStateKm, attitudeQuaternion);
    shipVisual.update(cameraPositionKm, VIEWPORT_SIZE, VERTICAL_FOV_RAD, nowMs);
    lighting.update();
    spaceScene.updateCameraRelative(cameraPositionKm);
    return renderSnapshot();
  },
  snapshotState() {
    return stateWithoutPixels();
  },
  distanceForDiameterPx,
};
