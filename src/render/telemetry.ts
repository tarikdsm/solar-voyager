import type { WebGLRenderer } from 'three';

import type { RendererContextReport } from './createRenderer.js';
import { QualityActionReason } from './perfGovernor.js';

const FRAME_WINDOW_SIZE = 120;
const FPS_TIMESTAMP_WINDOW_SIZE = 256;
const GPU_TIME_WINDOW_SIZE = 600;
const SNAPSHOT_INTERVAL_MS = 250;
const GPU_QUERY_SLOT_COUNT = 4;
const GPU_QUERY_FREE = 0;
const GPU_QUERY_ACTIVE = 1;
const GPU_QUERY_PENDING = 2;
const GPU_QUERY_INVALID = 3;
const MAX_GAME_DELTA_SEC = 0.1;
const QUALITY_ACTION_CAPACITY = 32;

export const RENDER_TELEMETRY_PROPERTY = 'solarVoyagerTelemetry' as const;

interface DisjointTimerQueryExtension {
  readonly GPU_DISJOINT_EXT: number;
  readonly TIME_ELAPSED_EXT: number;
}

export interface RenderTelemetrySnapshot {
  averageFps: number;
  readonly context: RendererContextReport;
  drawCalls: number;
  frameCount: number;
  frameMs: number;
  frameSampleCount: number;
  geometries: number;
  gpuMs: number;
  lines: number;
  oneSecondAverageFps: number;
  p75FrameMs: number;
  p99FrameMs: number;
  points: number;
  programs: number;
  qualityActionCount: number;
  renderMs: number;
  simMs: number;
  stateVectorWidgetMs: number;
  textures: number;
  triangles: number;
  uiMs: number;
}

export interface QualityActionSnapshot {
  fromRung: number;
  reason: number;
  timestampMs: number;
  toRung: number;
}

/** Single allocation-free source of renderer performance truth. */
export class RenderTelemetry {
  readonly frameTimesMs = new Float64Array(FRAME_WINDOW_SIZE);
  readonly gpuTimesMs = new Float64Array(GPU_TIME_WINDOW_SIZE);
  readonly qualityActionReasons = new Uint8Array(QUALITY_ACTION_CAPACITY);
  readonly qualityActionRungs = new Uint8Array(QUALITY_ACTION_CAPACITY * 2);
  readonly qualityActionTimesMs = new Float64Array(QUALITY_ACTION_CAPACITY);
  readonly snapshot: RenderTelemetrySnapshot;

  private readonly percentileScratchMs = new Float64Array(FRAME_WINDOW_SIZE);
  private readonly fpsFrameTimestampsMs = new Float64Array(FPS_TIMESTAMP_WINDOW_SIZE);
  private readonly renderer: WebGLRenderer;
  private readonly context: WebGL2RenderingContext;
  private readonly timerExtension: DisjointTimerQueryExtension | null;
  private readonly gpuQueries: (WebGLQuery | null)[] = [];
  private readonly gpuQueryStates = new Uint8Array(GPU_QUERY_SLOT_COUNT);
  private frameWriteIndex = 0;
  private fpsTimestampCount = 0;
  private fpsTimestampWriteIndex = 0;
  private sampleCount = 0;
  private totalFrameCount = 0;
  private previousFrameTimestampMs = -1;
  private pendingFrameMs = 0;
  private latestSimMs = 0;
  private latestRenderMs = 0;
  private latestUiMs = 0;
  private latestStateVectorWidgetMs = 0;
  private nextSnapshotTimestampMs = 0;
  private activeGpuQueryIndex = -1;
  private nextGpuQueryIndex = 0;
  private gpuTimeWriteIndex = 0;
  private gpuSampleCount = 0;
  private qualityActionSampleCount = 0;
  private qualityActionWriteIndex = 0;

  constructor(renderer: WebGLRenderer, contextReport: RendererContextReport) {
    this.renderer = renderer;
    this.renderer.info.autoReset = false;
    this.context = renderer.getContext() as WebGL2RenderingContext;
    this.timerExtension = contextReport.gpuTimerQueryAvailable
      ? (this.context.getExtension(
          'EXT_disjoint_timer_query_webgl2',
        ) as DisjointTimerQueryExtension | null)
      : null;
    this.snapshot = {
      averageFps: 0,
      context: contextReport,
      drawCalls: 0,
      frameCount: 0,
      frameMs: 0,
      frameSampleCount: 0,
      geometries: 0,
      gpuMs: -1,
      lines: 0,
      oneSecondAverageFps: 0,
      p75FrameMs: 0,
      p99FrameMs: 0,
      points: 0,
      programs: 0,
      qualityActionCount: 0,
      renderMs: 0,
      simMs: 0,
      stateVectorWidgetMs: 0,
      textures: 0,
      triangles: 0,
      uiMs: 0,
    };

    if (this.timerExtension !== null) {
      for (let index = 0; index < GPU_QUERY_SLOT_COUNT; index += 1) {
        this.gpuQueries.push(this.context.createQuery());
      }
    }
  }

