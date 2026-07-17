import type { WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { RendererContextReport } from './createRenderer.js';
import { RENDER_TELEMETRY_PROPERTY, RenderTelemetry, exposeRenderTelemetry } from './telemetry.js';

interface FakeQuery {
  available: boolean;
  resultNs: number;
}

function contextReport(): RendererContextReport {
  return {
    contextFlavor: 'webgl2',
    depthStrategy: 'reversed',
    effectiveContextAttributes: null,
    gpuTimerQueryAvailable: false,
    rendererName: 'ANGLE (Intel Iris Xe Graphics)',
    softwareRasterizer: false,
    usedPerformanceCaveatFallback: false,
    warningRequired: false,
  };
}

function fakeRenderer(context: WebGL2RenderingContext) {
  const info = {
    autoReset: true,
    memory: { geometries: 2, textures: 3 },
    programs: [{}, {}, {}],
    render: { calls: 4, frame: 5, lines: 6, points: 7, triangles: 8 },
    reset: vi.fn(),
    update: vi.fn(),
  };
  return {
    renderer: {
      getContext: () => context,
      info,
    } as unknown as WebGLRenderer,
    info,
  };
}

function contextWithoutTimer(): WebGL2RenderingContext {
  return {
    getExtension: () => null,
  } as unknown as WebGL2RenderingContext;
}

function timerContext() {
  const extension = {
    GPU_DISJOINT_EXT: 0x8fbb,
    TIME_ELAPSED_EXT: 0x88bf,
  };
  const queries: FakeQuery[] = [];
  let disjoint = false;
  let disjointReads = 0;
  let resetDisjointOnRead = false;
  const beginQuery = vi.fn();
  const endQuery = vi.fn();
  const deleteQuery = vi.fn();
  const context = {
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
    beginQuery,
    createQuery() {
      const query = { available: false, resultNs: 0 };
      queries.push(query);
      return query;
    },
    deleteQuery,
    endQuery,
    getExtension(name: string) {
      return name === 'EXT_disjoint_timer_query_webgl2' ? extension : null;
    },
    getParameter(parameter: number) {
      if (parameter !== extension.GPU_DISJOINT_EXT) return null;
      disjointReads += 1;
      const currentValue = disjoint;
      if (resetDisjointOnRead) disjoint = false;
      return currentValue;
    },
    getQueryParameter(query: FakeQuery, parameter: number) {
      return parameter === 0x8867 ? query.available : query.resultNs;
    },
  } as unknown as WebGL2RenderingContext;
  return {
    beginQuery,
    context,
    deleteQuery,
    endQuery,
    getDisjointReads() {
      return disjointReads;
    },
    queries,
    setDisjoint(value: boolean, resetOnRead = false) {
      disjoint = value;
      resetDisjointOnRead = resetOnRead;
    },
  };
}

describe('RenderTelemetry', () => {
  it('exposes one immutable telemetry instance to external read-only consumers', () => {
    const { renderer } = fakeRenderer(contextWithoutTimer());
    const telemetry = new RenderTelemetry(renderer, contextReport());
    const host = {} as HTMLCanvasElement;

    exposeRenderTelemetry(host, telemetry);

    expect(
      (host as HTMLCanvasElement & { readonly solarVoyagerTelemetry?: RenderTelemetry })[
        RENDER_TELEMETRY_PROPERTY
      ],
    ).toBe(telemetry);
    expect(Object.getOwnPropertyDescriptor(host, RENDER_TELEMETRY_PROPERTY)).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    });
    expect(() => exposeRenderTelemetry(host, telemetry)).toThrowError(/already exposed/u);
  });

  it('keeps stable storage and wraps the 120-frame ring without allocating snapshots', () => {
    const { renderer } = fakeRenderer(contextWithoutTimer());
    const telemetry = new RenderTelemetry(renderer, contextReport());
    const snapshot = telemetry.snapshot;
    const frameTimes = telemetry.frameTimesMs;
    let timestampMs = 0;

    expect(telemetry.beginFrame(timestampMs)).toBe(0);
    telemetry.endFrame(0, 0, 0, timestampMs);
    for (let frame = 0; frame < 130; frame += 1) {
      timestampMs += 16;
      expect(telemetry.beginFrame(timestampMs)).toBeCloseTo(0.016, 12);
      telemetry.endFrame(0.5, 4, 0.2, timestampMs);
    }

    expect(telemetry.snapshot).toBe(snapshot);
    expect(telemetry.frameTimesMs).toBe(frameTimes);
    expect(telemetry.frameSampleCount).toBe(120);
    expect(telemetry.getFrameTimeByAge(0)).toBe(16);
    expect(telemetry.getFrameTimeByAge(119)).toBe(16);
    expect(telemetry.getFrameTimeByAge(120)).toBe(Number.NaN);
    expect(snapshot.frameSampleCount).toBe(120);
    expect(snapshot.averageFps).toBeCloseTo(62.5, 12);
    expect(snapshot.p75FrameMs).toBe(16);
    expect(snapshot.p99FrameMs).toBe(16);
  });

  it('refreshes split and renderer.info counters at four hertz', () => {
    const { info, renderer } = fakeRenderer(contextWithoutTimer());
    const telemetry = new RenderTelemetry(renderer, contextReport());
    expect(info.autoReset).toBe(false);
    telemetry.beginFrame(0);
    expect(info.reset).toHaveBeenCalledOnce();
    telemetry.endFrame(0, 0, 0, 0);

    telemetry.beginFrame(250);
    info.render.calls = 14;
    info.render.triangles = 18;
    info.render.points = 17;
    info.render.lines = 16;
    info.memory.geometries = 12;
    info.memory.textures = 13;
    info.programs = [{}, {}, {}, {}];
    telemetry.endFrame(1, 2, 0.5, 250);
    expect(info.reset).toHaveBeenCalledTimes(2);

    expect(telemetry.snapshot).toMatchObject({
      context: contextReport(),
      drawCalls: 14,
      frameCount: 2,
      frameMs: 250,
      geometries: 12,
      lines: 16,
      points: 17,
      programs: 4,
      renderMs: 2,
      simMs: 1,
      textures: 13,
      triangles: 18,
      uiMs: 0.5,
    });
  });

  it('collects GPU time only after an asynchronous non-disjoint result', () => {
    const timer = timerContext();
    const report = { ...contextReport(), gpuTimerQueryAvailable: true };
    const { renderer } = fakeRenderer(timer.context);
    const telemetry = new RenderTelemetry(renderer, report);
    const gpuTimes = telemetry.gpuTimesMs;

    telemetry.beginFrame(0);
    telemetry.beginGpuTimer();
    telemetry.endGpuTimer();
    expect(timer.beginQuery).toHaveBeenCalledOnce();
    expect(timer.endQuery).toHaveBeenCalledOnce();
    expect(telemetry.snapshot.gpuMs).toBe(-1);

    const firstQuery = timer.queries[0];
    if (firstQuery === undefined) throw new Error('First fake query is missing.');
    firstQuery.available = true;
    firstQuery.resultNs = 5_250_000;
    telemetry.beginFrame(16);
    expect(telemetry.snapshot.gpuMs).toBeCloseTo(5.25, 12);
    expect(telemetry.gpuTimesMs).toBe(gpuTimes);
    expect(telemetry.gpuTimeSampleCount).toBe(1);
    expect(telemetry.getGpuTimeByAge(0)).toBeCloseTo(5.25, 12);
    expect(telemetry.getGpuTimeByAge(1)).toBe(Number.NaN);

    telemetry.beginGpuTimer();
    telemetry.endGpuTimer();
    const secondQuery = timer.queries[1];
    if (secondQuery === undefined) throw new Error('Second fake query is missing.');
    secondQuery.available = true;
    secondQuery.resultNs = 9_000_000;
    timer.setDisjoint(true);
    telemetry.beginFrame(32);
    expect(telemetry.snapshot.gpuMs).toBeCloseTo(5.25, 12);
    expect(telemetry.gpuTimeSampleCount).toBe(1);

    telemetry.dispose();
    expect(timer.deleteQuery).toHaveBeenCalledTimes(4);
  });

  it('invalidates every pending query from one consumed disjoint latch', () => {
    const timer = timerContext();
    const report = { ...contextReport(), gpuTimerQueryAvailable: true };
    const { renderer } = fakeRenderer(timer.context);
    const telemetry = new RenderTelemetry(renderer, report);

    telemetry.beginFrame(0);
    telemetry.beginGpuTimer();
    telemetry.endGpuTimer();
    telemetry.beginGpuTimer();
    telemetry.endGpuTimer();
    for (let index = 0; index < 2; index += 1) {
      const query = timer.queries[index];
      if (query === undefined) throw new Error(`Fake query ${String(index)} is missing.`);
      query.available = true;
      query.resultNs = (index + 1) * 4_500_000;
    }
    timer.setDisjoint(true, true);

    telemetry.beginFrame(16);

    expect(timer.getDisjointReads()).toBe(1);
    expect(telemetry.snapshot.gpuMs).toBe(-1);
  });

  it('makes unavailable GPU timing a no-op', () => {
    const context = contextWithoutTimer();
    const { renderer } = fakeRenderer(context);
    const telemetry = new RenderTelemetry(renderer, contextReport());

    expect(telemetry.gpuTimerAvailable).toBe(false);
    telemetry.beginGpuTimer();
    telemetry.endGpuTimer();
    telemetry.dispose();
    expect(telemetry.snapshot.gpuMs).toBe(-1);
  });

  it('does not create GPU queries when the context report disables software timing', () => {
    const timer = timerContext();
    const report = {
      ...contextReport(),
      gpuTimerQueryAvailable: false,
      softwareRasterizer: true,
      warningRequired: true,
    };
    const { renderer } = fakeRenderer(timer.context);
    const telemetry = new RenderTelemetry(renderer, report);

    expect(telemetry.gpuTimerAvailable).toBe(false);
    expect(timer.queries).toHaveLength(0);
  });
});
