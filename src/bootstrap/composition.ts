import { h, render } from 'preact';

import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
  createRespawnPersistentState,
} from '../game/createNewGameSimulation.js';
import { FlightController } from '../game/flight/flightController.js';
import { FlightInputRouter } from '../game/flight/flightInputRouter.js';
import { createBodyRadiiKm } from '../game/hud/bodyMarkerCatalog.js';
import { pickBodyIndexAtPixel } from '../game/hud/bodyPicking.js';
import { HudInputRouter } from '../game/hud/hudInputRouter.js';
import { isEditableTarget } from '../game/input/bindings.js';
import { GamepadPoller, type GamepadHost } from '../game/input/gamepad.js';
import {
  InputEngine,
  type InputKeyboardTarget,
  type InputPointerMotionEvent,
  type PointerLockSurface,
} from '../game/input/inputEngine.js';
import { replacementInvalidatesRestorePoints, RestorePointRing } from '../game/restorePoints.js';
import { SaveRepository } from '../game/saveLoad.js';
import { SceneManager } from '../game/sceneManager.js';
import { GameSessionController } from '../game/sessionController.js';
import { SettingsRepository, type KeyValueStorage } from '../game/settings.js';
import { StartupTracker } from '../game/startupTracker.js';
import { SystemMapController, type SystemMapMode } from '../game/systemMapController.js';
import { readTrajectoryEventSummary } from '../game/trajectoryPredictionModel.js';
import { TrajectoryPredictionRefresh } from '../game/trajectoryPredictionRefresh.js';
import {
  isTrajectoryPredictionRuntimeEnabled,
  readTrajectoryPredictionTestHorizonSec,
  readTrajectoryPredictionTestPointCount,
} from '../game/trajectoryPredictionRuntimePolicy.js';
import { createTrajectoryPredictorClient } from '../game/trajectoryPredictorClient.js';
import { TutorialController } from '../game/tutorialController.js';
import { createEpochWorld, type EpochWorldMilestone } from '../render/createEpochWorld.js';
import { createRenderer, type RendererBootstrap } from '../render/createRenderer.js';
import { calculateDrawingBufferDimension } from '../render/drawingBufferSize.js';
import { ExposureController } from '../render/exposureController.js';
import { LightingPostPipeline } from '../render/lightingPostPipeline.js';
import { PerfGovernor, createPerfQualityState } from '../render/perfGovernor.js';
import { RelativisticVisualController } from '../render/relativisticVisualController.js';
import { RenderQualityController } from '../render/renderQualityController.js';
import { createStateVectorScales } from '../render/stateVectorModel.js';
import { StateVectorWidget } from '../render/stateVectorWidget.js';
import { measureStartupProbe, selectStartupQualityRung } from '../render/startupQuality.js';
import { RenderTelemetry, exposeRenderTelemetry } from '../render/telemetry.js';
import type { BurnLogView } from '../sim/ship/ledger.js';
import { DEFAULT_VESSEL } from '../sim/ship/vessel.js';
import type { Commands, SimSnapshot } from '../sim/simulationSnapshot.js';
import type { PredictorResponseMessage } from '../workers/predictorProtocol.js';
import { App } from '../ui/App.js';
import { CameraInputController } from '../ui/cameraInputController.js';
import { createPerfPanelStore } from '../ui/hud/perfPanelStore.js';
import { createHudPresetStore } from '../ui/hudPresetSignals.js';
import { createHudSignalStore } from '../ui/hudSignals.js';
import { createImpactSignalStore } from '../ui/impactSignals.js';
import { SharedCameraControls } from '../ui/sharedCameraControls.js';
import { observeStateVectorLayout } from '../ui/stateVectorLayoutObserver.js';
import { createStateVectorSignalStore } from '../ui/stateVectorSignals.js';
import {
  STATE_VECTOR_VIEWPORT_COMPONENT_COUNT,
  writeStateVectorViewportPixelsInto,
} from '../ui/stateVectorViewport.js';
import { updateStartupLoadingView, type StartupLoadingElements } from '../ui/startupLoadingView.js';
import { createSystemMapSignalStore } from '../ui/systemMapSignals.js';
import { createTrajectoryPredictionSignalStore } from '../ui/trajectoryPredictionSignals.js';

