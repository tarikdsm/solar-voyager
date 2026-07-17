import { h, render } from 'preact';

import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
} from './game/createNewGameSimulation.js';
import { KeyboardCommandMapper, type KeyboardInputTarget } from './game/inputMapping.js';
import { SaveRepository } from './game/saveLoad.js';
import { GameSessionController } from './game/sessionController.js';
import { SettingsRepository, type KeyValueStorage } from './game/settings.js';
import { createEpochWorld, type EpochWorld } from './render/createEpochWorld.js';
import { createRenderer } from './render/createRenderer.js';
import { calculateDrawingBufferDimension } from './render/drawingBufferSize.js';
import { LightingPostPipeline } from './render/lightingPostPipeline.js';
import { RenderTelemetry, exposeRenderTelemetry } from './render/telemetry.js';
import type { Commands } from './sim/simulationSnapshot.js';
import './style.css';
import { App } from './ui/App.js';
import { CameraInputController } from './ui/cameraInputController.js';
import { createPerfPanelStore } from './ui/hud/perfPanelStore.js';
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
const perfQualityState = {
  governorState: 'Awaiting adaptive governor',
  lastAction: 'None',
  renderScale: 1,
  tier: 6,
  tierCount: 6,
};
const perfPanelStore = createPerfPanelStore({
  quality: perfQualityState,
  resolution: canvas,
  telemetry,
});
const initialSimulation = createNewGameSimulation(SHIP_MASS_KG);
const hudStore = createHudSignalStore();
hudStore.publish(initialSimulation.snapshot, 0);
const hardwareWarning = contextReport.warningRequired
  ? { rendererName: contextReport.rendererName }
  : null;
const resizeListenerOptions: AddEventListenerOptions = { passive: true };
let world: EpochWorld | null = null;
let postPipeline: LightingPostPipeline | null = null;
let cameraInput: CameraInputController | null = null;
let commandInput: KeyboardCommandMapper | null = null;
const browserStorage: KeyValueStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};
const session = new GameSessionController({
  initialSimulation,
  saveRepository: new SaveRepository(browserStorage, SHIP_MASS_KG),
  settingsRepository: new SettingsRepository(browserStorage),
  createSimulation: (state) => createGameSimulationFromPersistentState(SHIP_MASS_KG, state),
  onSimulationReplaced: (replacement) => {
    hudStore.publish(replacement.snapshot, performance.now());
  },
  onSettingsChanged: (settings, origin) => {
    if (origin === 'restore') commandInput?.restoreBindings(settings.inputBindings);
    else commandInput?.updateBindings(settings.inputBindings);
  },
});

function currentInputSnapshot() {
  return session.simulation.snapshot;
}

const sessionCommands: Commands = {
  rotate: (pitchRateRadS, yawRateRadS, rollRateRadS) =>
    session.simulation.commands.rotate(pitchRateRadS, yawRateRadS, rollRateRadS),
  setAttitudeMode: (mode) => session.simulation.commands.setAttitudeMode(mode),
  setTarget: (bodyId) => session.simulation.commands.setTarget(bodyId),
  setThrottle: (fraction) => session.simulation.commands.setThrottle(fraction),
  setWarp: (warp) => session.simulation.commands.setWarp(warp),
};

commandInput = new KeyboardCommandMapper(
  window as unknown as KeyboardInputTarget,
  sessionCommands,
  currentInputSnapshot,
  session.settings.inputBindings,
);

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
    proceduralSun,
    osculatingConic,
    cameraController,
    cameraPositionKm,
  } = world;
  const deltaSec = telemetry.beginFrame(nowMs);
  const simulationStartMs = performance.now();
  commandInput?.update();
  const snapshot = session.simulation.step(deltaSec);
  world.positionsKm.set(snapshot.bodyPositionsKm);
  proceduralSun.update(snapshot.simTimeSec);
  const simulationEndMs = performance.now();
  const uiStartMs = simulationEndMs;
  hudStore.publish(snapshot, nowMs);
  const hudEndMs = performance.now();
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
  const renderEndMs = performance.now();
  const perfPanelStartMs = performance.now();
  perfPanelStore.publish(nowMs);
  const perfPanelEndMs = performance.now();
  telemetry.endFrame(
    simulationEndMs - simulationStartMs,
    renderEndMs - renderStartMs,
    hudEndMs - uiStartMs + (perfPanelEndMs - perfPanelStartMs),
    nowMs,
  );
  requestAnimationFrame(renderFrame);
}

async function startApplication(): Promise<void> {
  render(
    h(App, {
      bodyIds: session.simulation.snapshot.bodyIds,
      commands: sessionCommands,
      hardwareWarning,
      hud: hudStore.display,
      hudState: hudStore.signals,
      perfPanel: perfPanelStore,
      session,
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
