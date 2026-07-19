import { h, render } from 'preact';

import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
} from './game/createNewGameSimulation.js';
import { KeyboardCommandMapper, type KeyboardInputTarget } from './game/inputMapping.js';
import type { OrbitCameraController } from './game/orbitCameraController.js';
import { SaveRepository } from './game/saveLoad.js';
import { SceneManager } from './game/sceneManager.js';
import { GameSessionController } from './game/sessionController.js';
import { SettingsRepository, type KeyValueStorage } from './game/settings.js';
import { StartupTracker } from './game/startupTracker.js';
import { SystemMapController, type SystemMapMode } from './game/systemMapController.js';
import { TutorialController } from './game/tutorialController.js';
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
import {
  createEpochWorld,
  type EpochWorld,
  type EpochWorldMilestone,
} from './render/createEpochWorld.js';
import { createRenderer } from './render/createRenderer.js';
import { calculateDrawingBufferDimension } from './render/drawingBufferSize.js';
import { LightingPostPipeline } from './render/lightingPostPipeline.js';
import { RenderTelemetry, exposeRenderTelemetry } from './render/telemetry.js';
import { PerfGovernor, createPerfQualityState } from './render/perfGovernor.js';
import { RenderQualityController } from './render/renderQualityController.js';
import { RelativisticVisualController } from './render/relativisticVisualController.js';
import { StateVectorWidget } from './render/stateVectorWidget.js';
import { measureStartupProbe, selectStartupQualityRung } from './render/startupQuality.js';
import type { BurnLogEntry, BurnLogView } from './sim/ship/ledger.js';
import type { Commands, SimSnapshot } from './sim/simulationSnapshot.js';
import type { PredictorResponseMessage } from './workers/predictorProtocol.js';
import './style.css';
import { App } from './ui/App.js';
import { CameraInputController, type CameraControlPort } from './ui/cameraInputController.js';
import { createPerfPanelStore } from './ui/hud/perfPanelStore.js';
import { createHudSignalStore } from './ui/hudSignals.js';
import { createStateVectorSignalStore } from './ui/stateVectorSignals.js';
import { createSystemMapSignalStore } from './ui/systemMapSignals.js';
import { observeStateVectorLayout } from './ui/stateVectorLayoutObserver.js';
import { updateStartupLoadingView, type StartupLoadingElements } from './ui/startupLoadingView.js';
import { createTrajectoryPredictionSignalStore } from './ui/trajectoryPredictionSignals.js';
import {
  STATE_VECTOR_VIEWPORT_COMPONENT_COUNT,
  writeStateVectorViewportPixelsInto,
} from './ui/stateVectorViewport.js';

const SHIP_MASS_KG = 10_000;
const SOFTWARE_FALLBACK_EXPOSURE = 3;
const { BurnLogPanel, createBurnLogSignalStore } = await import('./ui/burnLogRuntime.js');

interface RuntimeResourceCounts {
  animationLoopStarts: number;
  cameraInputControllers: number;
  canvasBindings: number;
  epochWorldCreations: number;
  keyboardCommandMappers: number;
  pagehideListeners: number;
  rendererCreations: number;
  resizeListeners: number;
  scrollListeners: number;
  sessionSimulationCreations: number;
  sessionSimulationReplacements: number;
  spacePhaseActivationRequests: number;
  spacePhaseActivations: number;
  stateVectorLayoutObservers: number;
  trajectoryWorkers: number;
}

interface SystemMapRuntimeDiagnostics {
  readonly scene: EpochWorld['systemMap']['diagnostics'];
  readonly mapSceneCreations: 1;
  mode: SystemMapMode;
  focusBodyId: string;
  targetBodyId: string | null;
  simulationTimeSec: number;
  spaceRenderCount: number;
  spaceRenderCountAtModeChange: number;
  mapRenderCount: number;
  trajectoryLineVisible: boolean;
  trajectoryMarkersVisible: boolean;
}

interface MutableBurnLogDiagnosticEntry {
  startTimeSec: number;
  endTimeSec: number;
  startProperTimeSec: number;
  endProperTimeSec: number;
  energySpentJ: number;
  properDeltaVMS: number;
  peakPowerW: number;
  dominantBodyId: string | null;
  progradeDeltaVMS: number;
  normalDeltaVMS: number;
  radialDeltaVMS: number;
}