import {
  copyDiagnosticEntry,
  createBurnLogRuntimeDiagnostics,
  createCameraRuntimeDiagnostics,
  createExposureRuntimeDiagnostics,
  createRuntimeResourceCounts,
  createShipRuntimeDiagnostics,
  createSystemMapRuntimeDiagnostics,
  createTutorialRuntimeDiagnostics,
  defineRuntimeResourceCounts,
  defineStartupDiagnostic,
} from './diagnostics.js';
import { createFrameLoop, type FrameLoopRuntime } from './frameLoop.js';

const SOFTWARE_FALLBACK_EXPOSURE = 3;

/** The document surfaces `main.ts` resolves and hands to the composition root. */
export interface BootstrapShell {
  readonly appRoot: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly startupLoadingElements: StartupLoadingElements;
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

function writeCameraFocusLabel(bodyId: string): void {
  const focusLabel = document.querySelector('#camera-focus-label');
  if (focusLabel instanceof HTMLElement) {
    focusLabel.textContent = `Focus: ${bodyId.charAt(0).toUpperCase()}${bodyId.slice(1)}`;
  }
}

function readStartupResourceMetrics(renderer: RendererBootstrap['renderer']) {
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

/**
 * Builds and starts the game.
 *
 * The order below is the hard-won startup sequence — renderer, world, quality
 * probe, menu, space activation — and every milestone in it is measured
 * (`StartupTracker` throws if they arrive out of order). Two awaits are
 * load-bearing and keep their positions: the burn-log runtime chunk resolves
 * *after* `solarVoyagerStartup` is published, so a failed chunk still reports
 * `failedStage: 'boot'`; the renderer resolves *after* the resource counters
 * exist, so `canvasBindings` is the first thing counted.
 */
export async function startApplication(shell: BootstrapShell): Promise<void> {
  const { appRoot, canvas, startupLoadingElements } = shell;
  const startupTracker = new StartupTracker(performance.now());
  let startupRenderer: RendererBootstrap['renderer'] | null = null;
  defineStartupDiagnostic(
    canvas,
    startupTracker.createDiagnostic(
      () => startupRenderer?.info.programs?.length ?? startupTracker.programCountAtReady,
    ),
  );
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
      return await import('../ui/burnLogRuntime.js');
    } catch (cause: unknown) {
      return waitForStartupRetry(cause);
    }
  }

  const { BurnLogPanel, createBurnLogSignalStore } = await loadBurnLogRuntimeOrWait();
  const runtimeResources = createRuntimeResourceCounts();
  runtimeResources.canvasBindings += 1;
  defineRuntimeResourceCounts(canvas, runtimeResources);

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
  let trajectoryPredictionComplete = false;

  function invalidateTrajectoryPrediction(): void {
    runtime.trajectoryPredictionPending = true;
    trajectoryPredictionComplete = false;
    runtime.trajectoryPredictorClient?.invalidate();
  }

  function invalidateTrajectoryPredictionForWarpElapsed(): void {
    runtime.trajectoryPredictionPending = true;
    trajectoryPredictionComplete = false;
    runtime.trajectoryPredictorClient?.invalidateForWarpElapsed();
  }

