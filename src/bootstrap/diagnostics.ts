import type { CameraDirector, CameraMode } from '../game/cameraDirector.js';
import type { CaptureStatus, PhotoCaptureController } from '../game/photo/photoCapture.js';
import type { StartupDiagnostic } from '../game/startupTracker.js';
import type { SystemMapMode } from '../game/systemMapController.js';
import type { TutorialController } from '../game/tutorialController.js';
import type { BodyModelLoadState } from '../render/bodyVisualSystem.js';
import type { EpochWorld } from '../render/createEpochWorld.js';
import type { ExposureController } from '../render/exposureController.js';
import { SHIP_ASSET_ID, type ShipVisual } from '../render/shipVisual.js';
import type { BurnLogEntry } from '../sim/ship/ledger.js';
import type { AudioSystem } from '../game/audio/audioSystem.js';

/**
 * The frozen browser-diagnostic contract: ten `canvas.solarVoyager*` objects
 * that roughly 25 Playwright gates read by property name.
 *
 * Every definition site is a literal
 * `Object.defineProperty(canvas, 'solarVoyager…', { value })` — non-writable,
 * non-configurable, non-enumerable — and `tests/architecture/diagnosticsContract.test.ts`
 * asserts that both the member lists and the definition sites are exactly these.
 * Extend them; never drop a field (`AGENTS.md` Global Constraints).
 *
 * `solarVoyagerTelemetry` is the ninth canvas property and is not here:
 * `render/telemetry.ts` owns it behind `RENDER_TELEMETRY_PROPERTY`.
 */