interface BurnLogRuntimeDiagnostics {
  readonly identity: 'solarVoyagerBurnLog.v1';
  readonly active: MutableBurnLogDiagnosticEntry;
  readonly latest: MutableBurnLogDiagnosticEntry;
  activeAvailable: boolean;
  latestAvailable: boolean;
  completedCount: number;
  publishCount: number;
  structuralRebuildCount: number;
}

interface TutorialRuntimeDiagnostics {
  readonly status: string;
  readonly stepId: string;
  readonly transitionCount: number;
  readonly observerActive: boolean;
  readonly snapshotObservationCount: number;
}

function createDiagnosticEntry(): MutableBurnLogDiagnosticEntry {
  return {
    startTimeSec: 0,
    endTimeSec: 0,
    startProperTimeSec: 0,
    endProperTimeSec: 0,
    energySpentJ: 0,
    properDeltaVMS: 0,
    peakPowerW: 0,
    dominantBodyId: null,
    progradeDeltaVMS: 0,
    normalDeltaVMS: 0,
    radialDeltaVMS: 0,
  };
}

function copyDiagnosticEntry(
  target: MutableBurnLogDiagnosticEntry,
  source: BurnLogEntry | null,
): void {
  if (source === null) {
    target.startTimeSec = 0;
    target.endTimeSec = 0;
    target.startProperTimeSec = 0;
    target.endProperTimeSec = 0;
    target.energySpentJ = 0;
    target.properDeltaVMS = 0;
    target.peakPowerW = 0;
    target.dominantBodyId = null;
    target.progradeDeltaVMS = 0;
    target.normalDeltaVMS = 0;
    target.radialDeltaVMS = 0;
    return;
  }
  target.startTimeSec = source.startTimeSec;
  target.endTimeSec = source.endTimeSec;
  target.startProperTimeSec = source.startProperTimeSec;
  target.endProperTimeSec = source.endProperTimeSec;
  target.energySpentJ = source.energySpentJ;
  target.properDeltaVMS = source.properDeltaVMS;
  target.peakPowerW = source.peakPowerW;
  target.dominantBodyId = source.dominantBodyId;
  target.progradeDeltaVMS = source.progradeDeltaVMS;
  target.normalDeltaVMS = source.normalDeltaVMS;
  target.radialDeltaVMS = source.radialDeltaVMS;
}

class SharedCameraControls implements CameraControlPort {
  constructor(
    private readonly camera: OrbitCameraController,
    private readonly map: SystemMapController,
    private readonly commands: Commands,
  ) {}

  get focusId(): string {
    return this.map.focusId;
  }

  orbitBy(deltaYawRad: number, deltaPitchRad: number): void {
    this.camera.orbitBy(deltaYawRad, deltaPitchRad);
  }

  zoomByWheel(wheelDelta: number): void {
    this.camera.zoomByWheel(wheelDelta);
  }

  focusBody(id: string): boolean {
    const changed = this.map.focusBody(id);
    if (id === this.map.focusId) this.commands.setTarget(id);
    return changed;
  }

  cycleFocus(step: number): string {
    const id = this.camera.cycleFocus(step);
    this.map.focusBody(id);
    this.commands.setTarget(id);
    return id;
  }
}

const canvasElement = document.querySelector('#space-canvas');
const appElement = document.querySelector('#app');
const startupLoadingElement = document.querySelector('#startup-loading');
const startupMessageElement = document.querySelector('#startup-message');
const startupProgressElement = document.querySelector('#startup-progress');
const startupRetryElement = document.querySelector('#startup-retry');

if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('Solar Voyager canvas was not found.');
}

if (!(appElement instanceof HTMLElement)) {
  throw new Error('Solar Voyager application root was not found.');
}
if (
  !(startupLoadingElement instanceof HTMLElement) ||
  !(startupMessageElement instanceof HTMLElement) ||
  !(startupProgressElement instanceof HTMLProgressElement) ||
  !(startupRetryElement instanceof HTMLButtonElement)
) {
  throw new Error('Solar Voyager startup loading shell was not found.');
}

