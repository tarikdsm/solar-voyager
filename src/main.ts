import { h, render } from 'preact';

import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
  createRespawnPersistentState,
} from './game/createNewGameSimulation.js';
import { FlightController } from './game/flight/flightController.js';
import { FlightInputRouter } from './game/flight/flightInputRouter.js';
import { isEditableTarget } from './game/input/bindings.js';
import { GamepadPoller, type GamepadHost } from './game/input/gamepad.js';
import {
  InputEngine,
  type InputKeyboardTarget,
  type InputPointerMotionEvent,
  type PointerLockSurface,
} from './game/input/inputEngine.js';
import { createBodyRadiiKm } from './game/hud/bodyMarkerCatalog.js';
import { pickBodyIndexAtPixel } from './game/hud/bodyPicking.js';
import { HudInputRouter } from './game/hud/hudInputRouter.js';
import { SaveRepository } from './game/saveLoad.js';
import { SceneManager } from './game/sceneManager.js';
import { replacementInvalidatesRestorePoints, RestorePointRing } from './game/restorePoints.js';
import { GameSessionController } from './game/sessionController.js';
import { createImpactSignalStore } from './ui/impactSignals.js';
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
import { applyCameraPose } from './render/cameraRig.js';
import { createRenderer, type RendererBootstrap } from './render/createRenderer.js';
import { calculateDrawingBufferDimension } from './render/drawingBufferSize.js';
import { LightingPostPipeline } from './render/lightingPostPipeline.js';
import type { CameraMode } from './game/cameraDirector.js';
import type { BodyModelLoadState } from './render/bodyVisualSystem.js';
import { SHIP_ASSET_ID } from './render/shipVisual.js';
import { RenderTelemetry, exposeRenderTelemetry } from './render/telemetry.js';
import { PerfGovernor, createPerfQualityState } from './render/perfGovernor.js';
import { RenderQualityController } from './render/renderQualityController.js';
import { RelativisticVisualController } from './render/relativisticVisualController.js';
import { createStateVectorScales } from './render/stateVectorModel.js';
import { StateVectorWidget } from './render/stateVectorWidget.js';
import { measureStartupProbe, selectStartupQualityRung } from './render/startupQuality.js';
import type { BurnLogEntry, BurnLogView } from './sim/ship/ledger.js';
import { DEFAULT_VESSEL } from './sim/ship/vessel.js';
import type { Commands, SimSnapshot } from './sim/simulationSnapshot.js';
import type { PredictorResponseMessage } from './workers/predictorProtocol.js';
import './style.css';
import { App } from './ui/App.js';
import { CameraInputController } from './ui/cameraInputController.js';
import { SharedCameraControls } from './ui/sharedCameraControls.js';
import { createPerfPanelStore } from './ui/hud/perfPanelStore.js';
import { createHudPresetStore } from './ui/hudPresetSignals.js';
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

const SOFTWARE_FALLBACK_EXPOSURE = 3;

interface RuntimeResourceCounts {
  animationLoopStarts: number;
  /** One space-camera director per epoch world (T0110). */
  cameraDirectors: number;
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
  shipVisualCreations: number;
  spacePhaseActivationRequests: number;
  spacePhaseActivations: number;
  stateVectorLayoutObservers: number;
  trajectoryWorkers: number;
}

interface ShipRuntimeDiagnostics {
  readonly loadState: BodyModelLoadState;
  readonly resolved: boolean;
  readonly diameterPx: number;
  readonly pointOpacity: number;
  readonly modelOpacity: number;
  readonly noseAlignment: number;
  readonly noseNodeAlignment: number;
  readonly focused: boolean;
}