  get frameSampleCount(): number {
    return this.sampleCount;
  }

  get gpuTimerAvailable(): boolean {
    if (this.timerExtension === null) return false;
    for (let index = 0; index < this.gpuQueries.length; index += 1) {
      const query = this.gpuQueries[index];
      if (query !== undefined && query !== null) return true;
    }
    return false;
  }

  get gpuTimeSampleCount(): number {
    return this.gpuSampleCount;
  }

  get qualityActionCount(): number {
    return this.qualityActionSampleCount;
  }

  /** Begins a frame and returns the clamped game delta in seconds. */
  beginFrame(frameTimestampMs: number): number {
    this.renderer.info.reset();
    this.pollGpuQueries();
    this.fpsFrameTimestampsMs[this.fpsTimestampWriteIndex] = frameTimestampMs;
    this.fpsTimestampWriteIndex = (this.fpsTimestampWriteIndex + 1) % FPS_TIMESTAMP_WINDOW_SIZE;
    this.fpsTimestampCount = Math.min(FPS_TIMESTAMP_WINDOW_SIZE, this.fpsTimestampCount + 1);
    if (this.previousFrameTimestampMs < 0) {
      this.pendingFrameMs = 0;
      this.previousFrameTimestampMs = frameTimestampMs;
      return 0;
    }
    this.pendingFrameMs = Math.max(0, frameTimestampMs - this.previousFrameTimestampMs);
    this.previousFrameTimestampMs = frameTimestampMs;
    return Math.min(MAX_GAME_DELTA_SEC, this.pendingFrameMs / 1_000);
  }