const canvas = canvasElement;
const appRoot = appElement;
const startupLoadingElements: StartupLoadingElements = {
  message: startupMessageElement,
  progress: startupProgressElement,
  retry: startupRetryElement,
  root: startupLoadingElement,
};
const startupTracker = new StartupTracker(performance.now());
Object.defineProperty(canvas, 'solarVoyagerStartup', {
  value: startupTracker.createDiagnostic(),
});
startupLoadingElements.retry.addEventListener('click', () => window.location.reload());
updateStartupLoadingView(startupLoadingElements, startupTracker);
const runtimeResources: RuntimeResourceCounts = {
  animationLoopStarts: 0,
  cameraInputControllers: 0,
  canvasBindings: 0,
  epochWorldCreations: 0,
  keyboardCommandMappers: 0,
  pagehideListeners: 0,
  rendererCreations: 0,
  resizeListeners: 0,
  scrollListeners: 0,
  sessionSimulationCreations: 0,
  sessionSimulationReplacements: 0,
  spacePhaseActivationRequests: 0,
  spacePhaseActivations: 0,
  stateVectorLayoutObservers: 0,
  trajectoryWorkers: 0,
};
runtimeResources.canvasBindings += 1;
Object.defineProperty(canvas, 'solarVoyagerRuntimeResources', { value: runtimeResources });

async function createRendererOrWait() {
  try {
    return createRenderer(canvas);
  } catch (cause: unknown) {
    startupTracker.fail(cause);
    updateStartupLoadingView(startupLoadingElements, startupTracker);
    canvas.dataset.startupStage = 'failed';
    startupLoadingElements.retry.focus();
    return new Promise<never>(() => undefined);
  }
}

const rendererBootstrap = await createRendererOrWait();
runtimeResources.rendererCreations += 1;
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
let trajectoryPredictionComplete = false;

function invalidateTrajectoryPrediction(): void {
  trajectoryPredictionPending = true;
  trajectoryPredictionComplete = false;
  trajectoryPredictorClient?.invalidate();
}

function invalidateTrajectoryPredictionForWarpElapsed(): void {
  trajectoryPredictionPending = true;
  trajectoryPredictionComplete = false;
  trajectoryPredictorClient?.invalidateForWarpElapsed();
}

const hudStore = createHudSignalStore();
const stateVectorStore = createStateVectorSignalStore();
const hardwareWarning = contextReport.warningRequired
  ? { rendererName: contextReport.rendererName }
  : null;
const resizeListenerOptions: AddEventListenerOptions = { passive: true };
let world: EpochWorld | null = null;
let postPipeline: LightingPostPipeline | null = null;
let cameraInput: CameraInputController | null = null;
let systemMapCameraInput: CameraInputController | null = null;
let commandInput: KeyboardCommandMapper | null = null;
let perfGovernor: PerfGovernor | null = null;
let relativisticVisuals: RelativisticVisualController | null = null;
let stateVectorWidget: StateVectorWidget | null = null;
let stateVectorViewportElement: HTMLDivElement | null = null;
let disposeStateVectorLayoutObservation: (() => void) | null = null;
let runtimeDisposed = false;
let systemMapRuntimeDiagnostics: SystemMapRuntimeDiagnostics | null = null;
const stateVectorViewportPixels = new Float64Array(STATE_VECTOR_VIEWPORT_COMPONENT_COUNT);
const browserStorage: KeyValueStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};

function createTrackedNewGameSimulation() {
  const simulation = createNewGameSimulation(SHIP_MASS_KG, invalidateTrajectoryPrediction);
  runtimeResources.sessionSimulationCreations += 1;
  return simulation;
}

function createTrackedPersistentSimulation(
  state: Parameters<typeof createGameSimulationFromPersistentState>[1],
) {
  const simulation = createGameSimulationFromPersistentState(
    SHIP_MASS_KG,
    state,
    invalidateTrajectoryPrediction,
  );
  runtimeResources.sessionSimulationCreations += 1;
  return simulation;
}

const initialSimulation = createTrackedNewGameSimulation();
const burnLogStore = createBurnLogSignalStore(initialSimulation.burnLog);
const burnLogRuntimeDiagnostics: BurnLogRuntimeDiagnostics = {
  identity: 'solarVoyagerBurnLog.v1',
  active: createDiagnosticEntry(),
  latest: createDiagnosticEntry(),
  activeAvailable: false,
  latestAvailable: false,
  completedCount: 0,
  publishCount: burnLogStore.publishCount,
  structuralRebuildCount: burnLogStore.structuralRebuildCount,
};
Object.defineProperty(canvas, 'solarVoyagerBurnLog', { value: burnLogRuntimeDiagnostics });

function updateBurnLogRuntime(view: BurnLogView): void {
  const count = view.count;
  const active = view.activeBurn;
  const latest = count === 0 ? null : view.get(count - 1);
  burnLogRuntimeDiagnostics.completedCount = count;
  burnLogRuntimeDiagnostics.activeAvailable = active !== null;
  burnLogRuntimeDiagnostics.latestAvailable = latest !== null;
  copyDiagnosticEntry(burnLogRuntimeDiagnostics.active, active);
  copyDiagnosticEntry(burnLogRuntimeDiagnostics.latest, latest);
  burnLogRuntimeDiagnostics.publishCount = burnLogStore.publishCount;
  burnLogRuntimeDiagnostics.structuralRebuildCount = burnLogStore.structuralRebuildCount;
}