interface CameraRuntimeDiagnostics {
  readonly mode: CameraMode;
  readonly transitioning: boolean;
  readonly focusId: string;
  readonly distanceShipLengths: number;
  readonly armDistanceKm: number;
  readonly fovDeg: number;
  readonly fovOffsetDeg: number;
  readonly shakeAmplitudeDeg: number;
  readonly fovWideningEnabled: boolean;
  readonly shakeEnabled: boolean;
  readonly shipDistanceKm: number;
  readonly positionXKm: number;
  readonly positionYKm: number;
  readonly positionZKm: number;
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
let startupRenderer: RendererBootstrap['renderer'] | null = null;
Object.defineProperty(canvas, 'solarVoyagerStartup', {
  value: startupTracker.createDiagnostic(
    () => startupRenderer?.info.programs?.length ?? startupTracker.programCountAtReady,
  ),
});
startupLoadingElements.retry.addEventListener('click', () => window.location.reload());
updateStartupLoadingView(startupLoadingElements, startupTracker);

function waitForStartupRetry(cause: unknown): Promise<never> {
  startupTracker.fail(cause);
  updateStartupLoadingView(startupLoadingElements, startupTracker);
  canvas.dataset.startupStage = 'failed';
  startupLoadingElements.retry.focus();
  return new Promise<never>(() => undefined);
}

async function loadBurnLogRuntimeOrWait() {
  try {
    return await import('./ui/burnLogRuntime.js');
  } catch (cause: unknown) {
    return waitForStartupRetry(cause);
  }
}

const { BurnLogPanel, createBurnLogSignalStore } = await loadBurnLogRuntimeOrWait();
const runtimeResources: RuntimeResourceCounts = {
  animationLoopStarts: 0,
  cameraDirectors: 0,
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
  shipVisualCreations: 0,
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
    return waitForStartupRetry(cause);
  }
}

const rendererBootstrap = await createRendererOrWait();
runtimeResources.rendererCreations += 1;
const { contextReport, renderer } = rendererBootstrap;
startupRenderer = renderer;
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
let inputEngine: InputEngine | null = null;
let flightController: FlightController | null = null;
let flightInputRouter: FlightInputRouter | null = null;
let hudInputRouter: HudInputRouter | null = null;
let pauseRequestCount = 0;
let hardwareWarningAcknowledged = false;
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
  const simulation = createNewGameSimulation(DEFAULT_VESSEL, invalidateTrajectoryPrediction);
  runtimeResources.sessionSimulationCreations += 1;
  return simulation;
}

