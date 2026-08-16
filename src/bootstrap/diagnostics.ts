import type { CameraDirector, CameraMode } from '../game/cameraDirector.js';
import type { StartupDiagnostic } from '../game/startupTracker.js';
import type { SystemMapMode } from '../game/systemMapController.js';
import type { TutorialController } from '../game/tutorialController.js';
import type { BodyModelLoadState } from '../render/bodyVisualSystem.js';
import type { EpochWorld } from '../render/createEpochWorld.js';
import { SHIP_ASSET_ID, type ShipVisual } from '../render/shipVisual.js';
import type { BurnLogEntry } from '../sim/ship/ledger.js';

/**
 * The frozen browser-diagnostic contract: seven `canvas.solarVoyager*` objects
 * that roughly 25 Playwright gates read by property name.
 *
 * Every definition site is a literal
 * `Object.defineProperty(canvas, 'solarVoyager…', { value })` — non-writable,
 * non-configurable, non-enumerable — and `tests/architecture/diagnosticsContract.test.ts`
 * asserts that both the member lists and the definition sites are exactly these.
 * Extend them; never drop a field (`AGENTS.md` Global Constraints).
 *
 * `solarVoyagerTelemetry` is the eighth canvas property and is not here:
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