const session = new GameSessionController({
  initialSimulation,
  createNewSimulation: createTrackedNewGameSimulation,
  saveRepository: new SaveRepository(browserStorage, SHIP_MASS_KG),
  settingsRepository: new SettingsRepository(browserStorage),
  createSimulation: createTrackedPersistentSimulation,
  onSimulationReplaced: (replacement) => {
    runtimeResources.sessionSimulationReplacements += 1;
    burnLogStore.rebind(replacement.burnLog);
    updateBurnLogRuntime(replacement.burnLog);
    hudStore.publish(replacement.snapshot, performance.now());
    world?.trajectoryOverlay.hide();
    world?.systemMap.trajectoryOverlay.hide();
    if (systemMapRuntimeDiagnostics !== null) {
      systemMapRuntimeDiagnostics.trajectoryLineVisible = false;
      systemMapRuntimeDiagnostics.trajectoryMarkersVisible = false;
    }
    if (replacement.snapshot.targetBodyIndex >= 0) {
      const replacementTargetId =
        replacement.snapshot.bodyIds[replacement.snapshot.targetBodyIndex];
      if (replacementTargetId !== undefined) systemMapController.focusBody(replacementTargetId);
    }
    trajectoryPredictionRefresh.clear();
    invalidateTrajectoryPrediction();
  },
  onSettingsChanged: (settings, origin) => {
    if (origin === 'restore') commandInput?.restoreBindings(settings.inputBindings);
    else commandInput?.updateBindings(settings.inputBindings);
    perfGovernor?.setLock(settings.qualityLock, performance.now());
  },
});
startupTracker.advance('context');
updateStartupLoadingView(startupLoadingElements, startupTracker);
canvas.dataset.startupStage = startupTracker.stage;
const tutorialController = new TutorialController(session.settings.tutorial, session);
let tutorialFrameObserver: ((snapshot: SimSnapshot) => void) | null = null;
let tutorialSnapshotObservationCount = 0;
let tutorialBurnLogExpanded = false;
let tutorialPerfPanelExpanded = false;
let tutorialHardwareWarningAcknowledged = false;
const tutorialRuntimeDiagnostics = Object.freeze(
  Object.setPrototypeOf(
    {
      get status() {
        return tutorialController.progress.status;
      },
      get stepId() {
        return tutorialController.progress.stepId;
      },
      get transitionCount() {
        return tutorialController.transitionCount;
      },
      get observerActive() {
        return tutorialFrameObserver !== null;
      },
      get snapshotObservationCount() {
        return tutorialSnapshotObservationCount;
      },
    },
    null,
  ),
) as TutorialRuntimeDiagnostics;
Object.defineProperty(canvas, 'solarVoyagerTutorial', { value: tutorialRuntimeDiagnostics });
tutorialController.subscribe((progress) => {
  tutorialFrameObserver = progress.status === 'active' ? observeTutorialSnapshot : null;
});
tutorialFrameObserver =
  tutorialController.progress.status === 'active' ? observeTutorialSnapshot : null;
hudStore.publish(session.simulation.snapshot, 0);
burnLogStore.publish();
updateBurnLogRuntime(session.simulation.burnLog);
stateVectorStore.publish(session.simulation.snapshot, 0);