function createTrackedPersistentSimulation(
  state: Parameters<typeof createGameSimulationFromPersistentState>[1],
) {
  const simulation = createGameSimulationFromPersistentState(
    DEFAULT_VESSEL,
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

// ADR-036 — recovery sources for a surface-contact freeze.
const restorePoints = new RestorePointRing();
const impactStore = createImpactSignalStore();

const session = new GameSessionController({
  initialSimulation,
  createNewSimulation: createTrackedNewGameSimulation,
  saveRepository: new SaveRepository(browserStorage, DEFAULT_VESSEL),
  settingsRepository: new SettingsRepository(browserStorage),
  createSimulation: createTrackedPersistentSimulation,
  createRespawnState: createRespawnPersistentState,
  onSimulationReplaced: (replacement, origin) => {
    runtimeResources.sessionSimulationReplacements += 1;
    // Only a timeline change invalidates the ring. A restore or a respawn moves
    // within the mission already in progress, and the remaining slots are still
    // valid states of it — clearing them would make a six-slot ring a one-deep
    // undo.
    if (replacementInvalidatesRestorePoints(origin)) restorePoints.reset();
    // A restore or a new game teleports the ship; without this the chase arm
    // would spend 0.7 s of spring flying across the gap it never travelled.
    world?.cameraDirector.resetChase();
    impactStore.publish(replacement.snapshot, restorePoints.count);
    // ADR-034 §4: a restored session runs its persisted vessel, not DEFAULT_VESSEL,
    // and the regime scaling below depends on it — so the vessel goes first.
    flightController?.setVessel(replacement.vessel);
    stateVectorWidget?.setScales(createStateVectorScales(replacement.vessel.restMassKg));
    // Seed the analog lever from the restored state, or the router would command
    // the fresh engine value (0) over it on the next frame. `snapshot.throttle`
    // is already regime-scaled, so the controller un-scales it and both owners
    // of the lever are seeded from the one figure.
    inputEngine?.setThrottleAxis(
      flightController?.adoptCommandedThrottle(replacement.snapshot.throttle) ??
        replacement.snapshot.throttle,
    );
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
    inputEngine?.applyBindings(settings.inputBindings);
    inputEngine?.applyGamepadSettings(settings.gamepad);
    inputEngine?.releaseHeldKeys();
    // A restore already carries the saved rotation rates: adopt them instead of
    // flushing the (now released) axes over them.
    if (origin === 'restore') flightController?.resetAxes();
    else flightController?.releaseAxes();
    world?.cameraDirector.applyCameraSettings(settings.camera);
    hudPresetStore.setPreset(settings.hud.preset);
    hudPresetStore.setBodyLabels(settings.hud.bodyLabels);
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
  canvas.removeEventListener('dblclick', handleCanvasDoubleClick);
  canvas.removeEventListener('pointerdown', handleCanvasPickPointerDown);
  canvas.removeEventListener('pointerup', handleCanvasPickPointerUp);
  inputEngine?.dispose();
  disposeStateVectorLayoutObservation?.();
  world?.systemMap.dispose();
  postPipeline?.dispose();
}

function currentInputSnapshot() {
  return session.simulation.snapshot;
}

/**
 * Escape reached the input engine (T0105 seam, T0112 menu).
 *
 * The counter is the frozen observable `test:camera-controls` asserts — exactly
 * one increment per Escape — and it is raised *before* the suppressions below, so
 * "the intent was heard" and "a menu opened" stay separately observable.
 *
 * Two things outrank pause and neither can be detected through `preventDefault`,
 * which is how the system map and the burn-log rows already suppress it
 * (`blocksGameKey` honours `defaultPrevented`, and both attach their listeners
 * before the input engine exists):
 *
 *  - a surface-contact freeze: the core is already inert and `ImpactOverlay` is
 *    the only way out, so a pause dialog on top of it would hide recovery;
 *  - an unacknowledged hardware-acceleration warning: a mandatory pre-flight
 *    alert, and stacking a modal over a modal is worse than doing nothing.
 */
function handlePauseRequested(): void {
  pauseRequestCount += 1;
  canvas.dataset.pauseRequests = String(pauseRequestCount);
  if (sceneManager.phase !== 'space') return;
  if (session.simulation.snapshot.impactOccurred === 1) return;
  if (hardwareWarning !== null && !hardwareWarningAcknowledged) return;
  sceneManager.togglePause();
}

/** Browser adapter for the input engine's pointer-lock port. */
function createCanvasPointerLockSurface(element: HTMLCanvasElement): PointerLockSurface {
  const ownerDocument = element.ownerDocument;
  let motionListener: ((event: InputPointerMotionEvent) => void) | null = null;
  let lockChangeListener: (() => void) | null = null;
  let motionAttached = false;
  const isLocked = (): boolean => ownerDocument.pointerLockElement === element;
  const handleMouseMove = (event: MouseEvent): void => {
    motionListener?.(event);
  };
  const detachMotion = (): void => {
    if (!motionAttached) return;
    motionAttached = false;
    ownerDocument.removeEventListener('mousemove', handleMouseMove);
  };
  const handleLockChange = (): void => {
    // The listener exists only while locked, so an idle frame loop never pays
    // for pointer motion it would discard anyway.
    if (isLocked()) {
      if (!motionAttached) {
        motionAttached = true;
        ownerDocument.addEventListener('mousemove', handleMouseMove);
      }
    } else detachMotion();
    lockChangeListener?.();
  };
  ownerDocument.addEventListener('pointerlockchange', handleLockChange);
  return {
    isLocked,
    requestLock: () => {
      // Chrome returns a promise that rejects with SecurityError inside the
      // short lock-out window after an Escape release; an unhandled rejection
      // there would surface as a console error and fail the browser gates.
      const request: unknown = element.requestPointerLock();
      if (request instanceof Promise) request.catch(() => undefined);
    },
    releaseLock: () => {
      ownerDocument.exitPointerLock();
    },
    onMotion: (listener) => {
      motionListener = listener;
    },
    onLockChange: (listener) => {
      lockChangeListener = listener;
    },
    dispose: () => {
      detachMotion();
      ownerDocument.removeEventListener('pointerlockchange', handleLockChange);
      motionListener = null;
      lockChangeListener = null;
    },
  };
}

/**
 * Browser adapter for `GamepadHost` — `navigator.getGamepads()` plus the two
 * window connect/disconnect events, exactly as `createCanvasPointerLockSurface`
 * adapts the pointer-lock API. `game/input/` never touches `navigator`/`window`
 * directly; `GamepadPoller` only sees this port.
 */
function createBrowserGamepadHost(): GamepadHost {
  return {
    getGamepads: () => navigator.getGamepads(),
    addEventListener: (type, listener) => {
      window.addEventListener(type, listener);
    },
    removeEventListener: (type, listener) => {
      window.removeEventListener(type, listener);
    },
  };
}

/**
 * Interim mouse-look activation. Single click stays with the v1 orbit-drag
 * camera; T0110's chase camera owns the real gesture.
 */
function handleCanvasDoubleClick(): void {
  if (inputEngine === null || inputEngine.pointerLocked) return;
  inputEngine.requestPointerLock();
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
    if (bodyId !== null) {
      systemMapController.focusBody(bodyId);
      // The map only relays focus to the camera when its own focus moves, and
      // since T0109 the camera can be on the ship while the map is not. Selecting
      // a target has always recentred the camera; make that unconditional rather
      // than dependent on the relay firing.
      //
      // T0110 narrows *which* camera: choosing a navigation target re-aims the
      // observatory camera but never drags the player out of the chase view. It
      // also writes the focus label, which this path never did — harmless while
      // camera focus always equalled map focus, and wrong the moment they could
      // diverge.
      world?.cameraDirector.focusObservatoryBody(bodyId);
      refreshCameraFocusLabel();
    }
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

/**
 * Rewrites the focus label from the camera's own idea of what it is looking at.
 *
 * Every site that can move the camera focus calls this instead of naming a body
 * itself: since T0110 the camera can be following the ship while the map and the
 * navigation target sit on something else, so "the id I just asked for" and "the
 * thing on screen" are no longer the same string.
 */
function refreshCameraFocusLabel(): void {
  const director = world?.cameraDirector;
  if (director !== undefined) writeCameraFocusLabel(director.focusId);
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
  world?.cameraDirector.focusObservatoryBody(bodyId);
  world?.systemMap.focusBody(bodyId);
  refreshCameraFocusLabel();
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
  // Also the pause gate: an unacknowledged mandatory warning outranks the menu.
  hardwareWarningAcknowledged = true;
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
    cameraDirector,
    cameraPositionKm,
  } = world;
  const deltaSec = telemetry.beginFrame(nowMs);
  // T0112 — a real pause. The animation loop deliberately keeps running: the
  // wall delta is derived from the previous frame's timestamp, so stopping rAF
  // would hand `step()` the entire paused duration on resume — at 1e7x warp a
  // two-minute menu visit is sixty-three years of flight in one frame. Holding
  // the simulation at zero while the scene still renders is what makes the pause
  // safe as well as pretty. Design doc section 6.2.
  const halted = sceneManager.state !== 'space';
  const simDeltaSec = halted ? 0 : deltaSec;
  const simulationStartMs = performance.now();
  if (!halted && inputEngine !== null && flightInputRouter !== null && flightController !== null) {
    const inputFrame = inputEngine.poll(deltaSec);
    flightInputRouter.apply(inputFrame);
    hudInputRouter?.apply(inputFrame);
    flightController.update(deltaSec);
  }
  const snapshot = halted ? session.simulation.snapshot : session.simulation.step(deltaSec);
  // ADR-036 — one capture per 10 s of wall time, skipped while frozen. The
  // publish below short-circuits on the frame where nothing about the overlay
  // has changed, which is every frame that is not a crash.
  restorePoints.update(session.simulation, simDeltaSec);
  impactStore.publish(snapshot, restorePoints.count);
  world.positionsKm.set(snapshot.bodyPositionsKm);
  // Before the camera reads its focus offset, so a ship-focused camera tracks
  // this step's position instead of the previous one.
  world.shipVisual.writeState(snapshot.shipState, snapshot.attitudeQuaternion);
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
  const hudPublished = hudStore.publish(snapshot, nowMs);
  if (hudPublished) {
    burnLogStore.publish();
    updateBurnLogRuntime(session.simulation.burnLog);
    tutorialFrameObserver?.(snapshot);
  }
  stateVectorStore.publish(snapshot, nowMs);
  const hudEndMs = performance.now();
  const renderStartMs = performance.now();
  // T0110 — the director runs both cameras and publishes one pose; the rig is
  // the only place that touches three.js. `world.cameraPositionKm` is a live
  // reference to that pose, so every camera-relative consumer below sees it.
  cameraDirector.update(simDeltaSec, snapshot);
  applyCameraPose(spaceScene.camera, cameraDirector.pose);
  // The one place the in-world markers are published, and it has to be here:
  // the pose for this frame exists only after `cameraDirector.update`, while the
  // HUD sample happened above. Gating on `hudPublished` keeps both halves on the
  // same 100 ms tick and the same snapshot, which is what "one publication path"
  // means (design doc section 1).
  if (hudPublished) {
    hudStore.publishWorldMarkers(
      snapshot,
      cameraDirector.pose,
      Math.max(1, canvas.clientWidth),
      Math.max(1, canvas.clientHeight),
      hudPresetStore.signals.bodyLabels.value,
    );
  }
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
    world.shipVisual.update(
      cameraPositionKm,
      Math.max(1, canvas.clientHeight),
      spaceScene.camera.fov * (Math.PI / 180),
      nowMs,
    );
    lighting.setFocusPositionOffset(cameraDirector.focusPositionOffset);
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
  if (startupTracker.programCountAfterFirstFrame === null) {
    startupTracker.recordFirstFrameProgramCount(renderer.info.programs?.length ?? 0);
  }
  perfGovernor?.update(nowMs, telemetry.snapshot);
  requestAnimationFrame(renderFrame);
}

const sceneManager = new SceneManager(session);
const hudPresetStore = createHudPresetStore(
  session.settings.hud.preset,
  session.settings.hud.bodyLabels,
);
/** Catalog mean radii for angular-disc picking, in `snapshot.bodyIds` order. */
const bodyRadiiKm = createBodyRadiiKm();

/**
 * Preset and label changes are persisted, but a failed write must not desync the
 * live HUD from what the player just asked for: the ring has already moved when
 * this runs, so the store is the source of truth and the profile write is
 * best-effort (the settings panel surfaces failures on its own status line).
 */
function persistHudPreferences(): void {
  session.setHudPreset(hudPresetStore.signals.preset.value);
  session.setHudBodyLabels(hudPresetStore.signals.bodyLabels.value);
}

sceneManager.subscribe((state) => {
  canvas.dataset.sceneState = state;
  // Drop every latched key on both edges: a key held while clicking a menu
  // button must not fire into the ship on resume, and a key held at the moment
  // of pausing must not stay down for the whole menu visit. `resetAxes`, not
  // `releaseAxes` — the latter issues `rotate(0,0,0)` and would silently stop a
  // spinning ship every time the player paused.
  inputEngine?.releaseHeldKeys();
  flightController?.resetAxes();
  if (state !== 'space') inputEngine?.releasePointerLock();
});
canvas.dataset.sceneState = sceneManager.state;

const CLICK_PICK_MAX_MOVEMENT_PX = 4;
const CLICK_PICK_MAX_DURATION_MS = 400;
let pickPointerId = -1;
let pickPointerDownX = 0;
let pickPointerDownY = 0;
let pickPointerDownMs = 0;

function handleCanvasPickPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  pickPointerId = event.pointerId;
  pickPointerDownX = event.clientX;
  pickPointerDownY = event.clientY;
  pickPointerDownMs = event.timeStamp;
}

/**
 * Click-to-target (spec section 7).
 *
 * `CameraInputController` owns orbit-drag on the same canvas, so a release is
 * only a click if the pointer barely moved and the press was brief — otherwise
 * letting go of a drag over Jupiter would silently re-target. A miss clears
 * nothing: deselecting stays the dropdown's job, which remains the documented
 * fallback.
 */
function handleCanvasPickPointerUp(event: PointerEvent): void {
  const pointerId = pickPointerId;
  pickPointerId = -1;
  if (event.pointerId !== pointerId || event.button !== 0) return;
  if (world === null || sceneManager.state !== 'space') return;
  if (systemMapController.mode !== 'space') return;
  if (inputEngine?.pointerLocked === true) return;
  if (event.timeStamp - pickPointerDownMs > CLICK_PICK_MAX_DURATION_MS) return;
  if (
    Math.hypot(event.clientX - pickPointerDownX, event.clientY - pickPointerDownY) >
    CLICK_PICK_MAX_MOVEMENT_PX
  ) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const snapshot = session.simulation.snapshot;
  const bodyIndex = pickBodyIndexAtPixel(
    snapshot,
    world.cameraDirector.pose,
    bodyRadiiKm,
    rect.width,
    rect.height,
    event.clientX - rect.left,
    event.clientY - rect.top,
  );
  if (bodyIndex < 0) return;
  const bodyId = snapshot.bodyIds[bodyIndex];
  if (bodyId === undefined) return;
  canvas.dataset.pickedBodyId = bodyId;
  sessionCommands.setTarget(bodyId);
}

const autostart = new URLSearchParams(window.location.search).get('autostart') === '1';
if (autostart) {
  const result = sceneManager.startNewGame();
  if (!result.ok) throw new Error(`Solar Voyager autostart failed: ${result.message}`);
}
let spacePhaseActivation: Promise<void> | null = null;

/**
 * ADR-036 — the two ways out of a freeze. Both go through the session
 * controller, so both are validated by the rules a loaded save must satisfy and
 * both fire `onSimulationReplaced`, which re-points the flight controller.
 */
const impactActions = {
  onRestore: (): void => {
    const point = restorePoints.latest;
    if (point === null) return;
    session.restoreFromState(point.state);
  },
  onRespawn: (): void => {
    session.respawnInOrbit();
  },
};

function renderApplication(): void {
  render(
    h(App, {
      bodyIds: session.simulation.snapshot.bodyIds,
      burnLog: burnLogStore,
      burnLogPanel: BurnLogPanel,
      commands: sessionCommands,
      hardwareWarning,
      hud: hudStore.display,
      hudPreset: hudPresetStore,
      hudState: hudStore.signals,
      pause: {
        resume: () => {
          sceneManager.resume();
        },
        save: () => session.saveLocal(),
        exitToMenu: () => {
          sceneManager.returnToMainMenu();
        },
      },
      impact: {
        actions: impactActions,
        display: impactStore.display,
      },
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
    // The warm-up camera hangs off the chase arm, so it needs the attitude the
    // session actually starts at rather than an identity guess — that is what
    // puts the shader warm-up at the same viewpoint as the first real frame.
    initialShipAttitudeQuaternion: session.simulation.snapshot.attitudeQuaternion,
  });
  runtimeResources.epochWorldCreations += 1;
  runtimeResources.shipVisualCreations += 1;
  runtimeResources.cameraDirectors += 1;
  const shipVisual = world.shipVisual;
  const cameraDirector = world.cameraDirector;
  cameraDirector.applyCameraSettings(session.settings.camera);
  const shipRuntimeDiagnostics = Object.freeze(
    Object.setPrototypeOf(
      {
        get loadState() {
          return shipVisual.loadState;
        },
        get resolved() {
          return shipVisual.resolved;
        },
        get diameterPx() {
          return shipVisual.diameterPx;
        },
        get pointOpacity() {
          return shipVisual.pointOpacity;
        },
        get modelOpacity() {
          return shipVisual.modelOpacity;
        },
        get noseAlignment() {
          return shipVisual.noseAlignment;
        },
        get noseNodeAlignment() {
          return shipVisual.noseNodeAlignment;
        },
        get focused() {
          return cameraDirector.focusId === SHIP_ASSET_ID;
        },
      },
      null,
    ),
  ) as ShipRuntimeDiagnostics;
  Object.defineProperty(canvas, 'solarVoyagerShip', { value: shipRuntimeDiagnostics });
  const shipPositionsKm = world.positionsKm;
  const shipPositionOffset = world.shipPositionOffset;
  const cameraRuntimeDiagnostics = Object.freeze(
    Object.setPrototypeOf(
      {
        get mode() {
          return cameraDirector.mode;
        },
        get transitioning() {
          return cameraDirector.isTransitioning;
        },
        get focusId() {
          return cameraDirector.focusId;
        },
        get distanceShipLengths() {
          return cameraDirector.chaseDistanceShipLengths;
        },
        get armDistanceKm() {
          return cameraDirector.chaseArmDistanceKm;
        },
        get fovDeg() {
          return cameraDirector.pose.fovDeg;
        },
        get fovOffsetDeg() {
          return cameraDirector.chaseFovOffsetDeg;
        },
        get shakeAmplitudeDeg() {
          return cameraDirector.chaseShakeAmplitudeDeg;
        },
        get fovWideningEnabled() {
          return cameraDirector.chaseFovWideningEnabled;
        },
        get shakeEnabled() {
          return cameraDirector.chaseShakeEnabled;
        },
        /**
         * Published camera position, so a browser gate can sample the pose per
         * animation frame and tell an animated mode change from a hard cut.
         */
        get positionXKm() {
          return cameraDirector.pose.positionKm.x;
        },
        get positionYKm() {
          return cameraDirector.pose.positionKm.y;
        },
        get positionZKm() {
          return cameraDirector.pose.positionKm.z;
        },
        /**
         * Distance from the published camera pose to the ship.
         *
         * The one number that proves "the camera follows the ship" from outside
         * the process: it stays at the arm length while chasing and grows to
         * astronomical values in observatory mode.
         */
        get shipDistanceKm() {
          return Math.hypot(
            (shipPositionsKm[shipPositionOffset] as number) - cameraDirector.pose.positionKm.x,
            (shipPositionsKm[shipPositionOffset + 1] as number) - cameraDirector.pose.positionKm.y,
            (shipPositionsKm[shipPositionOffset + 2] as number) - cameraDirector.pose.positionKm.z,
          );
        },
      },
      null,
    ),
  ) as CameraRuntimeDiagnostics;
  Object.defineProperty(canvas, 'solarVoyagerCamera', { value: cameraRuntimeDiagnostics });
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
  preparedWorld.osculatingConic.update(
    session.simulation.snapshot,
    Math.max(1, canvas.width),
    Math.max(1, canvas.height),
  );
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
  // T0104 handoff: the momentum axis scales off the vessel rest mass rather
  // than a copy of the default made before `VesselConfig` existed.
  stateVectorWidget = new StateVectorWidget(
    createStateVectorScales(session.simulation.vessel.restMassKg),
  );
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
    world.cameraDirector.pose.lookDirection,
  );
  world.systemMap.trajectoryOverlay.prepareCompilationPass(
    world.systemMap.cameraPositionKm,
    world.systemMap.cameraController.lookDirection,
  );
  postPipeline.warmUp(postProcessingEnabled);
  world.systemMap.render(renderer);
  world.trajectoryOverlay.hide();
  world.systemMap.trajectoryOverlay.hide();
  stateVectorWidget.update(session.simulation.snapshot, world.spaceScene.camera);
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
  activeWorld.shipVisual.enableLazyLoading();
  const focusLabel = document.querySelector('#camera-focus-label');
  if (!(focusLabel instanceof HTMLElement)) {
    throw new Error('Solar Voyager camera focus label was not found.');
  }
  // Feature-detected: browsers without the Gamepad API (or a hostile test
  // environment) get no poller at all rather than a port that would throw the
  // first time InputEngine called it.
  const gamepadSource =
    typeof navigator.getGamepads === 'function'
      ? new GamepadPoller(createBrowserGamepadHost(), session.settings.gamepad)
      : undefined;
  inputEngine = new InputEngine({
    bindings: session.settings.inputBindings,
    keyboardTarget: window as unknown as InputKeyboardTarget,
    onPauseRequested: handlePauseRequested,
    pointerLock: createCanvasPointerLockSurface(canvas),
    gamepad: gamepadSource,
    // A gamepad has no per-event target to gate on the way keyboard does;
    // this is the one shared UI-focus predicate every input source uses.
    isTextEntryActive: () => isEditableTarget(document.activeElement),
  });
  flightController = new FlightController({
    commands: sessionCommands,
    snapshot: currentInputSnapshot,
    vessel: session.simulation.vessel,
  });
  flightInputRouter = new FlightInputRouter(flightController, {
    commands: sessionCommands,
    snapshot: currentInputSnapshot,
  });
  hudInputRouter = new HudInputRouter({
    cyclePreset: () => {
      hudPresetStore.cyclePreset();
      persistHudPreferences();
    },
    toggleBodyLabels: () => {
      hudPresetStore.toggleBodyLabels();
      persistHudPreferences();
    },
  });
  inputEngine.setThrottleAxis(
    flightController.adoptCommandedThrottle(session.simulation.snapshot.throttle),
  );
  canvas.addEventListener('dblclick', handleCanvasDoubleClick);
  canvas.addEventListener('pointerdown', handleCanvasPickPointerDown);
  canvas.addEventListener('pointerup', handleCanvasPickPointerUp);
  // Frozen CI contract field: it counts one input owner per space-phase
  // activation, which is now the input engine rather than v1's mapper.
  runtimeResources.keyboardCommandMappers += 1;
  const catalogBodyIds = session.simulation.snapshot.bodyIds;
  const spaceCameraControls = new SharedCameraControls(
    activeWorld.cameraDirector,
    systemMapController,
    sessionCommands,
    catalogBodyIds,
  );
  const mapCameraControls = new SharedCameraControls(
    activeWorld.systemMap.cameraController,
    systemMapController,
    sessionCommands,
    catalogBodyIds,
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
