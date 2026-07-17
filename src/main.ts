import { h, render } from 'preact';

import { createEpochWorld, type EpochWorld } from './render/createEpochWorld.js';
import { createRenderer } from './render/createRenderer.js';
import { calculateDrawingBufferDimension } from './render/drawingBufferSize.js';
import { RenderTelemetry, exposeRenderTelemetry } from './render/telemetry.js';
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
const rendererBootstrap = createRenderer(canvas);
const { contextReport, renderer } = rendererBootstrap;
const telemetry = new RenderTelemetry(renderer, contextReport);
exposeRenderTelemetry(canvas, telemetry);
const hardwareWarning = contextReport.warningRequired
  ? { rendererName: contextReport.rendererName }
  : null;
const resizeListenerOptions: AddEventListenerOptions = { passive: true };
let world: EpochWorld | null = null;
let cameraInput: CameraInputController | null = null;

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
  const deltaSec = telemetry.beginFrame(nowMs);
  const renderStartMs = performance.now();
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
  telemetry.beginGpuTimer();
  renderer.render(spaceScene.scene, spaceScene.camera);
  telemetry.endGpuTimer();
  telemetry.endFrame(0, performance.now() - renderStartMs, 0, nowMs);
  requestAnimationFrame(renderFrame);
}

async function startApplication(): Promise<void> {
  render(h(App, { hardwareWarning }), appRoot);
  canvas.dataset.depthStrategy = contextReport.depthStrategy;
  canvas.dataset.rendererName = contextReport.rendererName;
  canvas.dataset.rendererReady = 'true';
  canvas.dataset.softwareRasterizer = String(contextReport.softwareRasterizer);
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