  beginGpuTimer(): void {
    if (this.timerExtension === null || this.activeGpuQueryIndex >= 0) return;
    for (let attempt = 0; attempt < this.gpuQueries.length; attempt += 1) {
      const index = (this.nextGpuQueryIndex + attempt) % this.gpuQueries.length;
      const query = this.gpuQueries[index];
      if (query !== undefined && query !== null && this.gpuQueryStates[index] === GPU_QUERY_FREE) {
        this.context.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query);
        this.gpuQueryStates[index] = GPU_QUERY_ACTIVE;
        this.activeGpuQueryIndex = index;
        this.nextGpuQueryIndex = (index + 1) % this.gpuQueries.length;
        return;
      }
    }
  }

  endGpuTimer(): void {
    if (this.timerExtension === null || this.activeGpuQueryIndex < 0) return;
    this.context.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
    this.gpuQueryStates[this.activeGpuQueryIndex] = GPU_QUERY_PENDING;
    this.activeGpuQueryIndex = -1;
  }

  recordStateVectorWidgetMs(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError('State-vector widget duration must be finite and nonnegative.');
    }
    this.latestStateVectorWidgetMs = durationMs;
  }

  endFrame(simMs: number, renderMs: number, uiMs: number, frameTimestampMs: number): void {
    this.totalFrameCount += 1;
    this.latestSimMs = simMs;
    this.latestRenderMs = renderMs;
    this.latestUiMs = uiMs;
    if (this.pendingFrameMs > 0) {
      this.frameTimesMs[this.frameWriteIndex] = this.pendingFrameMs;
      this.frameWriteIndex = (this.frameWriteIndex + 1) % FRAME_WINDOW_SIZE;
      this.sampleCount = Math.min(FRAME_WINDOW_SIZE, this.sampleCount + 1);
    }
    if (frameTimestampMs >= this.nextSnapshotTimestampMs) {
      this.refreshSnapshot();
      this.nextSnapshotTimestampMs = frameTimestampMs + SNAPSHOT_INTERVAL_MS;
    }
  }

  getFrameTimeByAge(age: number): number {
    if (!Number.isInteger(age) || age < 0 || age >= this.sampleCount) return Number.NaN;
    const index = (this.frameWriteIndex - 1 - age + FRAME_WINDOW_SIZE * 2) % FRAME_WINDOW_SIZE;
    return this.frameTimesMs[index] ?? Number.NaN;
  }

  getGpuTimeByAge(age: number): number {
    if (!Number.isInteger(age) || age < 0 || age >= this.gpuSampleCount) return Number.NaN;
    const index =
      (this.gpuTimeWriteIndex - 1 - age + GPU_TIME_WINDOW_SIZE * 2) % GPU_TIME_WINDOW_SIZE;
    return this.gpuTimesMs[index] ?? Number.NaN;
  }

  recordQualityAction(
    timestampMs: number,
    fromRung: number,
    toRung: number,
    reason: QualityActionReason,
  ): void {
    if (!Number.isFinite(timestampMs)) throw new RangeError('Quality action time must be finite.');
    if (!Number.isInteger(fromRung) || fromRung < 0 || fromRung > 14) {
      throw new RangeError('Quality action source rung must be between 0 and 14.');
    }
    if (!Number.isInteger(toRung) || toRung < 0 || toRung > 14) {
      throw new RangeError('Quality action target rung must be between 0 and 14.');
    }
    if (reason < QualityActionReason.OverBudget || reason > QualityActionReason.AutoResume) {
      throw new RangeError('Quality action reason is invalid.');
    }
    const index = this.qualityActionWriteIndex;
    this.qualityActionTimesMs[index] = timestampMs;
    this.qualityActionRungs[index * 2] = fromRung;
    this.qualityActionRungs[index * 2 + 1] = toRung;
    this.qualityActionReasons[index] = reason;
    this.qualityActionWriteIndex = (index + 1) % QUALITY_ACTION_CAPACITY;
    this.qualityActionSampleCount = Math.min(
      QUALITY_ACTION_CAPACITY,
      this.qualityActionSampleCount + 1,
    );
    this.snapshot.qualityActionCount = this.qualityActionSampleCount;
  }

  readQualityActionByAge(age: number, output: QualityActionSnapshot): boolean {
    if (!Number.isInteger(age) || age < 0 || age >= this.qualityActionSampleCount) return false;
    const index =
      (this.qualityActionWriteIndex - 1 - age + QUALITY_ACTION_CAPACITY * 2) %
      QUALITY_ACTION_CAPACITY;
    output.timestampMs = this.qualityActionTimesMs[index] ?? 0;
    output.fromRung = this.qualityActionRungs[index * 2] ?? 0;
    output.toRung = this.qualityActionRungs[index * 2 + 1] ?? 0;
    output.reason = this.qualityActionReasons[index] ?? 0;
    return true;
  }

  dispose(): void {
    if (this.activeGpuQueryIndex >= 0 && this.timerExtension !== null) {
      this.context.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
      this.activeGpuQueryIndex = -1;
    }
    for (let index = 0; index < this.gpuQueries.length; index += 1) {
      const query = this.gpuQueries[index];
      if (query !== undefined && query !== null) this.context.deleteQuery(query);
      this.gpuQueryStates[index] = GPU_QUERY_FREE;
    }
  }

  private pollGpuQueries(): void {
    if (this.timerExtension === null) return;
    let hasPendingQuery = false;
    for (let index = 0; index < this.gpuQueries.length; index += 1) {
      const state = this.gpuQueryStates[index];
      if (state === GPU_QUERY_PENDING || state === GPU_QUERY_INVALID) {
        hasPendingQuery = true;
        break;
      }
    }
    if (!hasPendingQuery) return;

    const disjoint = this.context.getParameter(this.timerExtension.GPU_DISJOINT_EXT) as boolean;
    for (let index = 0; index < this.gpuQueries.length; index += 1) {
      let state = this.gpuQueryStates[index];
      if (state !== GPU_QUERY_PENDING && state !== GPU_QUERY_INVALID) continue;
      if (disjoint && state === GPU_QUERY_PENDING) {
        state = GPU_QUERY_INVALID;
        this.gpuQueryStates[index] = state;
      }
      const query = this.gpuQueries[index];
      if (query === undefined || query === null) continue;
      const available = this.context.getQueryParameter(
        query,
        this.context.QUERY_RESULT_AVAILABLE,
      ) as boolean;
      if (!available) continue;
      if (state === GPU_QUERY_PENDING) {
        const elapsedNanoseconds = this.context.getQueryParameter(
          query,
          this.context.QUERY_RESULT,
        ) as number;
        if (Number.isFinite(elapsedNanoseconds) && elapsedNanoseconds >= 0) {
          const elapsedMilliseconds = elapsedNanoseconds / 1_000_000;
          this.snapshot.gpuMs = elapsedMilliseconds;
          this.gpuTimesMs[this.gpuTimeWriteIndex] = elapsedMilliseconds;
          this.gpuTimeWriteIndex = (this.gpuTimeWriteIndex + 1) % GPU_TIME_WINDOW_SIZE;
          this.gpuSampleCount = Math.min(GPU_TIME_WINDOW_SIZE, this.gpuSampleCount + 1);
        }
      }
      this.gpuQueryStates[index] = GPU_QUERY_FREE;
    }
  }

  private refreshSnapshot(): void {
    let totalFrameMs = 0;
    for (let index = 0; index < this.sampleCount; index += 1) {
      const value = this.frameTimesMs[index] ?? 0;
      this.percentileScratchMs[index] = value;
      totalFrameMs += value;
    }
    for (let index = 1; index < this.sampleCount; index += 1) {
      const value = this.percentileScratchMs[index] ?? 0;
      let insertionIndex = index - 1;
      while (insertionIndex >= 0 && (this.percentileScratchMs[insertionIndex] ?? 0) > value) {
        this.percentileScratchMs[insertionIndex + 1] =
          this.percentileScratchMs[insertionIndex] ?? 0;
        insertionIndex -= 1;
      }
      this.percentileScratchMs[insertionIndex + 1] = value;
    }

    const averageFrameMs = this.sampleCount > 0 ? totalFrameMs / this.sampleCount : 0;
    const p75Index = Math.max(0, Math.ceil(this.sampleCount * 0.75) - 1);
    const p99Index = Math.max(0, Math.ceil(this.sampleCount * 0.99) - 1);
    const renderInfo = this.renderer.info.render;
    const memoryInfo = this.renderer.info.memory;
    this.snapshot.averageFps = averageFrameMs > 0 ? 1_000 / averageFrameMs : 0;
    this.snapshot.drawCalls = renderInfo.calls;
    this.snapshot.frameCount = this.totalFrameCount;
    this.snapshot.frameMs = this.pendingFrameMs;
    this.snapshot.frameSampleCount = this.sampleCount;
    this.snapshot.geometries = memoryInfo.geometries;
    this.snapshot.lines = renderInfo.lines;
    this.snapshot.oneSecondAverageFps = this.calculateOneSecondAverageFps();
    this.snapshot.p75FrameMs = this.percentileScratchMs[p75Index] ?? 0;
    this.snapshot.p99FrameMs = this.percentileScratchMs[p99Index] ?? 0;
    this.snapshot.points = renderInfo.points;
    this.snapshot.programs = this.renderer.info.programs?.length ?? 0;
    this.snapshot.renderMs = this.latestRenderMs;
    this.snapshot.simMs = this.latestSimMs;
    this.snapshot.stateVectorWidgetMs = this.latestStateVectorWidgetMs;
    this.snapshot.textures = memoryInfo.textures;
    this.snapshot.triangles = renderInfo.triangles;
    this.snapshot.uiMs = this.latestUiMs;
  }

  private calculateOneSecondAverageFps(): number {
    if (this.fpsTimestampCount < 2) return 0;
    const newestIndex =
      (this.fpsTimestampWriteIndex - 1 + FPS_TIMESTAMP_WINDOW_SIZE) % FPS_TIMESTAMP_WINDOW_SIZE;
    const newestMs = this.fpsFrameTimestampsMs[newestIndex] ?? 0;
    const cutoffMs = newestMs - 1_000;
    let intervalCount = 0;
    let oldestMs = newestMs;
    for (let age = 1; age < this.fpsTimestampCount; age += 1) {
      const index =
        (this.fpsTimestampWriteIndex - 1 - age + FPS_TIMESTAMP_WINDOW_SIZE) %
        FPS_TIMESTAMP_WINDOW_SIZE;
      oldestMs = this.fpsFrameTimestampsMs[index] ?? newestMs;
      intervalCount = age;
      if (oldestMs <= cutoffMs) break;
    }
    const elapsedMs = newestMs - oldestMs;
    return elapsedMs > 0 ? (intervalCount * 1_000) / elapsedMs : 0;
  }
}

/** Publishes the stable telemetry instance once for HUD, governor, and bench readers. */
export function exposeRenderTelemetry(host: HTMLCanvasElement, telemetry: RenderTelemetry): void {
  if (Object.prototype.hasOwnProperty.call(host, RENDER_TELEMETRY_PROPERTY)) {
    throw new Error('Render telemetry is already exposed on this canvas.');
  }
  Object.defineProperty(host, RENDER_TELEMETRY_PROPERTY, {
    configurable: false,
    enumerable: false,
    value: telemetry,
    writable: false,
  });
}
