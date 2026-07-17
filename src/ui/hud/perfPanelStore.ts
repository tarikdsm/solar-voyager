import { batch, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import type { RenderTelemetrySnapshot } from '../../render/telemetry.js';

const UPDATE_INTERVAL_MS = 250;
const SPARKLINE_SLOT_COUNT = 120;
export const PERF_SPARKLINE_HEIGHT = 32;
export const PERF_SPARKLINE_MAX_FRAME_MS = 50;
const FRAME_BUDGET_MS = 16.6;
const MEBIBYTE_BYTES = 1_048_576;
const INTEGER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const PERF_SPARKLINE_BUDGET_Y =
  PERF_SPARKLINE_HEIGHT - (FRAME_BUDGET_MS / PERF_SPARKLINE_MAX_FRAME_MS) * PERF_SPARKLINE_HEIGHT;

export interface PerfPanelTelemetrySource {
  readonly frameSampleCount: number;
  readonly snapshot: RenderTelemetrySnapshot;
  getFrameTimeByAge(age: number): number;
}

export interface PerfPanelResolutionSource {
  height: number;
  width: number;
}

export interface PerfPanelQualitySource {
  governorState: string;
  lastAction: string;
  renderScale: number;
  tier: number;
  tierCount: number;
}

export interface PerfPanelDisplaySignals {
  readonly context: ReadonlySignal<string>;
  readonly drawStats: ReadonlySignal<string>;
  readonly fps: ReadonlySignal<string>;
  readonly governorState: ReadonlySignal<string>;
  readonly gpuMs: ReadonlySignal<string>;
  readonly gpuName: ReadonlySignal<string>;
  readonly jsHeap: ReadonlySignal<string>;
  readonly lastAction: ReadonlySignal<string>;
  readonly onePercentLow: ReadonlySignal<string>;
  readonly panelCost: ReadonlySignal<string>;
  readonly qualityTier: ReadonlySignal<string>;
  readonly renderMs: ReadonlySignal<string>;
  readonly resolution: ReadonlySignal<string>;
  readonly resourceStats: ReadonlySignal<string>;
  readonly sampleCount: ReadonlySignal<number>;
  readonly simMs: ReadonlySignal<string>;
  readonly uiMs: ReadonlySignal<string>;
}

interface WritablePerfPanelDisplaySignals {
  readonly context: Signal<string>;
  readonly drawStats: Signal<string>;
  readonly fps: Signal<string>;
  readonly governorState: Signal<string>;
  readonly gpuMs: Signal<string>;
  readonly gpuName: Signal<string>;
  readonly jsHeap: Signal<string>;
  readonly lastAction: Signal<string>;
  readonly onePercentLow: Signal<string>;
  readonly panelCost: Signal<string>;
  readonly qualityTier: Signal<string>;
  readonly renderMs: Signal<string>;
  readonly resolution: Signal<string>;
  readonly resourceStats: Signal<string>;
  readonly sampleCount: Signal<number>;
  readonly simMs: Signal<string>;
  readonly uiMs: Signal<string>;
}

export interface PerfPanelStoreOptions {
  readonly clock?: () => number;
  readonly quality: PerfPanelQualitySource;
  readonly readHeapBytes?: () => number | null;
  readonly resolution: PerfPanelResolutionSource;
  readonly telemetry: PerfPanelTelemetrySource;
}

export interface PerfPanelStore {
  readonly display: PerfPanelDisplaySignals;
  readonly measuredCostMsPerFrame: number;
  publish(nowMs: number): boolean;
  setSparklineSink(sink: PerfPanelSparklineSink | null): void;
}

export interface PerfPanelSparklineSink {
  draw(telemetry: PerfPanelTelemetrySource): void;
}

interface PerformanceMemorySnapshot {
  readonly usedJSHeapSize: number;
}

interface PerformanceWithMemory extends Performance {
  readonly memory?: PerformanceMemorySnapshot;
}

function defaultClock(): number {
  return performance.now();
}

function readBrowserHeapBytes(): number | null {
  const usedBytes = (performance as PerformanceWithMemory).memory?.usedJSHeapSize;
  return usedBytes === undefined || !Number.isFinite(usedBytes) ? null : usedBytes;
}

function createDisplaySignals(): WritablePerfPanelDisplaySignals {
  return {
    context: signal('WebGL2'),
    drawStats: signal('—'),
    fps: signal('— FPS'),
    governorState: signal('—'),
    gpuMs: signal('—'),
    gpuName: signal('Unavailable'),
    jsHeap: signal('Unavailable'),
    lastAction: signal('None'),
    onePercentLow: signal('— FPS'),
    panelCost: signal('Sampling…'),
    qualityTier: signal('Q—/—'),
    renderMs: signal('—'),
    resolution: signal('—×— @—'),
    resourceStats: signal('—'),
    sampleCount: signal(0),
    simMs: signal('—'),
    uiMs: signal('—'),
  };
}

function formatFps(value: number): string {
  return Number.isFinite(value) && value > 0 ? `${value.toFixed(1)} FPS` : '— FPS';
}

function formatMilliseconds(value: number): string {
  return Number.isFinite(value) && value >= 0 ? `${value.toFixed(2)} ms` : '—';
}

function formatHeapBytes(value: number | null): string {
  return value !== null && Number.isFinite(value) && value >= 0
    ? `${(value / MEBIBYTE_BYTES).toFixed(1)} MiB`
    : 'Unavailable';
}

class SampledPerfPanelStore implements PerfPanelStore {
  readonly display: PerfPanelDisplaySignals;

  private readonly writableDisplay: WritablePerfPanelDisplaySignals;
  private readonly clock: () => number;
  private readonly quality: PerfPanelQualitySource;
  private readonly readHeapBytes: () => number | null;
  private readonly resolution: PerfPanelResolutionSource;
  private readonly telemetry: PerfPanelTelemetrySource;
  private accumulatedCostMs = 0;
  private accumulatedCostFrames = 0;
  private nextPublishMs = Number.NEGATIVE_INFINITY;
  private latestMeasuredCostMsPerFrame = 0;
  private sparklineSink: PerfPanelSparklineSink | null = null;

  constructor(options: PerfPanelStoreOptions) {
    this.clock = options.clock ?? defaultClock;
    this.quality = options.quality;
    this.readHeapBytes = options.readHeapBytes ?? readBrowserHeapBytes;
    this.resolution = options.resolution;
    this.telemetry = options.telemetry;
    this.writableDisplay = createDisplaySignals();
    this.display = this.writableDisplay;
  }

  get measuredCostMsPerFrame(): number {
    return this.latestMeasuredCostMsPerFrame;
  }

  setSparklineSink(sink: PerfPanelSparklineSink | null): void {
    this.sparklineSink = sink;
    sink?.draw(this.telemetry);
  }

  publish(nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) throw new RangeError('Perf panel sample time must be finite');
    const startMs = this.clock();
    if (nowMs < this.nextPublishMs) {
      this.accumulateCost(startMs);
      return false;
    }
    this.nextPublishMs = nowMs + UPDATE_INTERVAL_MS;

    const snapshot = this.telemetry.snapshot;
    const onePercentLowFps = snapshot.p99FrameMs > 0 ? 1_000 / snapshot.p99FrameMs : 0;
    const heapBytes = this.readHeapBytes();
    this.sparklineSink?.draw(this.telemetry);
    batch(() => {
      this.writableDisplay.fps.value = formatFps(snapshot.oneSecondAverageFps);
      this.writableDisplay.onePercentLow.value = formatFps(onePercentLowFps);
      this.writableDisplay.sampleCount.value = Math.min(
        SPARKLINE_SLOT_COUNT,
        this.telemetry.frameSampleCount,
      );
      this.writableDisplay.resolution.value = `${String(Math.round(this.resolution.width))}×${String(
        Math.round(this.resolution.height),
      )} @${this.quality.renderScale.toFixed(2)}`;
      this.writableDisplay.qualityTier.value = `Q${String(this.quality.tier)}/${String(
        this.quality.tierCount,
      )}`;
      this.writableDisplay.simMs.value = formatMilliseconds(snapshot.simMs);
      this.writableDisplay.renderMs.value = formatMilliseconds(snapshot.renderMs);
      this.writableDisplay.uiMs.value = formatMilliseconds(snapshot.uiMs);
      this.writableDisplay.gpuMs.value = formatMilliseconds(snapshot.gpuMs);
      this.writableDisplay.drawStats.value = `${INTEGER_FORMAT.format(
        snapshot.drawCalls,
      )} calls · ${INTEGER_FORMAT.format(snapshot.triangles)} triangles`;
      this.writableDisplay.resourceStats.value = `${INTEGER_FORMAT.format(
        snapshot.geometries,
      )} geo · ${INTEGER_FORMAT.format(snapshot.textures)} tex · ${INTEGER_FORMAT.format(
        snapshot.programs,
      )} prog`;
      this.writableDisplay.jsHeap.value = formatHeapBytes(heapBytes);
      this.writableDisplay.gpuName.value = snapshot.context.rendererName;
      this.writableDisplay.context.value = `WebGL2 · ${snapshot.context.depthStrategy} depth`;
      this.writableDisplay.governorState.value = this.quality.governorState;
      this.writableDisplay.lastAction.value = this.quality.lastAction;
      this.writableDisplay.panelCost.value = `${this.latestMeasuredCostMsPerFrame.toFixed(
        3,
      )} ms/frame`;
    });
    this.accumulateCost(startMs);
    this.latestMeasuredCostMsPerFrame =
      this.accumulatedCostMs / Math.max(1, this.accumulatedCostFrames);
    this.accumulatedCostMs = 0;
    this.accumulatedCostFrames = 0;
    return true;
  }

  private accumulateCost(startMs: number): void {
    this.accumulatedCostMs += Math.max(0, this.clock() - startMs);
    this.accumulatedCostFrames += 1;
  }
}

/** Creates the sampled leaf-signal bridge from render telemetry to the HUD. */
export function createPerfPanelStore(options: PerfPanelStoreOptions): PerfPanelStore {
  return new SampledPerfPanelStore(options);
}
