import { h, render } from 'preact';

import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
} from './game/createNewGameSimulation.js';
import { KeyboardCommandMapper, type KeyboardInputTarget } from './game/inputMapping.js';
import { SaveRepository } from './game/saveLoad.js';
import { GameSessionController } from './game/sessionController.js';
import { SettingsRepository, type KeyValueStorage } from './game/settings.js';
import { readTrajectoryEventSummary } from './game/trajectoryPredictionModel.js';
import {
  createTrajectoryPredictorClient,
  type TrajectoryPredictorClient,
} from './game/trajectoryPredictorClient.js';
import { TrajectoryPredictionRefresh } from './game/trajectoryPredictionRefresh.js';
import {
  isTrajectoryPredictionRuntimeEnabled,
  readTrajectoryPredictionTestHorizonSec,
  readTrajectoryPredictionTestPointCount,
} from './game/trajectoryPredictionRuntimePolicy.js';
import { createEpochWorld, type EpochWorld } from './render/createEpochWorld.js';
import { createRenderer } from './render/createRenderer.js';
import { calculateDrawingBufferDimension } from './render/drawingBufferSize.js';
import { LightingPostPipeline } from './render/lightingPostPipeline.js';
import { RenderTelemetry, exposeRenderTelemetry } from './render/telemetry.js';
import { PerfGovernor, createPerfQualityState } from './render/perfGovernor.js';
import { RenderQualityController } from './render/renderQualityController.js';
import { RelativisticVisualController } from './render/relativisticVisualController.js';
import { StateVectorWidget } from './render/stateVectorWidget.js';
import type { Commands } from './sim/simulationSnapshot.js';
import type { PredictorResponseMessage } from './workers/predictorProtocol.js';
import './style.css';
import { App } from './ui/App.js';
import { CameraInputController } from './ui/cameraInputController.js';
import { createPerfPanelStore } from './ui/hud/perfPanelStore.js';
import { createHudSignalStore } from './ui/hudSignals.js';
import { createStateVectorSignalStore } from './ui/stateVectorSignals.js';
import { observeStateVectorLayout } from './ui/stateVectorLayoutObserver.js';
import { createTrajectoryPredictionSignalStore } from './ui/trajectoryPredictionSignals.js';
import {
  STATE_VECTOR_VIEWPORT_COMPONENT_COUNT,
  writeStateVectorViewportPixelsInto,
} from './ui/stateVectorViewport.js';

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
const perfQualityState = createPerfQualityState();
const perfPanelStore = createPerfPanelStore({
  quality: perfQualityState,
  resolution: canvas,
  telemetry,
});
const trajectoryPredictionStore = createTrajectoryPredictionSignalStore();
const trajectoryPredictionRefresh = new TrajectoryPredictionRefresh();
let trajectoryPredictorClient: TrajectoryPredictorClient | null = null;
let trajectoryPredictionPending = false;

function invalidateTrajectoryPrediction(): void {
  trajectoryPredictionPending = true;
  trajectoryPredictorClient?.invalidate();
}

function invalidateTrajectoryPredictionForWarpElapsed(): void {
  trajectoryPredictionPending = true;
  trajectoryPredictorClient?.invalidateForWarpElapsed();
}

const initialSimulation = createNewGameSimulation(SHIP_MASS_KG, invalidateTrajectoryPrediction);
const hudStore = createHudSignalStore();
hudStore.publish(initialSimulation.snapshot, 0);
const stateVectorStore = createStateVectorSignalStore();
stateVectorStore.publish(initialSimulation.snapshot, 0);
const hardwareWarning = contextReport.warningRequired
  ? { rendererName: contextReport.rendererName }
  : null;
const resizeListenerOptions: AddEventListenerOptions = { passive: true };
let world: EpochWorld | null = null;
let postPipeline: LightingPostPipeline | null = null;
let cameraInput: CameraInputController | null = null;
let commandInput: KeyboardCommandMapper | null = null;
let perfGovernor: PerfGovernor | null = null;
let relativisticVisuals: RelativisticVisualController | null = null;
let stateVectorWidget: StateVectorWidget | null = null;
let stateVectorViewportElement: HTMLDivElement | null = null;
let disposeStateVectorLayoutObservation: (() => void) | null = null;
const stateVectorViewportPixels = new Float64Array(STATE_VECTOR_VIEWPORT_COMPONENT_COUNT);
const browserStorage: KeyValueStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};
const session = new GameSessionController({
  initialSimulation,
  createNewSimulation: () => createNewGameSimulation(SHIP_MASS_KG, invalidateTrajectoryPrediction),
  saveRepository: new SaveRepository(browserStorage, SHIP_MASS_KG),
  settingsRepository: new SettingsRepository(browserStorage),
  createSimulation: (state) =>
    createGameSimulationFromPersistentState(SHIP_MASS_KG, state, invalidateTrajectoryPrediction),
  onSimulationReplaced: (replacement) => {
    hudStore.publish(replacement.snapshot, performance.now());
    world?.trajectoryOverlay.hide();
    trajectoryPredictionRefresh.clear();
    invalidateTrajectoryPrediction();
  },
  onSettingsChanged: (settings, origin) => {
    if (origin === 'restore') commandInput?.restoreBindings(settings.inputBindings);
    else commandInput?.updateBindings(settings.inputBindings);
    perfGovernor?.setLock(settings.qualityLock, performance.now());
  },
});

