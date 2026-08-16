import type { CameraInputRouter } from '../game/cameraInputRouter.js';
import type { CruiseDirector } from '../game/flight/cruiseDirector.js';
import type { AudioSystem } from '../game/audio/audioSystem.js';
import type { FlightController } from '../game/flight/flightController.js';
import type { FlightInputRouter } from '../game/flight/flightInputRouter.js';
import type { HudInputRouter } from '../game/hud/hudInputRouter.js';
import type { InputEngine } from '../game/input/inputEngine.js';
import type { PhotoCaptureController } from '../game/photo/photoCapture.js';
import type { RestorePointRing } from '../game/restorePoints.js';
import type { SceneManager } from '../game/sceneManager.js';
import type { GameSessionController } from '../game/sessionController.js';
import type { StartupTracker } from '../game/startupTracker.js';
import type { SystemMapController } from '../game/systemMapController.js';
import type { TrajectoryPredictionRefresh } from '../game/trajectoryPredictionRefresh.js';
import type { TrajectoryPredictorClient } from '../game/trajectoryPredictorClient.js';
import { applyCameraPose } from '../render/cameraRig.js';
import type { EpochWorld } from '../render/createEpochWorld.js';
import type { RendererBootstrap } from '../render/createRenderer.js';
import type { ExposureController } from '../render/exposureController.js';
import type { LightingPostPipeline } from '../render/lightingPostPipeline.js';
import type { PerfGovernor } from '../render/perfGovernor.js';
import type { RelativisticVisualController } from '../render/relativisticVisualController.js';
import type { StateVectorWidget } from '../render/stateVectorWidget.js';
import type { RenderTelemetry } from '../render/telemetry.js';
import type { BurnLogView } from '../sim/ship/ledger.js';
import type { SimSnapshot } from '../sim/simulationSnapshot.js';
import type { BurnLogSignalStore } from '../ui/burnLogSignals.js';
import type { PerfPanelStore } from '../ui/hud/perfPanelStore.js';
import type { HudPresetStore } from '../ui/hudPresetSignals.js';
import type { HudSignalStore } from '../ui/hudSignals.js';
import type { ImpactSignalStore } from '../ui/impactSignals.js';
import type { StateVectorSignalStore } from '../ui/stateVectorSignals.js';
import type { TrajectoryPredictionSignalStore } from '../ui/trajectoryPredictionSignals.js';

import type { SystemMapRuntimeDiagnostics } from './diagnostics.js';

/**
 * State the frame loop and the composition root both touch.
 *
 * `main.ts` used to hold this as module-level `let`s closed over by both halves;
 * two modules cannot share a `let`, so the mutable half becomes one object whose
 * field names are the variable names they replace. It is allocated once, at
 * composition time, and only ever read or assigned afterwards — the frame path
 * stays allocation-free (performance-spec §5).
 *
 * Only genuinely shared state belongs here. Composition-local state the loop
 * never reads (camera input controllers, disposal flags, the click-pick pointer
 * fields) stays local to `composition.ts`.
 */
export interface FrameLoopRuntime {
  /** T0144 — decide from the snapshot, then move the graph. Silent until unlocked. */
  readonly audio: AudioSystem;
  readonly burnLogStore: BurnLogSignalStore;
  readonly canvas: HTMLCanvasElement;
  readonly hudPresetStore: HudPresetStore;
  readonly hudStore: HudSignalStore;
  readonly impactStore: ImpactSignalStore;
  /** Warp-elapsed invalidation, owned by composition's predictor lifecycle. */
  readonly invalidateTrajectoryPredictionForWarpElapsed: () => void;
  readonly perfPanelStore: PerfPanelStore;
  readonly postProcessingEnabled: boolean;
  readonly renderer: RendererBootstrap['renderer'];
  readonly restorePoints: RestorePointRing;
  readonly sceneManager: SceneManager;
  readonly session: GameSessionController;
  readonly startupTracker: StartupTracker;
  readonly stateVectorStore: StateVectorSignalStore;
  readonly systemMapController: SystemMapController;
  readonly telemetry: RenderTelemetry;
  readonly trajectoryPredictionRefresh: TrajectoryPredictionRefresh;
  readonly trajectoryPredictionStore: TrajectoryPredictionSignalStore;
  readonly updateBurnLogRuntime: (view: BurnLogView) => void;

  cameraInputRouter: CameraInputRouter | null;
  cruiseDirector: CruiseDirector | null;
  exposureController: ExposureController | null;
  flightController: FlightController | null;
  flightInputRouter: FlightInputRouter | null;
  hudInputRouter: HudInputRouter | null;
  inputEngine: InputEngine | null;
  perfGovernor: PerfGovernor | null;
  photoCapture: PhotoCaptureController | null;
  postPipeline: LightingPostPipeline | null;
  relativisticVisuals: RelativisticVisualController | null;
  stateVectorWidget: StateVectorWidget | null;
  systemMapDiagnostics: SystemMapRuntimeDiagnostics | null;
  trajectoryPredictionPending: boolean;
  trajectoryPredictorClient: TrajectoryPredictorClient | null;
  tutorialFrameObserver: ((snapshot: SimSnapshot) => void) | null;
  world: EpochWorld | null;
}