function handleTrajectoryPredictionResult(result: PredictorResponseMessage): void {
  trajectoryPredictionPending = false;
  if (result.type === 'error') {
    trajectoryPredictionComplete = false;
    world?.trajectoryOverlay.hide();
    world?.systemMap.trajectoryOverlay.hide();
    if (systemMapRuntimeDiagnostics !== null) {
      systemMapRuntimeDiagnostics.trajectoryLineVisible = false;
      systemMapRuntimeDiagnostics.trajectoryMarkersVisible = false;
    }
    trajectoryPredictionRefresh.clear();
    trajectoryPredictionStore.publishError();
    canvas.dataset.trajectoryReady = 'error';
    return;
  }
  const snapshot = session.simulation.snapshot;
  try {
    world?.trajectoryOverlay.applyPrediction(result, snapshot.dominantBodyIndex);
    world?.systemMap.trajectoryOverlay.applyPrediction(result, snapshot.dominantBodyIndex);
    trajectoryPredictionRefresh.acceptPrediction(result.points);
    trajectoryPredictionStore.publishSuccess(
      readTrajectoryEventSummary(result.events),
      snapshot.bodyIds,
      snapshot.simTimeSec,
    );
    trajectoryPredictionComplete = true;
    canvas.dataset.trajectoryReady = 'true';
    if (world !== null && systemMapRuntimeDiagnostics !== null) {
      systemMapRuntimeDiagnostics.trajectoryLineVisible =
        world.systemMap.trajectoryOverlay.line.visible;
      systemMapRuntimeDiagnostics.trajectoryMarkersVisible =
        world.systemMap.trajectoryOverlay.markers.visible;
    }
  } catch {
    trajectoryPredictionComplete = false;
    world?.trajectoryOverlay.hide();
    world?.systemMap.trajectoryOverlay.hide();
    if (systemMapRuntimeDiagnostics !== null) {
      systemMapRuntimeDiagnostics.trajectoryLineVisible = false;
      systemMapRuntimeDiagnostics.trajectoryMarkersVisible = false;
    }
    trajectoryPredictionRefresh.clear();
    trajectoryPredictionStore.publishError();
    canvas.dataset.trajectoryReady = 'error';
  }
}

function startTrajectoryPredictionRuntime(): void {
  if (!isTrajectoryPredictionRuntimeEnabled(window) || trajectoryPredictorClient !== null) return;
  const testHorizonSec = readTrajectoryPredictionTestHorizonSec(window);
  const testPointCount = readTrajectoryPredictionTestPointCount(window);
  const trajectoryWorker = new Worker(new URL('./workers/predictor.worker.ts', import.meta.url), {
    type: 'module',
  });
  runtimeResources.trajectoryWorkers += 1;
  trajectoryPredictorClient = createTrajectoryPredictorClient(
    trajectoryWorker,
    session.simulation.snapshot.bodyIds.length,
    handleTrajectoryPredictionResult,
    {
      ownsPort: true,
      ...(testHorizonSec === undefined ? {} : { testHorizonSec }),
      ...(testPointCount === undefined ? {} : { testPointCount }),
    },
  );
}

function handlePageHide(event: PageTransitionEvent): void {
  if (event.persisted || runtimeDisposed) return;
  runtimeDisposed = true;
  trajectoryPredictorClient?.dispose();
  cameraInput?.dispose();
  systemMapCameraInput?.dispose();
  commandInput?.dispose();
  disposeStateVectorLayoutObservation?.();
  world?.systemMap.dispose();
  postPipeline?.dispose();
}

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
    if (bodyId !== null) systemMapController.focusBody(bodyId);
    invalidateTrajectoryPrediction();
  },
  setThrottle: (fraction) => session.simulation.commands.setThrottle(fraction),
  setWarp: (warp) => session.simulation.commands.setWarp(warp),
};

const initialSystemMapFocusId = 'earth';
const systemMapSignals = createSystemMapSignalStore(
  session.simulation.snapshot.bodyIds,
  initialSystemMapFocusId,
);

function writeCameraFocusLabel(bodyId: string): void {
  const focusLabel = document.querySelector('#camera-focus-label');
  if (focusLabel instanceof HTMLElement) {
    focusLabel.textContent = `Focus: ${bodyId.charAt(0).toUpperCase()}${bodyId.slice(1)}`;
  }
}

function handleSystemMapModeChange(mode: SystemMapMode): void {
  systemMapSignals.publishMode(mode);
  cameraInput?.setEnabled(mode === 'space');
  systemMapCameraInput?.setEnabled(mode === 'system-map');
  canvas.dataset.systemMapMode = mode;
  if (systemMapRuntimeDiagnostics !== null) {
    systemMapRuntimeDiagnostics.mode = mode;
    systemMapRuntimeDiagnostics.spaceRenderCountAtModeChange =
      systemMapRuntimeDiagnostics.spaceRenderCount;
  }
  tutorialController.observeMap(mode === 'system-map');
}

function handleSystemMapFocusChange(bodyId: string): void {
  systemMapSignals.publishFocus(bodyId);
  world?.cameraController.focusBody(bodyId);
  world?.systemMap.focusBody(bodyId);
  writeCameraFocusLabel(bodyId);
  if (systemMapRuntimeDiagnostics !== null) systemMapRuntimeDiagnostics.focusBodyId = bodyId;
}

