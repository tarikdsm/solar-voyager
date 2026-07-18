import { describe, expect, it, vi } from 'vitest';

import type { RendererContextReport } from '../../render/createRenderer.js';
import type { RenderTelemetrySnapshot } from '../../render/telemetry.js';
import {
  PERF_SPARKLINE_BUDGET_Y,
  createPerfPanelStore,
  type PerfPanelTelemetrySource,
} from './perfPanelStore.js';

const CONTEXT: RendererContextReport = {
  contextFlavor: 'webgl2',
  depthStrategy: 'reversed',
  effectiveContextAttributes: null,
  gpuTimerQueryAvailable: true,
  rendererName: 'ANGLE (NVIDIA RTX 5070)',
  softwareRasterizer: false,
  usedPerformanceCaveatFallback: false,
  warningRequired: false,
};

function createTelemetry(frameTimesChronological: readonly number[]): PerfPanelTelemetrySource & {
  snapshot: RenderTelemetrySnapshot;
} {
  const validFrameTimes = frameTimesChronological.filter((frameMs) => frameMs > 0);
  const elapsedMs = validFrameTimes.reduce((total, frameMs) => total + frameMs, 0);
  return {
    frameSampleCount: frameTimesChronological.length,
    getFrameTimeByAge(age: number) {
      return frameTimesChronological[frameTimesChronological.length - 1 - age] ?? Number.NaN;
    },
    snapshot: {
      averageFps: 0,
      context: CONTEXT,
      drawCalls: 12,
      frameCount: frameTimesChronological.length,
      frameMs: frameTimesChronological.at(-1) ?? 0,
      frameSampleCount: frameTimesChronological.length,
      geometries: 3,
      gpuMs: 4.25,
      lines: 0,
      oneSecondAverageFps: elapsedMs > 0 ? (validFrameTimes.length * 1_000) / elapsedMs : 0,
      p75FrameMs: 16,
      p99FrameMs: 20,
      points: 8_000,
      programs: 5,
      qualityActionCount: 0,
      renderMs: 6.5,
      simMs: 1.25,
      stateVectorWidgetMs: 0.35,
      textures: 4,
      triangles: 34_567,
      uiMs: 0.15,
    },
  };
}

function createFixture(
  frameTimes: readonly number[],
  clock: () => number = () => 0,
  readHeapBytes: () => number | null = () => 129_499_136,
) {
  const telemetry = createTelemetry(frameTimes);
  const resolution = { height: 1_080, width: 1_920 };
  const quality = {
    governorState: 'Awaiting adaptive governor',
    lastAction: 'None',
    renderScale: 1,
    tier: 6,
    tierCount: 6,
  };
  const store = createPerfPanelStore({ clock, quality, readHeapBytes, resolution, telemetry });
  return { quality, resolution, store, telemetry };
}

describe('PerfPanelStore', () => {
  it('formats the compact row and expanded renderer telemetry from one sampled snapshot', () => {
    const { store } = createFixture(Array.from({ length: 60 }, () => 1_000 / 60));

    expect(store.publish(0)).toBe(true);
    expect(store.display.fps.value).toBe('60.0 FPS');
    expect(store.display.onePercentLow.value).toBe('50.0 FPS');
    expect(store.display.resolution.value).toBe('1920×1080 @1.00');
    expect(store.display.qualityTier.value).toBe('Q6/6');
    expect(store.display.simMs.value).toBe('1.25 ms');
    expect(store.display.renderMs.value).toBe('6.50 ms');
    expect(store.display.uiMs.value).toBe('0.15 ms');
    expect(store.display.gpuMs.value).toBe('4.25 ms');
    expect(store.display.drawStats.value).toBe('12 calls · 34,567 triangles');
    expect(store.display.resourceStats.value).toBe('3 geo · 4 tex · 5 prog');
    expect(store.display.jsHeap.value).toBe('123.5 MiB');
    expect(store.display.gpuName.value).toBe('ANGLE (NVIDIA RTX 5070)');
    expect(store.display.context.value).toBe('WebGL2 · reversed depth');
    expect(store.display.governorState.value).toBe('Awaiting adaptive governor');
    expect(store.display.lastAction.value).toBe('None');
    expect(store.display.sampleCount.value).toBe(60);
  });

  it('publishes the preallocated telemetry ring to a sparkline sink at four hertz', () => {
    const { store, telemetry } = createFixture([0, 16.6, 50, 100]);
    const sink = { draw: vi.fn() };
    store.setSparklineSink(sink);

    store.publish(0);

    expect(PERF_SPARKLINE_BUDGET_Y).toBeCloseTo(21.376, 3);
    expect(sink.draw).toHaveBeenCalledTimes(2);
    expect(sink.draw).toHaveBeenLastCalledWith(telemetry);
  });

  it('keeps the per-frame fast path stable between four-hertz sampled commits', () => {
    const clock = vi.fn(() => 0);
    const { store, telemetry } = createFixture([16, 16, 16], clock);
    store.setSparklineSink({
      draw(source) {
        for (let age = 0; age < source.frameSampleCount; age += 1) {
          source.getFrameTimeByAge(age);
        }
      },
    });
    store.publish(0);
    const sampleCountSignal = store.display.sampleCount;
    const previousSampleCount = sampleCountSignal.value;
    const previousFps = store.display.fps.value;
    telemetry.snapshot.p99FrameMs = 50;
    const frameRead = vi.spyOn(telemetry, 'getFrameTimeByAge');

    expect(store.publish(249.999)).toBe(false);
    expect(store.display.sampleCount).toBe(sampleCountSignal);
    expect(store.display.sampleCount.value).toBe(previousSampleCount);
    expect(store.display.fps.value).toBe(previousFps);
    expect(clock).toHaveBeenCalledTimes(4);
    expect(frameRead).not.toHaveBeenCalled();

    expect(store.publish(250)).toBe(true);
    expect(store.display.onePercentLow.value).toBe('20.0 FPS');
    expect(clock).toHaveBeenCalledTimes(6);
    expect(frameRead).toHaveBeenCalled();
  });

  it('reports total panel cost across sampled and fast-path calls', () => {
    const clockValues = [0, 0.1, 1, 1.12, 2, 2.18];
    const { store, telemetry } = createFixture([16, 16, 16, 16], () => clockValues.shift() ?? 2.18);
    telemetry.snapshot.frameCount = 10_000;

    store.publish(0);
    store.publish(100);
    store.publish(250);

    expect(store.measuredCostMsPerFrame).toBeCloseTo(0.15, 10);
    expect(store.measuredCostMsPerFrame).toBeLessThan(0.2);
  });

  it('updates mutable renderer and future-governor scalars without replacing signals', () => {
    const { quality, resolution, store } = createFixture([20, 20]);
    store.publish(0);
    const resolutionSignal = store.display.resolution;
    resolution.width = 1_344;
    resolution.height = 756;
    quality.renderScale = 0.7;
    quality.tier = 4;
    quality.governorState = 'Auto · cooldown';
    quality.lastAction = 'Reduced bloom';

    store.publish(250);

    expect(store.display.resolution).toBe(resolutionSignal);
    expect(store.display.resolution.value).toBe('941×529 @0.70');
    expect(store.display.qualityTier.value).toBe('Q4/6');
    expect(store.display.governorState.value).toBe('Auto · cooldown');
    expect(store.display.lastAction.value).toBe('Reduced bloom');
  });
});