/**
 * The animation-frame callback: `commands → sim.step() → snapshot → render + UI`,
 * instrumented at each seam (`docs/architecture.md`).
 *
 * The three telemetry windows are load-bearing and their boundaries are exact:
 * `simulationEndMs` is also `uiStartMs`, and the UI figure reported to
 * `endFrame` is the HUD window plus the perf-panel window.
 */
export function createFrameLoop(runtime: FrameLoopRuntime): (nowMs: number) => void {
  const {
    audio,
    burnLogStore,
    canvas,
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
  } = runtime;

  function renderFrame(nowMs: number): void {
    const world = runtime.world;
    const postPipeline = runtime.postPipeline;
    const relativisticVisuals = runtime.relativisticVisuals;
    const stateVectorWidget = runtime.stateVectorWidget;
    if (
      world === null ||
      postPipeline === null ||
      relativisticVisuals === null ||
      stateVectorWidget === null
    ) {
      return;
    }
    const systemMapRuntimeDiagnostics = runtime.systemMapDiagnostics;
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
    const inputEngine = runtime.inputEngine;
    const flightInputRouter = runtime.flightInputRouter;
    const flightController = runtime.flightController;
    const cruiseDirector = runtime.cruiseDirector;
    const simulationStartMs = performance.now();
    if (
      !halted &&
      inputEngine !== null &&
      flightInputRouter !== null &&
      flightController !== null
    ) {
      const inputFrame = inputEngine.poll(deltaSec);
      flightInputRouter.apply(inputFrame);
      runtime.hudInputRouter?.apply(inputFrame);
      runtime.cameraInputRouter?.apply(inputFrame, deltaSec);
      flightController.update(deltaSec);
      // T0116 — exactly one owner of attitude and throttle per frame. The
      // director's `update` runs unconditionally because an aborted cruise is
      // still decompressing the warp; `active` is what arbitrates the ship.
      cruiseDirector?.update(deltaSec);
      if (cruiseDirector === null || !cruiseDirector.active) flightController.update(deltaSec);
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
    if (runtime.trajectoryPredictionPending) {
      trajectoryPredictionStore.publishPending(snapshot.targetBodyIndex);
      canvas.dataset.trajectoryReady = 'pending';
      runtime.trajectoryPredictionPending = false;
    }
    trajectoryPredictionStore.publishTime(snapshot.simTimeSec, nowMs);
    trajectoryPredictionRefresh.update(
      snapshot.simTimeSec,
      invalidateTrajectoryPredictionForWarpElapsed,
    );
    runtime.trajectoryPredictorClient?.update(snapshot);
    const simulationEndMs = performance.now();
    const uiStartMs = simulationEndMs;
    const hudPublished = hudStore.publish(snapshot, nowMs);
    if (hudPublished) {
      burnLogStore.publish();
      updateBurnLogRuntime(session.simulation.burnLog);
      runtime.tutorialFrameObserver?.(snapshot);
      // T0125 — peak gamma for photo metadata, on the tick that already exists.
      runtime.photoCapture?.observe(snapshot);
    }
    stateVectorStore.publish(snapshot, nowMs);
    // T0144 — a snapshot consumer, so it belongs in the UI window rather than the
    // render one. `deltaSec`, never `simDeltaSec`: a paused game must still finish
    // its music crossfade and its Kubrick ramp instead of freezing mid-blend for
    // the length of a menu visit. Camera *mode* cannot change inside a frame, so
    // reading it before `cameraDirector.update` below is the same value.
    audio.update(snapshot, cameraDirector.mode, halted, deltaSec);
    const hudEndMs = performance.now();
    const renderStartMs = performance.now();
    // T0110 — the director runs both cameras and publishes one pose; the rig is
    // the only place that touches three.js. `world.cameraPositionKm` is a live
    // reference to that pose, so every camera-relative consumer below sees it.
    cameraDirector.update(simDeltaSec, snapshot);
    applyCameraPose(spaceScene.camera, cameraDirector.pose);
    // T0125 — photo mode hides the HUD. The DOM overlay was never in a canvas
    // capture; this is for the player's eye. An unchanged signal write is a
    // no-op, so no change detection of its own is needed.
    const hudHidden = cameraDirector.mode === 'cinematic';
    hudPresetStore.setHudHidden(hudHidden);
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
      // T0127 — display-only, driven by the wall delta because photopic
      // adaptation is a wall-clock phenomenon, and placed after the camera pose
      // so it keys off the position this frame actually renders from.
      runtime.exposureController?.update(deltaSec, cameraPositionKm, snapshot.dominantBodyIndex);
      osculatingConic.update(snapshot, canvas.width, canvas.height);
      spaceScene.updateCameraRelative(cameraPositionKm);
      telemetry.beginGpuTimer();
      postPipeline.render(postProcessingEnabled);
      // The widget draws into the canvas rather than the DOM, so unlike the rest
      // of the HUD it would appear in a photo. Hiding the HUD hides it too.
      if (!hudHidden) stateVectorWidget.render(renderer);
      telemetry.recordStateVectorWidgetMs(hudHidden ? 0 : stateVectorWidget.lastRenderMs);
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
    runtime.perfGovernor?.update(nowMs, telemetry.snapshot);
    requestAnimationFrame(renderFrame);
  }

  return renderFrame;
}