const systemMapController = new SystemMapController({
  bodyIds: session.simulation.snapshot.bodyIds,
  initialFocusId: initialSystemMapFocusId,
  onModeChange: handleSystemMapModeChange,
  onFocusChange: handleSystemMapFocusChange,
});

function observeTutorialSnapshot(snapshot: SimSnapshot): void {
  tutorialSnapshotObservationCount += 1;
  const targetIndex = snapshot.targetBodyIndex;
  const targetId = targetIndex < 0 ? null : (snapshot.bodyIds[targetIndex] ?? null);
  const completedBurnCount = session.simulation.burnLog.count;
  const throttleIsZero = snapshot.throttle === 0;
  tutorialController.observeTargetFocus(
    targetId !== null,
    targetId !== null && targetId === systemMapController.focusId,
  );
  tutorialController.observeReadouts(
    snapshot.osculatingElements.valid,
    trajectoryPredictionComplete,
  );
  tutorialController.observeAttitudeThrust(
    snapshot.attitudeMode !== 'manual',
    snapshot.throttle > 0,
  );
  tutorialController.observeThrustOff(throttleIsZero, completedBurnCount);
  tutorialController.observeWarp(snapshot.requestedWarp === 1, throttleIsZero);
  tutorialController.observeBurnLog(tutorialBurnLogExpanded, completedBurnCount);
  tutorialController.observePerformance(
    tutorialPerfPanelExpanded,
    hardwareWarning !== null,
    tutorialHardwareWarningAcknowledged,
  );
}

function handleTutorialCameraInteraction(interaction: 'orbit' | 'zoom'): void {
  if (interaction === 'orbit') {
    tutorialController.observeCameraOrbit();
    return;
  }
  tutorialController.observeCameraZoom();
}

function handleTutorialBurnLogExpanded(expanded: boolean): void {
  tutorialBurnLogExpanded = expanded;
  tutorialController.observeBurnLog(expanded, session.simulation.burnLog.count);
}

function handleTutorialPerfPanelExpanded(expanded: boolean): void {
  tutorialPerfPanelExpanded = expanded;
  tutorialController.observePerformance(
    expanded,
    hardwareWarning !== null,
    tutorialHardwareWarningAcknowledged,
  );
}

function handleTutorialHardwareWarningAcknowledged(): void {
  tutorialHardwareWarningAcknowledged = true;
  tutorialController.observePerformance(tutorialPerfPanelExpanded, true, true);
}

function handleTutorialSaveSucceeded(): void {
  tutorialController.observeSaveSucceeded();
}

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
    world.systemMap.resize(Math.max(1, clientWidth), Math.max(1, clientHeight), pixelRatio);
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
  if (systemMapRuntimeDiagnostics !== null) {
    systemMapRuntimeDiagnostics.simulationTimeSec = snapshot.simTimeSec;
    systemMapRuntimeDiagnostics.targetBodyId =
      snapshot.targetBodyIndex < 0 ? null : (snapshot.bodyIds[snapshot.targetBodyIndex] ?? null);
  }
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
  if (hudStore.publish(snapshot, nowMs)) {
    burnLogStore.publish();
    updateBurnLogRuntime(session.simulation.burnLog);
    tutorialFrameObserver?.(snapshot);
  }
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
  if (systemMapController.mode === 'system-map') {
    world.systemMap.update(deltaSec);
    telemetry.beginGpuTimer();
    world.systemMap.render(renderer);
    telemetry.recordStateVectorWidgetMs(0);
    telemetry.endGpuTimer();
    if (systemMapRuntimeDiagnostics !== null) systemMapRuntimeDiagnostics.mapRenderCount += 1;
  } else {
    world.systemMap.cameraController.update(deltaSec);
    proceduralSun.update(snapshot.simTimeSec);
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
    if (systemMapRuntimeDiagnostics !== null) systemMapRuntimeDiagnostics.spaceRenderCount += 1;
  }
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

const sceneManager = new SceneManager(session);
const autostart = new URLSearchParams(window.location.search).get('autostart') === '1';
if (autostart) {
  const result = sceneManager.startNewGame();
  if (!result.ok) throw new Error(`Solar Voyager autostart failed: ${result.message}`);
}
let spacePhaseActivation: Promise<void> | null = null;

