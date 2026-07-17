import { render } from 'preact';

import { createEpochWorld, type EpochWorld } from './render/createEpochWorld.js';
import { createRenderer } from './render/createRenderer.js';
import { calculateDrawingBufferDimension } from './render/drawingBufferSize.js';
import './style.css';
import { App } from './ui/App.js';
import { CameraInputController } from './ui/cameraInputController.js';

const canvasElement = document.querySelector('#space-canvas');
const appElement = document.querySelector('#app');

if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('Solar Voyager canvas was not found.');
}

if (!(appElement instanceof HTMLElement)) {
  throw new Error('Solar Voyager application root was not found.');
}

const canvas = canvasElement;
const appRoot = appElement;
const renderer = createRenderer(canvas);
const resizeListenerOptions: AddEventListenerOptions = { passive: true };
let world: EpochWorld | null = null;
let cameraInput: CameraInputController | null = null;
let previousFrameTimeMs = 0;

function resizeRenderer(): void {
  if (world === null) return;
  const clientWidth = canvas.clientWidth;
  const clientHeight = canvas.clientHeight;
  const pixelRatio = renderer.getPixelRatio();
  const drawingBufferWidth = calculateDrawingBufferDimension(clientWidth, pixelRatio);
  const drawingBufferHeight = calculateDrawingBufferDimension(clientHeight, pixelRatio);

  if (canvas.width !== drawingBufferWidth || canvas.height !== drawingBufferHeight) {
    renderer.setSize(clientWidth, clientHeight, false);
    world.spaceScene.camera.aspect = clientWidth / clientHeight;
    world.spaceScene.camera.updateProjectionMatrix();
  }
}

function renderFrame(nowMs: number): void {
  if (world === null) return;
  const { spaceScene, visualSystem, cameraController, cameraPositionKm } = world;
  const deltaSec =
    previousFrameTimeMs === 0 ? 0 : Math.min(0.1, (nowMs - previousFrameTimeMs) / 1_000);
  previousFrameTimeMs = nowMs;
  cameraController.update(deltaSec);
  spaceScene.camera.lookAt(
    cameraController.lookDirection.x,
    cameraController.lookDirection.y,
    cameraController.lookDirection.z,
  );
  spaceScene.camera.updateMatrix();
  visualSystem.update(
    cameraPositionKm,
    canvas.height,
    spaceScene.camera.fov * (Math.PI / 180),
    nowMs,
  );
  spaceScene.updateCameraRelative(cameraPositionKm);
  renderer.render(spaceScene.scene, spaceScene.camera);
  requestAnimationFrame(renderFrame);
}

async function startApplication(): Promise<void> {
  render(App(), appRoot);
  world = await createEpochWorld(renderer);
  const focusLabel = document.querySelector('#camera-focus-label');
  if (!(focusLabel instanceof HTMLElement)) {
    throw new Error('Solar Voyager camera focus label was not found.');
  }
  cameraInput?.dispose();
  cameraInput = new CameraInputController(canvas, window, focusLabel, world.cameraController);
  canvas.dataset.cameraReady = 'true';
  resizeRenderer();
  window.addEventListener('resize', resizeRenderer, resizeListenerOptions);
  requestAnimationFrame(renderFrame);
}

void startApplication().catch((cause: unknown) => {
  throw new Error('Solar Voyager failed to initialize the epoch world.', { cause });
});
