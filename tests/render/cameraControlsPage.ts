import { Mesh, MeshBasicMaterial, SphereGeometry, WebGLRenderer, WebGLRenderTarget } from 'three';

import {
  OrbitCameraController,
  type CameraFocusTarget,
} from '../../src/game/orbitCameraController.js';
import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';

const AU_KM = 149_597_870.7;
const EARTH_RADIUS_KM = 6_371.0084;
const JUPITER_RADIUS_KM = 69_911;
const VIEWPORT_SIZE = 256;

interface CameraFrameSnapshot {
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  readonly distanceKm: number;
  readonly earthRenderX: number;
  readonly earthRenderY: number;
  readonly earthRenderZ: number;
  readonly focusId: string;
  readonly focusX: number;
  readonly focusY: number;
  readonly focusZ: number;
  readonly glError: number;
  readonly litPixels: number;
  readonly pixelChecksum: number;
  readonly transitioning: boolean;
}

interface CameraControlsHarness {
  beginJupiterTransfer(): boolean;
  renderFrame(deltaSec: number): CameraFrameSnapshot;
  zoomByWheel(wheelDelta: number): void;
  zoomToEarthSurface(): CameraFrameSnapshot;
}

declare global {
  var __cameraControlsHarness: CameraControlsHarness | undefined;
}

const canvas = document.querySelector('#camera-controls-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Camera controls canvas is missing.');

const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_SIZE, VIEWPORT_SIZE, false);
renderer.setClearColor(0x000000, 1);

const positionsKm = new Float64Array([
  AU_KM,
  -20_000_000,
  1_000,
  5.2 * AU_KM,
  100_000_000,
  -5_000_000,
]);
const targets: readonly CameraFocusTarget[] = [
  { id: 'earth', positionOffset: 0, meanRadiusKm: EARTH_RADIUS_KM },
  { id: 'jupiter', positionOffset: 3, meanRadiusKm: JUPITER_RADIUS_KM },
];
const controller = new OrbitCameraController({
  positionsKm,
  targets,
  initialFocusId: 'earth',
  initialCameraPositionKm: {
    x: AU_KM + EARTH_RADIUS_KM + 400,
    y: -20_000_000,
    z: 1_000,
  },
});

const spaceScene = new CameraRelativeSpaceScene();
spaceScene.camera.aspect = 1;
spaceScene.camera.updateProjectionMatrix();
const earth = new Mesh(
  new SphereGeometry(EARTH_RADIUS_KM, 32, 16),
  new MeshBasicMaterial({ color: 0x3978c5 }),
);
const jupiter = new Mesh(
  new SphereGeometry(JUPITER_RADIUS_KM, 32, 16),
  new MeshBasicMaterial({ color: 0xd4a574 }),
);
spaceScene.bindPackedVisual(earth, positionsKm, 0);
spaceScene.bindPackedVisual(jupiter, positionsKm, 3);

const renderTarget = new WebGLRenderTarget(VIEWPORT_SIZE, VIEWPORT_SIZE);
const pixels = new Uint8Array(VIEWPORT_SIZE * VIEWPORT_SIZE * 4);

await renderer.compileAsync(spaceScene.scene, spaceScene.camera);

function renderFrame(deltaSec: number): CameraFrameSnapshot {
  controller.update(deltaSec);
  spaceScene.camera.lookAt(
    controller.lookDirection.x,
    controller.lookDirection.y,
    controller.lookDirection.z,
  );
  spaceScene.camera.updateMatrix();
  spaceScene.updateCameraRelative(controller.cameraPositionKm);
  renderer.setRenderTarget(renderTarget);
  renderer.clear();
  renderer.render(spaceScene.scene, spaceScene.camera);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, VIEWPORT_SIZE, VIEWPORT_SIZE, pixels);
  renderer.setRenderTarget(null);

  let litPixels = 0;
  let pixelChecksum = 2_166_136_261;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    if (red + green + blue > 0) litPixels += 1;
    pixelChecksum ^= red;
    pixelChecksum = Math.imul(pixelChecksum, 16_777_619);
    pixelChecksum ^= green;
    pixelChecksum = Math.imul(pixelChecksum, 16_777_619);
    pixelChecksum ^= blue;
    pixelChecksum = Math.imul(pixelChecksum, 16_777_619);
  }

  return {
    cameraX: controller.cameraPositionKm.x,
    cameraY: controller.cameraPositionKm.y,
    cameraZ: controller.cameraPositionKm.z,
    distanceKm: controller.distanceKm,
    earthRenderX: earth.position.x,
    earthRenderY: earth.position.y,
    earthRenderZ: earth.position.z,
    focusId: controller.focusId,
    focusX: controller.focusPositionKm.x,
    focusY: controller.focusPositionKm.y,
    focusZ: controller.focusPositionKm.z,
    glError: renderer.getContext().getError(),
    litPixels,
    pixelChecksum: pixelChecksum >>> 0,
    transitioning: controller.isTransitioning,
  };
}

globalThis.__cameraControlsHarness = {
  beginJupiterTransfer() {
    return controller.focusBody('jupiter');
  },
  renderFrame,
  zoomByWheel(wheelDelta) {
    controller.zoomByWheel(wheelDelta);
  },
  zoomToEarthSurface() {
    controller.zoomByWheel(-1_000_000);
    controller.orbitBy(0.731, 0.419);
    return renderFrame(0);
  },
};