function renderApplication(): void {
  render(
    h(App, {
      bodyIds: session.simulation.snapshot.bodyIds,
      burnLog: burnLogStore,
      burnLogPanel: BurnLogPanel,
      commands: sessionCommands,
      hardwareWarning,
      hud: hudStore.display,
      hudState: hudStore.signals,
      perfPanel: perfPanelStore,
      sceneManager,
      session,
      stateVectors: stateVectorStore,
      stateVectorViewportRef: setStateVectorViewportElement,
      systemMap: {
        controller: systemMapController,
        signals: systemMapSignals,
      },
      trajectoryPrediction: trajectoryPredictionStore,
      tutorial: tutorialController,
      onBurnLogExpandedChange: handleTutorialBurnLogExpanded,
      onHardwareWarningAcknowledged: handleTutorialHardwareWarningAcknowledged,
      onPerfPanelExpandedChange: handleTutorialPerfPanelExpanded,
      onSaveSucceeded: handleTutorialSaveSucceeded,
      onSpacePhaseEntered: () => {
        void activateSpacePhase();
      },
    }),
    appRoot,
  );
}

function publishStartupMilestone(milestone: EpochWorldMilestone): void {
  startupTracker.advance(milestone);
  updateStartupLoadingView(startupLoadingElements, startupTracker);
  canvas.dataset.startupStage = startupTracker.stage;
}

function readStartupResourceMetrics() {
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  let encodedBodyBytes = 0;
  let transferBytes = 0;
  for (const resource of resources) {
    if (Number.isFinite(resource.encodedBodySize) && resource.encodedBodySize > 0) {
      encodedBodyBytes += resource.encodedBodySize;
    }
    if (Number.isFinite(resource.transferSize) && resource.transferSize > 0) {
      transferBytes += resource.transferSize;
    }
  }
  return {
    encodedBodyBytes,
    programCount: renderer.info.programs?.length ?? 0,
    resourceCount: resources.length,
    transferBytes,
  };
}

async function prepareApplication(): Promise<void> {
  canvas.dataset.depthStrategy = contextReport.depthStrategy;
  canvas.dataset.rendererName = contextReport.rendererName;
  canvas.dataset.rendererReady = 'true';
  canvas.dataset.softwareRasterizer = String(contextReport.softwareRasterizer);
  resizeRenderer();
  world = await createEpochWorld(renderer, {
    initialViewportWidthPx: Math.max(1, canvas.clientWidth),
    initialViewportHeightPx: Math.max(1, canvas.clientHeight),
    onProgress: publishStartupMilestone,
  });
  runtimeResources.epochWorldCreations += 1;
  world.systemMap.focusBody(systemMapController.focusId);
  systemMapRuntimeDiagnostics = {
    scene: world.systemMap.diagnostics,
    mapSceneCreations: 1,
    mode: systemMapController.mode,
    focusBodyId: systemMapController.focusId,
    targetBodyId: null,
    simulationTimeSec: session.simulation.snapshot.simTimeSec,
    spaceRenderCount: 0,
    spaceRenderCountAtModeChange: 0,
    mapRenderCount: 0,
    trajectoryLineVisible: false,
    trajectoryMarkersVisible: false,
  };
  Object.defineProperty(canvas, 'solarVoyagerSystemMap', {
    value: systemMapRuntimeDiagnostics,
  });
  canvas.dataset.systemMapMode = systemMapController.mode;
  const preparedWorld = world;
  if (preparedWorld === null) throw new Error('Solar Voyager epoch world was not prepared.');
  const qualityLock = session.settings.qualityLock;
  let probeMeanMs: number | null = null;
  let initialAutoRung: 0 | 7 | 14;
  if (qualityLock === 'auto') {
    const context = renderer.getContext() as WebGL2RenderingContext;
    probeMeanMs = measureStartupProbe(
      () => {
        renderer.render(preparedWorld.spaceScene.scene, preparedWorld.spaceScene.camera);
        context.finish();
      },
      () => performance.now(),
    );
    initialAutoRung = selectStartupQualityRung(
      qualityLock,
      {
        devicePixelRatio: window.devicePixelRatio,
        maxSamples: Number(context.getParameter(context.MAX_SAMPLES)),
        maxTextureSize: Number(context.getParameter(context.MAX_TEXTURE_SIZE)),
        softwareRenderer: contextReport.softwareRasterizer,
        usedPerformanceCaveatFallback: contextReport.usedPerformanceCaveatFallback,
      },
      probeMeanMs,
    );
  } else {
    initialAutoRung = selectStartupQualityRung(qualityLock, null, null);
  }
  startupTracker.recordQuality(
    initialAutoRung,
    qualityLock === 'auto' ? 'auto' : 'manual',
    probeMeanMs,
  );
  updateStartupLoadingView(startupLoadingElements, startupTracker);
  canvas.dataset.startupStage = startupTracker.stage;
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
    initialAutoRung,
    initialLock: session.settings.qualityLock,
    state: perfQualityState,
    telemetry,
  });
  if (!postProcessingEnabled) renderer.toneMappingExposure = SOFTWARE_FALLBACK_EXPOSURE;
  resizeRenderer();
  world.lighting.update();
  world.spaceScene.updateCameraRelative(world.cameraPositionKm);
  world.systemMap.update(0);
  world.trajectoryOverlay.prepareCompilationPass(
    world.cameraPositionKm,
    world.cameraController.lookDirection,
  );
  world.systemMap.trajectoryOverlay.prepareCompilationPass(
    world.systemMap.cameraPositionKm,
    world.systemMap.cameraController.lookDirection,
  );
  postPipeline.warmUp(postProcessingEnabled);
  world.systemMap.render(renderer);
  world.trajectoryOverlay.hide();
  world.systemMap.trajectoryOverlay.hide();
  await stateVectorWidget.prepare(renderer);
  startupTracker.advance('post-ready');
  updateStartupLoadingView(startupLoadingElements, startupTracker);
  canvas.dataset.startupStage = startupTracker.stage;
  renderApplication();
  updateStateVectorViewport();
  canvas.dataset.worldReady = 'true';
  startupTracker.recordReady(performance.now(), readStartupResourceMetrics());
  updateStartupLoadingView(startupLoadingElements, startupTracker);
  canvas.dataset.startupStage = startupTracker.stage;
}