function handleTrajectoryPredictionResult(result: PredictorResponseMessage): void {
  trajectoryPredictionPending = false;
  if (result.type === 'error') {
    world?.trajectoryOverlay.hide();
    trajectoryPredictionRefresh.clear();
    trajectoryPredictionStore.publishError();
    canvas.dataset.trajectoryReady = 'error';
    return;
  }
  const snapshot = session.simulation.snapshot;
  try {
    world?.trajectoryOverlay.applyPrediction(result, snapshot.dominantBodyIndex);
    trajectoryPredictionRefresh.acceptPrediction(result.points);
    trajectoryPredictionStore.publishSuccess(
      readTrajectoryEventSummary(result.events),
      snapshot.bodyIds,
      snapshot.simTimeSec,
    );
    canvas.dataset.trajectoryReady = 'true';
  } catch {
    world?.trajectoryOverlay.hide();
    trajectoryPredictionRefresh.clear();
    trajectoryPredictionStore.publishError();
    canvas.dataset.trajectoryReady = 'error';
  }
}

if (isTrajectoryPredictionRuntimeEnabled(window)) {
  const testHorizonSec = readTrajectoryPredictionTestHorizonSec(window);
  const testPointCount = readTrajectoryPredictionTestPointCount(window);
  const trajectoryWorker = new Worker(new URL('./workers/predictor.worker.ts', import.meta.url), {
    type: 'module',
  });
  trajectoryPredictorClient = createTrajectoryPredictorClient(
    trajectoryWorker,
    initialSimulation.snapshot.bodyIds.length,
    handleTrajectoryPredictionResult,
    {
      ownsPort: true,
      ...(testHorizonSec === undefined ? {} : { testHorizonSec }),
      ...(testPointCount === undefined ? {} : { testPointCount }),
    },
  );
}

function handlePageHide(event: PageTransitionEvent): void {
  if (!event.persisted) trajectoryPredictorClient?.dispose();
}

window.addEventListener('pagehide', handlePageHide);

function currentInputSnapshot() {
  return session.simulation.snapshot;
}

function updateStateVectorViewport(): void {
  if (stateVectorWidget === null || stateVectorViewportElement === null) return;
  const canvasRect = canvas.getBoundingClientRect();
  if (canvasRect.width <= 0 || canvasRect.height <= 0) {
    stateVectorWidget.setViewportPixels(0, 0, 0, 0);
    return;
  }
  writeStateVectorViewportPixelsInto(
    stateVectorViewportPixels,
    canvasRect,
    stateVectorViewportElement.getBoundingClientRect(),
    canvas.width,
    canvas.height,
  );
  stateVectorWidget.setViewportPixels(
    stateVectorViewportPixels[0] as number,
    stateVectorViewportPixels[1] as number,
    stateVectorViewportPixels[2] as number,
    stateVectorViewportPixels[3] as number,
  );
}

function setStateVectorViewportElement(element: HTMLDivElement | null): void {
  stateVectorViewportElement = element;
  updateStateVectorViewport();
}

const sessionCommands: Commands = {
  rotate: (pitchRateRadS, yawRateRadS, rollRateRadS) =>
    session.simulation.commands.rotate(pitchRateRadS, yawRateRadS, rollRateRadS),
  setAttitudeMode: (mode) => session.simulation.commands.setAttitudeMode(mode),
  setTarget: (bodyId) => {
    session.simulation.commands.setTarget(bodyId);
    invalidateTrajectoryPrediction();
  },
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
    world.trajectoryOverlay.setViewport(
      Math.max(1, canvas.width),
      Math.max(1, canvas.height),
      pixelRatio,
    );
    updateStateVectorViewport();
  }
}