export interface RuntimeResourceCounts {
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

export interface ShipRuntimeDiagnostics {
  readonly loadState: BodyModelLoadState;
  readonly resolved: boolean;
  readonly diameterPx: number;
  readonly pointOpacity: number;
  readonly modelOpacity: number;
  readonly noseAlignment: number;
  readonly noseNodeAlignment: number;
  readonly focused: boolean;
}

export interface CameraRuntimeDiagnostics {
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
  /** Cinematic mode (T0125); zero and inert in every other mode. */
  readonly cinematicRollRad: number;
  readonly cinematicFovDeg: number;
  readonly cinematicDrifting: boolean;
  readonly directFocusEnabled: boolean;
}

/**
 * Photo capture (T0125), so a browser gate can prove a capture happened without
 * a download landing on the runner's disk: how many were taken, how many were
 * dropped as re-entrant, what the sink named the last one and what it stamped.
 */
export interface PhotoRuntimeDiagnostics {
  readonly status: CaptureStatus;
  readonly captureCount: number;
  readonly dropCount: number;
  readonly lastError: string | null;
  readonly lastFilename: string | null;
  readonly lastSimTimeSec: number;
  readonly lastTauSec: number;
  readonly lastDominantBodyId: string | null;
  readonly lastGammaMax: number;
  readonly lastPositionXKm: number;
  readonly lastPositionYKm: number;
  readonly lastPositionZKm: number;
}

/**
 * Adaptive exposure state (T0127), so a browser gate can prove the display-only
 * controller from outside the process: which mode is in force, what the scene key
 * says, and what actually reached `toneMappingExposure`.
 */
export interface ExposureRuntimeDiagnostics {
  readonly mode: string;
  readonly userMode: string;
  readonly governorMode: string;
  readonly exposure: number;
  readonly targetExposure: number;
  readonly sceneLuminance: number;
}

export interface SystemMapRuntimeDiagnostics {
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

export interface MutableBurnLogDiagnosticEntry {
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

export interface BurnLogRuntimeDiagnostics {
  readonly identity: 'solarVoyagerBurnLog.v1';
  readonly active: MutableBurnLogDiagnosticEntry;
  readonly latest: MutableBurnLogDiagnosticEntry;
  activeAvailable: boolean;
  latestAvailable: boolean;
  completedCount: number;
  publishCount: number;
  structuralRebuildCount: number;
}

export interface TutorialRuntimeDiagnostics {
  readonly status: string;
  readonly stepId: string;
  readonly transitionCount: number;
  readonly observerActive: boolean;
  readonly snapshotObservationCount: number;
}

/** Composition-owned state the tutorial diagnostic reports but does not own. */
export interface TutorialDiagnosticPorts {
  readonly observerActive: () => boolean;
  readonly snapshotObservationCount: () => number;
}

export interface SystemMapDiagnosticSeed {
  readonly scene: EpochWorld['systemMap']['diagnostics'];
  readonly mode: SystemMapMode;
  readonly focusBodyId: string;
  readonly simulationTimeSec: number;
}

export function createDiagnosticEntry(): MutableBurnLogDiagnosticEntry {
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

export function copyDiagnosticEntry(
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

export function createRuntimeResourceCounts(): RuntimeResourceCounts {
  return {
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
}

/**
 * Published before the burn-log runtime chunk is awaited, so a failed chunk
 * still leaves a readable `stage: 'failed'` / `failedStage: 'boot'` diagnostic
 * (`tools/tests/startupRegression.mjs`, recoverable bootstrap failure).
 */
export function defineStartupDiagnostic(
  canvas: HTMLCanvasElement,
  diagnostic: StartupDiagnostic,
): void {
  Object.defineProperty(canvas, 'solarVoyagerStartup', { value: diagnostic });
}

export function defineRuntimeResourceCounts(
  canvas: HTMLCanvasElement,
  counts: RuntimeResourceCounts,
): void {
  Object.defineProperty(canvas, 'solarVoyagerRuntimeResources', { value: counts });
}

export function createBurnLogRuntimeDiagnostics(
  canvas: HTMLCanvasElement,
  publishCount: number,
  structuralRebuildCount: number,
): BurnLogRuntimeDiagnostics {
  const diagnostics: BurnLogRuntimeDiagnostics = {
    identity: 'solarVoyagerBurnLog.v1',
    active: createDiagnosticEntry(),
    latest: createDiagnosticEntry(),
    activeAvailable: false,
    latestAvailable: false,
    completedCount: 0,
    publishCount,
    structuralRebuildCount,
  };
  Object.defineProperty(canvas, 'solarVoyagerBurnLog', { value: diagnostics });
  return diagnostics;
}

export function createTutorialRuntimeDiagnostics(
  canvas: HTMLCanvasElement,
  controller: TutorialController,
  ports: TutorialDiagnosticPorts,
): TutorialRuntimeDiagnostics {
  const diagnostics = Object.freeze(
    Object.setPrototypeOf(
      {
        get status() {
          return controller.progress.status;
        },
        get stepId() {
          return controller.progress.stepId;
        },
        get transitionCount() {
          return controller.transitionCount;
        },
        get observerActive() {
          return ports.observerActive();
        },
        get snapshotObservationCount() {
          return ports.snapshotObservationCount();
        },
      },
      null,
    ),
  ) as TutorialRuntimeDiagnostics;
  Object.defineProperty(canvas, 'solarVoyagerTutorial', { value: diagnostics });
  return diagnostics;
}

export function createShipRuntimeDiagnostics(
  canvas: HTMLCanvasElement,
  shipVisual: ShipVisual,
  cameraDirector: CameraDirector,
): ShipRuntimeDiagnostics {
  const diagnostics = Object.freeze(
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
  Object.defineProperty(canvas, 'solarVoyagerShip', { value: diagnostics });
  return diagnostics;
}

export function createCameraRuntimeDiagnostics(
  canvas: HTMLCanvasElement,
  cameraDirector: CameraDirector,
  shipPositionsKm: Float64Array,
  shipPositionOffset: number,
): CameraRuntimeDiagnostics {
  const diagnostics = Object.freeze(
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
        get cinematicRollRad() {
          return cameraDirector.cinematicRollRad;
        },
        get cinematicFovDeg() {
          return cameraDirector.cinematicFovDeg;
        },
        get cinematicDrifting() {
          return cameraDirector.cinematicDrifting;
        },
        get directFocusEnabled() {
          return cameraDirector.directFocusEnabled;
        },
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
  Object.defineProperty(canvas, 'solarVoyagerCamera', { value: diagnostics });
  return diagnostics;
}

export function createPhotoRuntimeDiagnostics(
  canvas: HTMLCanvasElement,
  photoCapture: PhotoCaptureController,
  sink: { readonly lastFilename: string | null },
): PhotoRuntimeDiagnostics {
  const diagnostics = Object.freeze(
    Object.setPrototypeOf(
      {
        get status() {
          return photoCapture.status;
        },
        get captureCount() {
          return photoCapture.captureCount;
        },
        get dropCount() {
          return photoCapture.dropCount;
        },
        get lastError() {
          return photoCapture.lastError;
        },
        get lastFilename() {
          return sink.lastFilename;
        },
        get lastSimTimeSec() {
          return photoCapture.lastMeta?.simTimeSec ?? Number.NaN;
        },
        get lastTauSec() {
          return photoCapture.lastMeta?.tauSec ?? Number.NaN;
        },
        get lastDominantBodyId() {
          return photoCapture.lastMeta?.dominantBodyId ?? null;
        },
        get lastGammaMax() {
          return photoCapture.lastMeta?.gammaMax ?? Number.NaN;
        },
        get lastPositionXKm() {
          return photoCapture.lastMeta?.positionKm.x ?? Number.NaN;
        },
        get lastPositionYKm() {
          return photoCapture.lastMeta?.positionKm.y ?? Number.NaN;
        },
        get lastPositionZKm() {
          return photoCapture.lastMeta?.positionKm.z ?? Number.NaN;
        },
      },
      null,
    ),
  ) as PhotoRuntimeDiagnostics;
  Object.defineProperty(canvas, 'solarVoyagerPhoto', { value: diagnostics });
  return diagnostics;
}

export function createExposureRuntimeDiagnostics(
  canvas: HTMLCanvasElement,
  exposureController: ExposureController,
): ExposureRuntimeDiagnostics {
  const diagnostics = Object.freeze(
    Object.setPrototypeOf(
      {
        get mode() {
          return exposureController.mode;
        },
        get userMode() {
          return exposureController.playerMode;
        },
        get governorMode() {
          return exposureController.qualityMode;
        },
        get exposure() {
          return exposureController.exposure;
        },
        get targetExposure() {
          return exposureController.targetExposure;
        },
        get sceneLuminance() {
          return exposureController.sceneLuminance;
        },
      },
      null,
    ),
  ) as ExposureRuntimeDiagnostics;
  Object.defineProperty(canvas, 'solarVoyagerExposure', { value: diagnostics });
  return diagnostics;
}

export function createSystemMapRuntimeDiagnostics(
  canvas: HTMLCanvasElement,
  seed: SystemMapDiagnosticSeed,
): SystemMapRuntimeDiagnostics {
  const diagnostics: SystemMapRuntimeDiagnostics = {
    scene: seed.scene,
    mapSceneCreations: 1,
    mode: seed.mode,
    focusBodyId: seed.focusBodyId,
    targetBodyId: null,
    simulationTimeSec: seed.simulationTimeSec,
    spaceRenderCount: 0,
    spaceRenderCountAtModeChange: 0,
    mapRenderCount: 0,
    trajectoryLineVisible: false,
    trajectoryMarkersVisible: false,
  };
  Object.defineProperty(canvas, 'solarVoyagerSystemMap', { value: diagnostics });
  return diagnostics;
}

/**
 * T0144 (ADR-041) — the audio subsystem, observable from a browser gate.
 *
 * `contextState` is `'none'` until a user gesture arrives, which is the whole
 * autoplay contract made testable: a harness that never clicks must see
 * `'none'`, `unlocked === false` and `contextCreationCount === 0` for the life
 * of the page.
 *
 * `RuntimeResourceCounts` deliberately does not carry `audioContextCreations`
 * instead: two `deepEqual` whole-shape pins in `tools/tests/mainMenuRegression.mjs`
 * compare that object in full, and the count is gesture-dependent — it would make
 * an unrelated gate's fixture depend on how the harness happens to reach the
 * space phase.
 */
export interface AudioRuntimeDiagnostics {
  readonly identity: 'solarVoyagerAudio.v1';
  readonly unlocked: boolean;
  readonly contextState: string;
  readonly contextCreationCount: number;
  readonly unlockAttemptCount: number;
  readonly paramWriteCount: number;
  readonly suspendedByVisibility: boolean;
  readonly musicContext: string;
  /**
   * Live equal-power crossfade weights, in `MUSIC_CONTEXTS` order.
   *
   * Exposed because a browser gate cannot otherwise tell "the mix is settled"
   * from "the 4 s opening crossfade is still running": the bus gains go quiet
   * long before the layer weights do, and the weights are what keep writing.
   * T0145 reads the same array to prove its stems crossfade.
   */
  readonly musicLayerGains: Float64Array;
  readonly perspective: string;
  readonly warningActive: boolean;
  readonly masterGain: number;
  readonly musicBusGain: number;
  readonly sfxBusGain: number;
  readonly uiBusGain: number;
  readonly engineGain: number;
  readonly engineCutoffHz: number;
  readonly engineDetuneCents: number;
  readonly warpMuffle: number;
  readonly gammaStress: number;
}

export function createAudioRuntimeDiagnostics(
  canvas: HTMLCanvasElement,
  audio: AudioSystem,
): AudioRuntimeDiagnostics {
  const diagnostics = Object.freeze(
    Object.setPrototypeOf(
      {
        identity: 'solarVoyagerAudio.v1',
        get unlocked() {
          return audio.engine.unlocked;
        },
        get contextState() {
          return audio.engine.contextState;
        },
        get contextCreationCount() {
          return audio.engine.contextCreationCount;
        },
        get unlockAttemptCount() {
          return audio.engine.unlockAttemptCount;
        },
        get paramWriteCount() {
          return audio.engine.paramWriteCount;
        },
        get suspendedByVisibility() {
          return audio.engine.suspendedByVisibility;
        },
        get musicContext() {
          return audio.mix.musicContext;
        },
        get musicLayerGains() {
          return audio.mix.musicLayerGains;
        },
        get perspective() {
          return audio.mix.perspective;
        },
        get warningActive() {
          return audio.mix.warningActive;
        },
        get masterGain() {
          return audio.mix.masterGain;
        },
        get musicBusGain() {
          return audio.mix.musicBusGain;
        },
        get sfxBusGain() {
          return audio.mix.sfxBusGain;
        },
        get uiBusGain() {
          return audio.mix.uiBusGain;
        },
        get engineGain() {
          return audio.mix.engineGain;
        },
        get engineCutoffHz() {
          return audio.mix.engineCutoffHz;
        },
        get engineDetuneCents() {
          return audio.mix.engineDetuneCents;
        },
        get warpMuffle() {
          return audio.mix.warpMuffle;
        },
        get gammaStress() {
          return audio.mix.gammaStress;
        },
      },
      null,
    ),
  ) as AudioRuntimeDiagnostics;
  Object.defineProperty(canvas, 'solarVoyagerAudio', { value: diagnostics });
  return diagnostics;
}