async function activateSpacePhaseRuntime(): Promise<void> {
  runtimeResources.spacePhaseActivations += 1;
  await applicationReady;
  if (startupFailed) return;
  await Promise.resolve();
  const activeWorld = world;
  if (activeWorld === null) throw new Error('Solar Voyager epoch world was not prepared.');
  activeWorld.visualSystem.enableLazyLoading();
  const focusLabel = document.querySelector('#camera-focus-label');
  if (!(focusLabel instanceof HTMLElement)) {
    throw new Error('Solar Voyager camera focus label was not found.');
  }
  commandInput = new KeyboardCommandMapper(
    window as unknown as KeyboardInputTarget,
    sessionCommands,
    currentInputSnapshot,
    session.settings.inputBindings,
  );
  runtimeResources.keyboardCommandMappers += 1;
  const spaceCameraControls = new SharedCameraControls(
    activeWorld.cameraController,
    systemMapController,
    sessionCommands,
  );
  const mapCameraControls = new SharedCameraControls(
    activeWorld.systemMap.cameraController,
    systemMapController,
    sessionCommands,
  );
  cameraInput = new CameraInputController(
    canvas,
    window,
    focusLabel,
    spaceCameraControls,
    true,
    handleTutorialCameraInteraction,
  );
  systemMapCameraInput = new CameraInputController(
    canvas,
    window,
    focusLabel,
    mapCameraControls,
    false,
    handleTutorialCameraInteraction,
  );
  runtimeResources.cameraInputControllers += 2;
  startTrajectoryPredictionRuntime();
  const appOverlay = appRoot.querySelector('.app-overlay');
  if (!(appOverlay instanceof HTMLElement)) {
    throw new Error('Solar Voyager application overlay was not found.');
  }
  disposeStateVectorLayoutObservation = observeStateVectorLayout(
    appOverlay,
    updateStateVectorViewport,
  );
  runtimeResources.stateVectorLayoutObservers += 1;
  canvas.dataset.cameraReady = 'true';
  window.addEventListener('resize', resizeRenderer, resizeListenerOptions);
  runtimeResources.resizeListeners += 1;
  window.addEventListener('scroll', updateStateVectorViewport, true);
  runtimeResources.scrollListeners += 1;
  window.addEventListener('pagehide', handlePageHide);
  runtimeResources.pagehideListeners += 1;
  invalidateTrajectoryPrediction();
  requestAnimationFrame(renderFrame);
  runtimeResources.animationLoopStarts += 1;
}

function activateSpacePhase(): Promise<void> {
  runtimeResources.spacePhaseActivationRequests += 1;
  spacePhaseActivation ??= activateSpacePhaseRuntime();
  return spacePhaseActivation;
}

let startupFailed = false;
const applicationReady = prepareApplication().catch((cause: unknown) => {
  startupFailed = true;
  startupTracker.fail(cause);
  updateStartupLoadingView(startupLoadingElements, startupTracker);
  canvas.dataset.startupStage = 'failed';
  startupLoadingElements.retry.focus();
});