function renderFrame(nowMs: number): void {
  if (
    world === null ||
    postPipeline === null ||
    relativisticVisuals === null ||
    stateVectorWidget === null
  ) {
    return;
  }
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
  if (trajectoryPredictionPending) {
    trajectoryPredictionStore.publishPending(snapshot.targetBodyIndex);
    canvas.dataset.trajectoryReady = 'pending';
    trajectoryPredictionPending = false;
  }
  trajectoryPredictionStore.publishTime(snapshot.simTimeSec, nowMs);
  trajectoryPredictionRefresh.update(
    snapshot.simTimeSec,
    invalidateTrajectoryPredictionForWarpElapsed,
  );
  trajectoryPredictorClient?.update(snapshot);
  const simulationEndMs = performance.now();
  const uiStartMs = simulationEndMs;
  hudStore.publish(snapshot, nowMs);
  stateVectorStore.publish(snapshot, nowMs);
  const hudEndMs = performance.now();
  const renderStartMs = performance.now();
  cameraController.update(deltaSec);
  spaceScene.camera.lookAt(
    cameraController.lookDirection.x,
    cameraController.lookDirection.y,
    cameraController.lookDirection.z,
  );
  spaceScene.camera.updateMatrix();
  spaceScene.camera.updateMatrixWorld(true);
  relativisticVisuals.update(snapshot, spaceScene.camera);
  stateVectorWidget.setPinnedToEcliptic(stateVectorStore.signals.pinnedToEcliptic.value);
  stateVectorWidget.update(snapshot, spaceScene.camera);
  visualSystem.update(
    cameraPositionKm,
    Math.max(1, canvas.clientHeight),
    spaceScene.camera.fov * (Math.PI / 180),
    nowMs,
    snapshot.simTimeSec,
  );
  lighting.setFocusPositionOffset(cameraController.focusPositionOffset);
  lighting.update();
  osculatingConic.update(snapshot, canvas.width, canvas.height);
  spaceScene.updateCameraRelative(cameraPositionKm);
  telemetry.beginGpuTimer();
  postPipeline.render(postProcessingEnabled);
  stateVectorWidget.render(renderer);
  telemetry.recordStateVectorWidgetMs(stateVectorWidget.lastRenderMs);
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
  perfGovernor?.update(nowMs, telemetry.snapshot);
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
      stateVectors: stateVectorStore,
      stateVectorViewportRef: setStateVectorViewportElement,
      trajectoryPrediction: trajectoryPredictionStore,
    }),
    appRoot,
  );
  const appOverlay = appRoot.querySelector('.app-overlay');
  if (!(appOverlay instanceof HTMLElement)) {
    throw new Error('Solar Voyager application overlay was not found.');
  }
  disposeStateVectorLayoutObservation?.();
  disposeStateVectorLayoutObservation = observeStateVectorLayout(
    appOverlay,
    updateStateVectorViewport,
  );
  canvas.dataset.depthStrategy = contextReport.depthStrategy;
  canvas.dataset.rendererName = contextReport.rendererName;
  canvas.dataset.rendererReady = 'true';
  canvas.dataset.softwareRasterizer = String(contextReport.softwareRasterizer);
  resizeRenderer();
  world = await createEpochWorld(renderer, {
    initialViewportHeightPx: Math.max(1, canvas.clientHeight),
  });
  stateVectorWidget = new StateVectorWidget();
  postPipeline = new LightingPostPipeline(
    renderer,
    world.spaceScene.scene,
    world.spaceScene.camera,
  );
  relativisticVisuals = new RelativisticVisualController({
    postPass: postPipeline.relativisticPass,
    spaceScene: world.spaceScene,
    starfield: world.starfield,
  });
  const qualityController = new RenderQualityController({
    assetLoader: world.visualSystem,
    pipeline: postPipeline,
    postProcessingAvailable: postProcessingEnabled,
    proceduralSun: world.proceduralSun,
    renderer,
    relativisticVisuals,
    starfield: world.starfield,
    visualSystem: world.visualSystem,
  });
  perfGovernor = new PerfGovernor({
    application: qualityController,
    initialLock: session.settings.qualityLock,
    state: perfQualityState,
    telemetry,
  });
  if (!postProcessingEnabled) renderer.toneMappingExposure = SOFTWARE_FALLBACK_EXPOSURE;
  resizeRenderer();
  world.lighting.update();
  world.spaceScene.updateCameraRelative(world.cameraPositionKm);
  postPipeline.warmUp(postProcessingEnabled);
  await stateVectorWidget.prepare(renderer);
  updateStateVectorViewport();
  const focusLabel = document.querySelector('#camera-focus-label');
  if (!(focusLabel instanceof HTMLElement)) {
    throw new Error('Solar Voyager camera focus label was not found.');
  }
  cameraInput?.dispose();
  cameraInput = new CameraInputController(canvas, window, focusLabel, world.cameraController);
  canvas.dataset.cameraReady = 'true';
  window.addEventListener('resize', resizeRenderer, resizeListenerOptions);
  window.addEventListener('scroll', updateStateVectorViewport, true);
  invalidateTrajectoryPrediction();
  requestAnimationFrame(renderFrame);
}

void startApplication().catch((cause: unknown) => {
  throw new Error('Solar Voyager failed to initialize the epoch world.', { cause });
});
