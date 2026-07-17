import { h, render } from 'preact';

import { createNewGameSimulation } from './game/createNewGameSimulation.js';
import { createEpochWorld, type EpochWorld } from './render/createEpochWorld.js';
import { createRenderer } from './render/createRenderer.js';
import { calculateDrawingBufferDimension } from './render/drawingBufferSize.js';
import { LightingPostPipeline } from './render/lightingPostPipeline.js';
import { RenderTelemetry, exposeRenderTelemetry } from './render/telemetry.js';
import './style.css';
import { App } from './ui/App.js';
import { CameraInputController } from './ui/cameraInputController.js';
import { createHudSignalStore } from './ui/hudSignals.js';

const SHIP_MASS_KG = 10_000;
const SOFTWARE_FALLBACK_EXPOSURE = 3;

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
const postProcessingEnabled = !contextReport.softwareRasterizer;
const telemetry = new RenderTelemetry(renderer, contextReport);
exposeRenderTelemetry(canvas, telemetry);
const simulation = createNewGameSimulation(SHIP_MASS_KG);
const hudStore = createHudSignalStore();
hudStore.publish(simulation.snapshot, 0);
const hardwareWarning = contextReport.warningRequired
  ? { rendererName: contextReport.rendererName }
  : null;
const resizeListenerOptions: AddEventListenerOptions = { passive: true };
let world: EpochWorld | null = null;
let postPipeline: LightingPostPipeline | null = null;
let cameraInput: CameraInputController | null = null;

function resizeRenderer(): void {
  const clientWidth = canvas.clientWidth;
  const clientHeight = canvas.clientHeight;
  const pixelRatio = renderer.getPixelRatio();
  const drawingBufferWidth = calculateDrawingBufferDimension(clientWidth, pixelRatio);
  const drawingBufferHeight = calculateDrawingBufferDimension(clientHeight, pixelRatio);

  if (canvas.width !== drawingBufferWidth || canvas.height !== drawingBufferHeight) {
    renderer.setSize(clientWidth, clientHeight, false);
  }
  if (world !== null) {
    world.spaceScene.camera.aspect = clientWidth / clientHeight;
    world.spaceScene.camera.updateProjectionMatrix();
    postPipeline?.resize(clientWidth, clientHeight, pixelRatio);
  }
}

function renderFrame(nowMs: number): void {
  if (world === null || postPipeline === null) return;
  const {
    spaceScene,
    visualSystem,
    lighting,
    osculatingConic,
    cameraController,
    cameraPositionKm,
  } = world;
  const deltaSec = telemetry.beginFrame(nowMs);
  const simulationStartMs = performance.now();
  const snapshot = simulation.step(deltaSec);
  world.positionsKm.set(snapshot.bodyPositionsKm);
  const simulationEndMs = performance.now();
  const uiStartMs = simulationEndMs;
  hudStore.publish(snapshot, nowMs);
  const uiEndMs = performance.now();
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
  lighting.setFocusPositionOffset(cameraController.focusPositionOffset);
  lighting.update();
  osculatingConic.update(snapshot, canvas.width, canvas.height);
  spaceScene.updateCameraRelative(cameraPositionKm);
  telemetry.beginGpuTimer();
  postPipeline.render(postProcessingEnabled);
  telemetry.endGpuTimer();
  telemetry.endFrame(
    simulationEndMs - simulationStartMs,
    performance.now() - renderStartMs,
    uiEndMs - uiStartMs,
    nowMs,
  );
  requestAnimationFrame(renderFrame);
}

async function startApplication(): Promise<void> {
  render(
    h(App, {
      bodyIds: simulation.snapshot.bodyIds,
      commands: simulation.commands,
      hardwareWarning,
      hud: hudStore.display,
      hudState: hudStore.signals,
    }),
    appRoot,
  );
  canvas.dataset.depthStrategy = contextReport.depthStrategy;
  canvas.dataset.rendererName = contextReport.rendererName;
  canvas.dataset.rendererReady = 'true';
  canvas.dataset.softwareRasterizer = String(contextReport.softwareRasterizer);
  resizeRenderer();
  world = await createEpochWorld(renderer, { initialViewportHeightPx: canvas.height });
  postPipeline = new LightingPostPipeline(
    renderer,
    world.spaceScene.scene,
    world.spaceScene.camera,
  );
  postPipeline.setBloomEnabled(postProcessingEnabled);
  if (!postProcessingEnabled) renderer.toneMappingExposure = SOFTWARE_FALLBACK_EXPOSURE;
  resizeRenderer();
  world.lighting.update();
  world.spaceScene.updateCameraRelative(world.cameraPositionKm);
  postPipeline.warmUp(postProcessingEnabled);
  const focusLabel = document.querySelector('#camera-focus-label');
  if (!(focusLabel instanceof HTMLElement)) {
    throw new Error('Solar Voyager camera focus label was not found.');
  }
  cameraInput?.dispose();
  cameraInput = new CameraInputController(canvas, window, focusLabel, world.cameraController);
  canvas.dataset.cameraReady = 'true';
  window.addEventListener('resize', resizeRenderer, resizeListenerOptions);
  requestAnimationFrame(renderFrame);
}

void startApplication().catch((cause: unknown) => {
  throw new Error('Solar Voyager failed to initialize the epoch world.', { cause });
});
