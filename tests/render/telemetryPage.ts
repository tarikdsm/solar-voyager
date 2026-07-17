import type { WebGLRenderer } from 'three';

import type { RendererContextReport } from '../../src/render/createRenderer.js';
import { RenderTelemetry } from '../../src/render/telemetry.js';

const ITERATIONS = 100_000;
const FRAME_DELTA_MS = 1_000 / 60;

interface TelemetryBenchmarkResult {
  readonly baselineMs: number;
  readonly frameSampleCount: number;
  readonly iterations: number;
  readonly overheadMsPerFrame: number;
  readonly snapshotStable: boolean;
  readonly telemetryMs: number;
}

declare global {
  var __telemetryBenchmark: TelemetryBenchmarkResult | undefined;
}

const context = {
  getExtension: () => null,
} as unknown as WebGL2RenderingContext;
const renderer = {
  getContext: () => context,
  info: {
    autoReset: true,
    memory: { geometries: 2, textures: 3 },
    programs: [{}, {}],
    render: { calls: 4, frame: 0, lines: 0, points: 10, triangles: 20 },
    reset() {},
  },
} as unknown as WebGLRenderer;
const contextReport: RendererContextReport = {
  contextFlavor: 'webgl2',
  depthStrategy: 'reversed',
  effectiveContextAttributes: null,
  gpuTimerQueryAvailable: false,
  rendererName: 'benchmark',
  softwareRasterizer: false,
  usedPerformanceCaveatFallback: false,
  warningRequired: false,
};
const telemetry = new RenderTelemetry(renderer, contextReport);
const snapshot = telemetry.snapshot;

let accumulator = 0;
let timestampMs = 0;
const baselineStartMs = performance.now();
for (let index = 0; index < ITERATIONS; index += 1) {
  timestampMs += FRAME_DELTA_MS;
  accumulator += timestampMs > 0 ? 1 : 0;
}
const baselineMs = performance.now() - baselineStartMs;

timestampMs = 0;
const telemetryStartMs = performance.now();
for (let index = 0; index < ITERATIONS; index += 1) {
  timestampMs += FRAME_DELTA_MS;
  accumulator += telemetry.beginFrame(timestampMs);
  telemetry.endFrame(0.25, 3.5, 0.1, timestampMs);
}
const telemetryMs = performance.now() - telemetryStartMs;

if (accumulator <= 0) throw new Error('Telemetry benchmark loop was optimized away.');
globalThis.__telemetryBenchmark = {
  baselineMs,
  frameSampleCount: telemetry.frameSampleCount,
  iterations: ITERATIONS,
  overheadMsPerFrame: Math.max(0, telemetryMs - baselineMs) / ITERATIONS,
  snapshotStable: telemetry.snapshot === snapshot,
  telemetryMs,
};