  const hudStore = createHudSignalStore();
  const stateVectorStore = createStateVectorSignalStore();
  const hardwareWarning = contextReport.warningRequired
    ? { rendererName: contextReport.rendererName }
    : null;
  const resizeListenerOptions: AddEventListenerOptions = { passive: true };
  let cameraInput: CameraInputController | null = null;
  let systemMapCameraInput: CameraInputController | null = null;
  let stateVectorViewportElement: HTMLDivElement | null = null;
  let disposeStateVectorLayoutObservation: (() => void) | null = null;
  let runtimeDisposed = false;
  let pauseRequestCount = 0;
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
  const burnLogRuntimeDiagnostics = createBurnLogRuntimeDiagnostics(
    canvas,
    burnLogStore.publishCount,
    burnLogStore.structuralRebuildCount,
  );

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
      runtime.world?.cameraDirector.resetChase();
      impactStore.publish(replacement.snapshot, restorePoints.count);
      // ADR-034 §4: a restored session runs its persisted vessel, not DEFAULT_VESSEL,
      // and the regime scaling below depends on it — so the vessel goes first.
      runtime.flightController?.setVessel(replacement.vessel);
      runtime.stateVectorWidget?.setScales(createStateVectorScales(replacement.vessel.restMassKg));
      // Seed the analog lever from the restored state, or the router would command
      // the fresh engine value (0) over it on the next frame. `snapshot.throttle`
      // is already regime-scaled, so the controller un-scales it and both owners
      // of the lever are seeded from the one figure.
      runtime.inputEngine?.setThrottleAxis(
        runtime.flightController?.adoptCommandedThrottle(replacement.snapshot.throttle) ??
          replacement.snapshot.throttle,
      );
      burnLogStore.rebind(replacement.burnLog);
      updateBurnLogRuntime(replacement.burnLog);
      hudStore.publish(replacement.snapshot, performance.now());
      runtime.world?.trajectoryOverlay.hide();
      runtime.world?.systemMap.trajectoryOverlay.hide();
      if (runtime.systemMapDiagnostics !== null) {
        runtime.systemMapDiagnostics.trajectoryLineVisible = false;
        runtime.systemMapDiagnostics.trajectoryMarkersVisible = false;
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
      runtime.inputEngine?.applyBindings(settings.inputBindings);
      runtime.inputEngine?.applyGamepadSettings(settings.gamepad);
      runtime.inputEngine?.releaseHeldKeys();
      // A restore already carries the saved rotation rates: adopt them instead of
      // flushing the (now released) axes over them.
      if (origin === 'restore') runtime.flightController?.resetAxes();
      else runtime.flightController?.releaseAxes();
      runtime.world?.cameraDirector.applyCameraSettings(settings.camera);
      hudPresetStore.setPreset(settings.hud.preset);
      hudPresetStore.setBodyLabels(settings.hud.bodyLabels);
      runtime.exposureController?.setUserMode(settings.render.exposureMode);
      runtime.perfGovernor?.setLock(settings.qualityLock, performance.now());
    },
  });
  startupTracker.advance('context');
  updateStartupLoadingView(startupLoadingElements, startupTracker);
  canvas.dataset.startupStage = startupTracker.stage;
  const tutorialController = new TutorialController(session.settings.tutorial, session);
  let tutorialSnapshotObservationCount = 0;
  let tutorialBurnLogExpanded = false;
  let tutorialPerfPanelExpanded = false;
  let tutorialHardwareWarningAcknowledged = false;
  createTutorialRuntimeDiagnostics(canvas, tutorialController, {
    observerActive: () => runtime.tutorialFrameObserver !== null,
    snapshotObservationCount: () => tutorialSnapshotObservationCount,
  });
  tutorialController.subscribe((progress) => {
    runtime.tutorialFrameObserver = progress.status === 'active' ? observeTutorialSnapshot : null;
    // The guided tour walks the player through the osculating readout, the warp
    // ladder, the target selector and the burn log — every one of them an
    // Engineer-preset panel since T0112. Starting the tour on the Clean HUD would
    // ask the player to find controls that are not on screen, so accepting it
    // switches to the full instrument set. It persists: the tour genuinely changed
    // the HUD, and one press of the preset key changes it back.
    if (progress.status === 'active' && hudPresetStore.signals.preset.value !== 'engineer') {
      hudPresetStore.setPreset('engineer');
      persistHudPreferences();
    }
  });
  hudStore.publish(session.simulation.snapshot, 0);
  burnLogStore.publish();
  updateBurnLogRuntime(session.simulation.burnLog);
  stateVectorStore.publish(session.simulation.snapshot, 0);

  function handleTrajectoryPredictionResult(result: PredictorResponseMessage): void {
    runtime.trajectoryPredictionPending = false;
    if (result.type === 'error') {
      trajectoryPredictionComplete = false;
      runtime.world?.trajectoryOverlay.hide();
      runtime.world?.systemMap.trajectoryOverlay.hide();
      if (runtime.systemMapDiagnostics !== null) {
        runtime.systemMapDiagnostics.trajectoryLineVisible = false;
        runtime.systemMapDiagnostics.trajectoryMarkersVisible = false;
      }
      trajectoryPredictionRefresh.clear();
      trajectoryPredictionStore.publishError();
      canvas.dataset.trajectoryReady = 'error';
      return;
    }
    const snapshot = session.simulation.snapshot;
    try {
      runtime.world?.trajectoryOverlay.applyPrediction(result, snapshot.dominantBodyIndex);
      runtime.world?.systemMap.trajectoryOverlay.applyPrediction(
        result,
        snapshot.dominantBodyIndex,
      );
      trajectoryPredictionRefresh.acceptPrediction(result.points);
      trajectoryPredictionStore.publishSuccess(
        readTrajectoryEventSummary(result.events),
        snapshot.bodyIds,
        snapshot.simTimeSec,
      );
      trajectoryPredictionComplete = true;
      canvas.dataset.trajectoryReady = 'true';
      if (runtime.world !== null && runtime.systemMapDiagnostics !== null) {
        runtime.systemMapDiagnostics.trajectoryLineVisible =
          runtime.world.systemMap.trajectoryOverlay.line.visible;
        runtime.systemMapDiagnostics.trajectoryMarkersVisible =
          runtime.world.systemMap.trajectoryOverlay.markers.visible;
      }
    } catch {
      trajectoryPredictionComplete = false;
      runtime.world?.trajectoryOverlay.hide();
      runtime.world?.systemMap.trajectoryOverlay.hide();
      if (runtime.systemMapDiagnostics !== null) {
        runtime.systemMapDiagnostics.trajectoryLineVisible = false;
        runtime.systemMapDiagnostics.trajectoryMarkersVisible = false;
      }
      trajectoryPredictionRefresh.clear();
      trajectoryPredictionStore.publishError();
      canvas.dataset.trajectoryReady = 'error';
    }
  }

  function startTrajectoryPredictionRuntime(): void {
    if (!isTrajectoryPredictionRuntimeEnabled(window) || runtime.trajectoryPredictorClient !== null)
      return;
    const testHorizonSec = readTrajectoryPredictionTestHorizonSec(window);
    const testPointCount = readTrajectoryPredictionTestPointCount(window);
    const trajectoryWorker = new Worker(
      new URL('../workers/predictor.worker.ts', import.meta.url),
      { type: 'module' },
    );
    runtimeResources.trajectoryWorkers += 1;
    runtime.trajectoryPredictorClient = createTrajectoryPredictorClient(
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
    runtime.trajectoryPredictorClient?.dispose();
    cameraInput?.dispose();
    systemMapCameraInput?.dispose();
    canvas.removeEventListener('dblclick', handleCanvasDoubleClick);
    canvas.removeEventListener('pointerdown', handleCanvasPickPointerDown);
    canvas.removeEventListener('pointerup', handleCanvasPickPointerUp);
    runtime.inputEngine?.dispose();
    disposeStateVectorLayoutObservation?.();
    runtime.world?.systemMap.dispose();
    runtime.postPipeline?.dispose();
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
   * Two things outrank pause:
   *
   *  - the system map, while it is open. `SystemMapPanelModel` already calls
   *    `preventDefault()` on that Escape, and `blocksGameKey` honours it — but only
   *    if the map's `window` listener runs first, and it does not always. Entering
   *    from the main menu mounts `SystemMapPanel` in a Preact microtask that races
   *    the `InputEngine` construction in `activateSpacePhaseRuntime`, so with
   *    `?autostart=1` the map wins and from the menu the engine wins, and the same
   *    keypress then closed the map *and* paused the game. The rule is stated here
   *    instead of inferred from listener order; either ordering now gives the same
   *    result.
   *  - a surface-contact freeze: the core is already inert and `ImpactOverlay` is
   *    the only way out, so a pause dialog on top of it would hide recovery.
   *
   * The hardware-acceleration warning deliberately does *not* suppress the pause.
   * Making it do so was the first design here and it was wrong twice over: a
   * software-rendering player would be unable to pause at all until they dismissed
   * a banner, and it solved a stacking problem that belongs to CSS. The warning
   * sits above the pause layers in the z-ladder instead, so it stays readable and
   * clickable with the menu open.
   */
  function handlePauseRequested(): void {
    pauseRequestCount += 1;
    canvas.dataset.pauseRequests = String(pauseRequestCount);
    if (sceneManager.phase !== 'space') return;
    if (systemMapController.mode !== 'space') return;
    if (session.simulation.snapshot.impactOccurred === 1) return;
    sceneManager.togglePause();
  }

  /**
   * Interim mouse-look activation. Single click stays with the v1 orbit-drag
   * camera; T0110's chase camera owns the real gesture.
   */
  function handleCanvasDoubleClick(): void {
    const inputEngine = runtime.inputEngine;
    if (inputEngine === null || inputEngine.pointerLocked) return;
    inputEngine.requestPointerLock();
  }

  function updateStateVectorViewport(): void {
    const stateVectorWidget = runtime.stateVectorWidget;
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
        runtime.world?.cameraDirector.focusObservatoryBody(bodyId);
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

  /**
   * Rewrites the focus label from the camera's own idea of what it is looking at.
   *
   * Every site that can move the camera focus calls this instead of naming a body
   * itself: since T0110 the camera can be following the ship while the map and the
   * navigation target sit on something else, so "the id I just asked for" and "the
   * thing on screen" are no longer the same string.
   */
  function refreshCameraFocusLabel(): void {
    const director = runtime.world?.cameraDirector;
    if (director !== undefined) writeCameraFocusLabel(director.focusId);
  }

  /**
   * True while the simulation is held: paused, or back at the main menu.
   *
   * A module-level mirror of `SceneManager.state` rather than a read through the
   * manager, because `handleSystemMapModeChange` is handed to the
   * `SystemMapController` constructor and `sceneManager` is created later — a
   * direct read would be a temporal-dead-zone hazard for no benefit.
   */
  let sceneHalted = false;

  /**
   * Applies camera-input enablement from the map mode and the halt together.
   *
   * The frame loop gates the flight input it owns, but `CameraInputController`
   * holds its own `keydown`, pointer and wheel listeners, so without this the
   * player could re-aim the camera and cycle focus with the pause dialog on
   * screen — against a director whose `update` is being fed a zero delta, so the
   * pose freezes mid-transition.
   */
  function applyCameraInputEnablement(mode: SystemMapMode): void {
    cameraInput?.setEnabled(!sceneHalted && mode === 'space');
    systemMapCameraInput?.setEnabled(!sceneHalted && mode === 'system-map');
  }

  function handleSystemMapModeChange(mode: SystemMapMode): void {
    systemMapSignals.publishMode(mode);
    applyCameraInputEnablement(mode);
    canvas.dataset.systemMapMode = mode;
    if (runtime.systemMapDiagnostics !== null) {
      runtime.systemMapDiagnostics.mode = mode;
      runtime.systemMapDiagnostics.spaceRenderCountAtModeChange =
        runtime.systemMapDiagnostics.spaceRenderCount;
    }
    tutorialController.observeMap(mode === 'system-map');
  }

  function handleSystemMapFocusChange(bodyId: string): void {
    systemMapSignals.publishFocus(bodyId);
    runtime.world?.cameraDirector.focusObservatoryBody(bodyId);
    runtime.world?.systemMap.focusBody(bodyId);
    refreshCameraFocusLabel();
    if (runtime.systemMapDiagnostics !== null) runtime.systemMapDiagnostics.focusBodyId = bodyId;
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
    const world = runtime.world;
    if (world !== null) {
      world.spaceScene.camera.aspect = clientWidth / clientHeight;
      world.spaceScene.camera.updateProjectionMatrix();
      runtime.postPipeline?.resize(clientWidth, clientHeight, pixelRatio);
      world.trajectoryOverlay.setViewport(
        Math.max(1, canvas.width),
        Math.max(1, canvas.height),
        pixelRatio,
      );
      world.systemMap.resize(Math.max(1, clientWidth), Math.max(1, clientHeight), pixelRatio);
      updateStateVectorViewport();
    }
  }

  const sceneManager = new SceneManager(session);
  const hudPresetStore = createHudPresetStore(
    session.settings.hud.preset,
    session.settings.hud.bodyLabels,
  );
  /** Catalog mean radii for angular-disc picking, in `snapshot.bodyIds` order. */
  const bodyRadiiKm = createBodyRadiiKm();

  /**
   * The state the frame loop and this module share, and the loop built over it.
   *
   * Declared here because every readonly dependency above must already exist, and
   * before the autostart branch below because that is the first thing that can
   * *call* one of the hoisted functions that read it.
   */
  const runtime: FrameLoopRuntime = {
    burnLogStore,
    canvas,
    exposureController: null,
    hudPresetStore,
    hudStore,
    impactStore,
    invalidateTrajectoryPredictionForWarpElapsed,
    perfPanelStore,
    postProcessingEnabled,
    renderer,
    restorePoints,
    sceneManager,
    session,
    startupTracker,
    stateVectorStore,
    systemMapController,
    telemetry,
    trajectoryPredictionRefresh,
    trajectoryPredictionStore,
    updateBurnLogRuntime,

    flightController: null,
    flightInputRouter: null,
    hudInputRouter: null,
    inputEngine: null,
    perfGovernor: null,
    postPipeline: null,
    relativisticVisuals: null,
    stateVectorWidget: null,
    systemMapDiagnostics: null,
    trajectoryPredictionPending: false,
    trajectoryPredictorClient: null,
    tutorialFrameObserver: null,
    world: null,
  };
  const renderFrame = createFrameLoop(runtime);
  runtime.tutorialFrameObserver =
    tutorialController.progress.status === 'active' ? observeTutorialSnapshot : null;

  /**
   * Preset and label changes are persisted, but a failed write must not desync the
   * live HUD from what the player just asked for: the ring has already moved when
   * this runs, so the store is the source of truth and the profile write is
   * best-effort (the settings panel surfaces failures on its own status line).
   */
  function persistHudPreferences(): void {
    session.setHudPreferences(
      hudPresetStore.signals.preset.value,
      hudPresetStore.signals.bodyLabels.value,
    );
  }

  sceneManager.subscribe((state) => {
    canvas.dataset.sceneState = state;
    sceneHalted = state !== 'space';
    applyCameraInputEnablement(systemMapController.mode);
    // Drop every latched key on both edges: a key held while clicking a menu
    // button must not fire into the ship on resume, and a key held at the moment
    // of pausing must not stay down for the whole menu visit. `resetAxes`, not
    // `releaseAxes` — the latter issues `rotate(0,0,0)` and would silently stop a
    // spinning ship every time the player paused.
    runtime.inputEngine?.releaseHeldKeys();
    runtime.flightController?.resetAxes();
    if (state !== 'space') runtime.inputEngine?.releasePointerLock();
  });
  canvas.dataset.sceneState = sceneManager.state;

  const CLICK_PICK_MAX_MOVEMENT_PX = 4;
  const CLICK_PICK_MAX_DURATION_MS = 400;
  let pickPointerId = -1;
  let pickPointerDownX = 0;
  let pickPointerDownY = 0;
  let pickPointerDownMs = 0;
  let pickAttemptCount = 0;

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
    const world = runtime.world;
    if (world === null || sceneHalted) return;
    if (systemMapController.mode !== 'space') return;
    if (runtime.inputEngine?.pointerLocked === true) return;
    if (event.timeStamp - pickPointerDownMs > CLICK_PICK_MAX_DURATION_MS) return;
    if (
      Math.hypot(event.clientX - pickPointerDownX, event.clientY - pickPointerDownY) >
      CLICK_PICK_MAX_MOVEMENT_PX
    ) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // Counted before the hit test, so a browser gate can tell "the gesture was
    // recognised and hit empty sky" from "the gesture never got here" — the two
    // failure modes look identical from `pickedBodyId` alone.
    pickAttemptCount += 1;
    canvas.dataset.pickAttempts = String(pickAttemptCount);
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

  async function prepareApplication(): Promise<void> {
    canvas.dataset.depthStrategy = contextReport.depthStrategy;
    canvas.dataset.rendererName = contextReport.rendererName;
    canvas.dataset.rendererReady = 'true';
    canvas.dataset.softwareRasterizer = String(contextReport.softwareRasterizer);
    resizeRenderer();
    const world = await createEpochWorld(renderer, {
      initialViewportWidthPx: Math.max(1, canvas.clientWidth),
      initialViewportHeightPx: Math.max(1, canvas.clientHeight),
      onProgress: publishStartupMilestone,
      // The warm-up camera hangs off the chase arm, so it needs the attitude the
      // session actually starts at rather than an identity guess — that is what
      // puts the shader warm-up at the same viewpoint as the first real frame.
      initialShipAttitudeQuaternion: session.simulation.snapshot.attitudeQuaternion,
    });
    runtime.world = world;
    runtimeResources.epochWorldCreations += 1;
    runtimeResources.shipVisualCreations += 1;
    runtimeResources.cameraDirectors += 1;
    const shipVisual = world.shipVisual;
    const cameraDirector = world.cameraDirector;
    cameraDirector.applyCameraSettings(session.settings.camera);
    createShipRuntimeDiagnostics(canvas, shipVisual, cameraDirector);
    const shipPositionsKm = world.positionsKm;
    const shipPositionOffset = world.shipPositionOffset;
    createCameraRuntimeDiagnostics(canvas, cameraDirector, shipPositionsKm, shipPositionOffset);
    world.systemMap.focusBody(systemMapController.focusId);
    runtime.systemMapDiagnostics = createSystemMapRuntimeDiagnostics(canvas, {
      scene: world.systemMap.diagnostics,
      mode: systemMapController.mode,
      focusBodyId: systemMapController.focusId,
      simulationTimeSec: session.simulation.snapshot.simTimeSec,
    });
    canvas.dataset.systemMapMode = systemMapController.mode;
    const preparedWorld = world;
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
    const stateVectorWidget = new StateVectorWidget(
      createStateVectorScales(session.simulation.vessel.restMassKg),
    );
    runtime.stateVectorWidget = stateVectorWidget;
    // T0127 — the direct path's compensating gain moves into the pipeline, so
    // `ExposureController` is the only writer of `toneMappingExposure` and its
    // `fixed` mode still reproduces both pre-T0127 paths exactly.
    const postPipeline = new LightingPostPipeline(
      renderer,
      world.spaceScene.scene,
      world.spaceScene.camera,
      undefined,
      postProcessingEnabled ? 1 : SOFTWARE_FALLBACK_EXPOSURE,
    );
    runtime.postPipeline = postPipeline;
    const exposureController = new ExposureController({
      sink: postPipeline,
      positionsKm: world.positionsKm,
      sunIndex: world.sunIndex,
      bodyRadiiKm: world.bodyRadiiKm,
      bodyGeometricAlbedos: world.bodyGeometricAlbedos,
      mode: session.settings.render.exposureMode,
    });
    runtime.exposureController = exposureController;
    createExposureRuntimeDiagnostics(canvas, exposureController);
    const relativisticVisuals = new RelativisticVisualController({
      postPass: postPipeline.relativisticPass,
      spaceScene: world.spaceScene,
      starfield: world.starfield,
    });
    runtime.relativisticVisuals = relativisticVisuals;
    const qualityController = new RenderQualityController({
      assetLoader: world.visualSystem,
      exposure: exposureController,
      pipeline: postPipeline,
      postProcessingAvailable: postProcessingEnabled,
      proceduralSun: world.proceduralSun,
      renderer,
      relativisticVisuals,
      starfield: world.starfield,
      visualSystem: world.visualSystem,
    });
    runtime.perfGovernor = new PerfGovernor({
      application: qualityController,
      initialAutoRung,
      initialLock: session.settings.qualityLock,
      state: perfQualityState,
      telemetry,
    });
    // Snap rather than fade: there is no previous frame to have adapted from.
    exposureController.reset(world.cameraPositionKm, session.simulation.snapshot.dominantBodyIndex);
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
    startupTracker.recordReady(performance.now(), readStartupResourceMetrics(renderer));
    updateStartupLoadingView(startupLoadingElements, startupTracker);
    canvas.dataset.startupStage = startupTracker.stage;
  }

  async function activateSpacePhaseRuntime(): Promise<void> {
    runtimeResources.spacePhaseActivations += 1;
    await applicationReady;
    if (startupFailed) return;
    await Promise.resolve();
    const activeWorld = runtime.world;
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
    const inputEngine = new InputEngine({
      bindings: session.settings.inputBindings,
      keyboardTarget: window as unknown as InputKeyboardTarget,
      onPauseRequested: handlePauseRequested,
      pointerLock: createCanvasPointerLockSurface(canvas),
      gamepad: gamepadSource,
      // A gamepad has no per-event target to gate on the way keyboard does;
      // this is the one shared UI-focus predicate every input source uses.
      isTextEntryActive: () => isEditableTarget(document.activeElement),
    });
    runtime.inputEngine = inputEngine;
    const flightController = new FlightController({
      commands: sessionCommands,
      snapshot: currentInputSnapshot,
      vessel: session.simulation.vessel,
    });
    runtime.flightController = flightController;
    runtime.flightInputRouter = new FlightInputRouter(flightController, {
      commands: sessionCommands,
      snapshot: currentInputSnapshot,
    });
    runtime.hudInputRouter = new HudInputRouter({
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
      !sceneHalted && systemMapController.mode === 'space',
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
}
