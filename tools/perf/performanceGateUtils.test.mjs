import { describe, expect, it } from 'vitest';

import {
  classifyHeapConfirmation,
  createHeapSettleTracker,
  heapSettleRequiredSteps,
  heapSettleStepBudgetBytes,
  validateHeapSettling,
  compareBenchmarkRuns,
  parsePerformanceGolden,
  validateBundleSizes,
  validateConfirmedHeapGrowth,
  validateHeapGrowth,
  validateWorkload,
} from './performanceGateUtils.mjs';

const workloadGolden = Object.freeze({
  drawCalls: 26,
  toleranceFraction: 0.1,
  triangles: 65_094,
});

describe('validateWorkload', () => {
  it('accepts counts at the inclusive ten-percent bounds', () => {
    expect(validateWorkload({ drawCalls: 24, triangles: 58_585 }, workloadGolden)).toEqual([]);
    expect(validateWorkload({ drawCalls: 28, triangles: 71_603 }, workloadGolden)).toEqual([]);
  });

  it('rejects an injected extra-draw fixture', () => {
    expect(
      validateWorkload({ drawCalls: 52, triangles: 130_188 }, workloadGolden),
    ).toEqual([
      'Draw calls must stay within 10.0% of 26; measured 52.',
      'Triangles must stay within 10.0% of 65,094; measured 130,188.',
    ]);
  });
});

describe('validateHeapGrowth', () => {
  it('accepts released heap and Chromium noise within the fixed tolerance', () => {
    expect(
      validateHeapGrowth({ afterBytes: 9_000_000, beforeBytes: 10_000_000 }, 65_536),
    ).toEqual([]);
    expect(
      validateHeapGrowth({ afterBytes: 10_065_536, beforeBytes: 10_000_000 }, 65_536),
    ).toEqual([]);
  });

  it('rejects an injected retained-allocation fixture', () => {
    expect(
      validateHeapGrowth({ afterBytes: 12_000_000, beforeBytes: 10_000_000 }, 65_536),
    ).toEqual(['Retained heap growth must be <= 65,536 bytes; measured 2,000,000 bytes.']);
  });

  it('fails closed when precise heap metrics are unavailable', () => {
    expect(validateHeapGrowth({ afterBytes: null, beforeBytes: null }, 65_536)).toEqual([
      'Precise Chromium heap metrics are unavailable.',
    ]);
  });
});

describe('classifyHeapConfirmation', () => {
  const ceiling = 196_608;

  it('passes the original inclusive ceiling and confirms only the narrow band', () => {
    expect(
      classifyHeapConfirmation(
        { beforeBytes: 10_000_000, afterBytes: 10_196_608 },
        ceiling,
      ),
    ).toBe('pass');
    expect(
      classifyHeapConfirmation(
        { beforeBytes: 10_000_000, afterBytes: 10_196_609 },
        ceiling,
      ),
    ).toBe('confirm');
    expect(
      classifyHeapConfirmation(
        { beforeBytes: 10_000_000, afterBytes: 10_245_760 },
        ceiling,
      ),
    ).toBe('confirm');
    expect(
      classifyHeapConfirmation(
        { beforeBytes: 10_000_000, afterBytes: 10_245_761 },
        ceiling,
      ),
    ).toBe('fail');
  });

  it('fails closed for unavailable or malformed metrics', () => {
    expect(
      classifyHeapConfirmation({ beforeBytes: null, afterBytes: null }, ceiling),
    ).toBe('fail');
    expect(
      classifyHeapConfirmation({ beforeBytes: 1, afterBytes: Number.NaN }, ceiling),
    ).toBe('fail');
    expect(classifyHeapConfirmation({ beforeBytes: 1, afterBytes: 2 }, -1)).toBe(
      'fail',
    );
  });
});

describe('validateConfirmedHeapGrowth', () => {
  const ceiling = 196_608;
  const primary = { beforeBytes: 10_000_000, afterBytes: 10_210_000 };

  it('accepts a narrow primary outlier only after an in-budget confirmation', () => {
    expect(
      validateConfirmedHeapGrowth(
        primary,
        { beforeBytes: 10_210_000, afterBytes: 10_300_000 },
        ceiling,
      ),
    ).toEqual([]);
  });

  it('rejects a repeated narrow failure and a missing confirmation', () => {
    expect(
      validateConfirmedHeapGrowth(
        primary,
        { beforeBytes: 10_210_000, afterBytes: 10_420_000 },
        ceiling,
      ),
    ).toEqual([
      'Confirmed retained heap growth must be <= 196,608 bytes; measured 210,000 bytes.',
    ]);
    expect(validateConfirmedHeapGrowth(primary, null, ceiling)).toEqual([
      'Narrow retained heap failure requires a confirmation measurement.',
    ]);
  });

  it('does not let confirmation rescue a large primary failure', () => {
    expect(
      validateConfirmedHeapGrowth(
        { beforeBytes: 10_000_000, afterBytes: 10_300_000 },
        { beforeBytes: 10_300_000, afterBytes: 10_300_000 },
        ceiling,
      ),
    ).toEqual([
      'Retained heap growth must be <= 196,608 bytes; measured 300,000 bytes.',
    ]);
  });
});

describe('validateBundleSizes', () => {
  it('accepts entry and total gzip sizes at their ceilings', () => {
    expect(
      validateBundleSizes(
        { entryGzipBytes: 300_000, totalGzipBytes: 600_000 },
        { maxEntryGzipBytes: 300_000, maxTotalGzipBytes: 600_000 },
      ),
    ).toEqual([]);
  });

  it('reports each exceeded bundle ceiling', () => {
    expect(
      validateBundleSizes(
        { entryGzipBytes: 300_001, totalGzipBytes: 600_001 },
        { maxEntryGzipBytes: 300_000, maxTotalGzipBytes: 600_000 },
      ),
    ).toEqual([
      'Entry bundle gzip size must be <= 300,000 bytes; measured 300,001 bytes.',
      'Total JavaScript/CSS gzip size must be <= 600,000 bytes; measured 600,001 bytes.',
    ]);
  });
});

describe('compareBenchmarkRuns', () => {
  const first = Object.freeze({
    medianMs: 10,
    p75Ms: 12,
    p99Ms: 16,
    steadyHeapAfterBytes: 60_000_000,
    maxDrawCalls: 26,
    maxTriangles: 65_094,
  });

  it('accepts timing variance below five percent and exact workload counts', () => {
    expect(
      compareBenchmarkRuns(first, {
        medianMs: 10.4,
        p75Ms: 12.5,
        p99Ms: 16.7,
        steadyHeapAfterBytes: 61_000_000,
        maxDrawCalls: 26,
        maxTriangles: 65_094,
      }),
    ).toEqual([]);
  });

  it('rejects unstable timing and workload drift', () => {
    expect(
      compareBenchmarkRuns(first, {
        medianMs: 10.6,
        p75Ms: 12,
        p99Ms: 16,
        steadyHeapAfterBytes: 60_000_000,
        maxDrawCalls: 27,
        maxTriangles: 65_095,
      }),
    ).toEqual([
      'Benchmark medianMs variance must be < 5.0%; measured 5.83%.',
      'Benchmark draw-call counts differ: 26 versus 27.',
      'Benchmark triangle counts differ: 65,094 versus 65,095.',
    ]);
  });

  it('compares the reported aggregate frame percentiles literally', () => {
    expect(
      compareBenchmarkRuns(
        {
          ...first,
          medianMs: 10,
          p75Ms: 12,
          p99Ms: 16,
          legs: [
            { id: 'leo', medianMs: 100, p75Ms: 116.6, p99Ms: 133.3 },
            { id: 'moon-flyby', medianMs: 16.7, p75Ms: 16.7, p99Ms: 33.565 },
            { id: 'jupiter-approach', medianMs: 16.7, p75Ms: 16.7, p99Ms: 16.8 },
          ],
        },
        {
          ...first,
          medianMs: 10.6,
          p75Ms: 12,
          p99Ms: 16,
          legs: [
            { id: 'leo', medianMs: 100, p75Ms: 116.6, p99Ms: 133.4 },
            { id: 'moon-flyby', medianMs: 16.7, p75Ms: 16.7, p99Ms: 33.566 },
            { id: 'jupiter-approach', medianMs: 16.7, p75Ms: 16.7, p99Ms: 16.8 },
          ],
        },
      ),
    ).toEqual(['Benchmark medianMs variance must be < 5.0%; measured 5.83%.']);
  });

  it('does not substitute game-work metrics for the reported frame percentiles', () => {
    expect(
      compareBenchmarkRuns(
        {
          ...first,
          legs: [
            {
              id: 'leo',
              medianMs: 100,
              p75Ms: 116.6,
              p99Ms: 133.3,
              workMedianMs: 4,
              workP75Ms: 4.5,
              workP99Ms: 5,
            },
          ],
        },
        {
          ...first,
          legs: [
            {
              id: 'leo',
              medianMs: 1,
              p75Ms: 1,
              p99Ms: 1,
              workMedianMs: 4.1,
              workP75Ms: 4.6,
              workP99Ms: 5.1,
            },
          ],
        },
      ),
    ).toEqual([]);
  });

  it('rejects a steady heap footprint that varies by at least five percent', () => {
    expect(
      compareBenchmarkRuns(
        first,
        { ...first, steadyHeapAfterBytes: 64_000_000 },
      ),
    ).toEqual([
      'Benchmark steadyHeapAfterBytes variance must be < 5.0%; measured 6.45%.',
    ]);
  });
});

describe('parsePerformanceGolden', () => {
  const golden = {
    schemaVersion: 1,
    workload: workloadGolden,
    heap: { durationMs: 30_000, fixtureDurationMs: 1_000, maxRetainedGrowthBytes: 65_536 },
    bundle: { maxEntryGzipBytes: 300_000, maxTotalGzipBytes: 600_000 },
  };

  it('returns a frozen validated golden document', () => {
    const parsed = parsePerformanceGolden(golden);
    expect(parsed).toEqual(golden);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.workload)).toBe(true);
  });

  it('rejects unknown fields and invalid durations', () => {
    expect(() => parsePerformanceGolden({ ...golden, surprise: true })).toThrow(
      'performance golden has unexpected field "surprise"',
    );
    expect(() =>
      parsePerformanceGolden({ ...golden, heap: { ...golden.heap, durationMs: 0 } }),
    ).toThrow('heap.durationMs must be a positive integer');
  });
});

describe('heap settling criterion', () => {
  /**
   * The criterion that replaced "two quiet 5 s steps, then trust a 30 s window".
   * That version declared a steady state on CI at 65 s and the very next window
   * grew 277 kB, about 46 kB per step — the page was in a lull, not settled.
   */
  it('requires as much quiet evidence as the window it certifies', () => {
    expect(heapSettleRequiredSteps(30_000)).toBe(6);
    expect(heapSettleRequiredSteps(5_000)).toBe(1);
    // Rounds up: a partial step still has to be covered.
    expect(heapSettleRequiredSteps(31_000)).toBe(7);
  });

  it('scales the per-step budget from the ceiling so the two cannot drift', () => {
    expect(heapSettleStepBudgetBytes(196_608, 30_000)).toBe(16_384);
    expect(heapSettleStepBudgetBytes(196_608, 60_000)).toBe(8_192);
  });

  it('rejects a malformed ceiling or window instead of settling unconditionally', () => {
    expect(() => heapSettleStepBudgetBytes(196_608.5, 30_000)).toThrow(/integer ceiling/u);
    expect(() => heapSettleStepBudgetBytes(196_608, 0)).toThrow(/positive window/u);
    expect(() => heapSettleRequiredSteps(Number.POSITIVE_INFINITY)).toThrow(/positive window/u);
  });

  it('accepts a settled observation', () => {
    expect(validateHeapSettling({ requiredSteps: 6, settled: true, stableSteps: 6 })).toEqual([]);
  });

  /**
   * The hole this closes: a page leaking 4 kB/s is only 123 kB across the 30 s
   * window, under the 192 kB ceiling, so the heap check passed it green while
   * the settling loop knew it had never reached a steady state.
   */
  it('reports a failure to settle rather than letting the gate pass silently', () => {
    const findings = validateHeapSettling({
      elapsedMs: 180_000,
      peakStepGrowthBytes: 46_000,
      requiredSteps: 6,
      settled: false,
      stableSteps: 2,
      stepBudgetBytes: 16_384,
      steps: 36,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/never settled/u);
    expect(findings[0]).toMatch(/2 of 6 consecutive quiet steps/u);
    expect(findings[0]).toMatch(/peak step growth 46,000 bytes/u);
  });

  it('treats a missing observation as a failure, not as consent', () => {
    expect(validateHeapSettling(null)).toEqual(['Retained heap settling was not measured.']);
    expect(validateHeapSettling(undefined)).toHaveLength(1);
  });
});

describe('heap settle tracker', () => {
  const CEILING = 196_608;
  const WINDOW_MS = 30_000;

  /** Feeds `steps` samples produced by `growth(step)` and returns the final state. */
  function run(growth, steps) {
    const tracker = createHeapSettleTracker(CEILING, WINDOW_MS);
    let bytes = 50_000_000;
    tracker.observe(bytes);
    for (let step = 0; step < steps; step += 1) {
      bytes += growth(step);
      if (tracker.observe(bytes)) break;
    }
    return tracker.state;
  }

  /**
   * The reviewer's probe, made permanent and deterministic. 4,096 B/s is
   * 20,480 B per 5 s step — above the 16,384 B quiet budget, so it can never
   * settle — but only 122,880 B across the 30 s window, comfortably under the
   * 196,608 B ceiling. Before `validateHeapSettling`, a page leaking at this rate
   * (345 MB/day) exited the gate green.
   */
  it('never settles under a constant 4 kB/s leak', () => {
    const state = run(() => 4_096 * 5, 200);

    expect(state.settled).toBe(false);
    expect(state.stableSteps).toBe(0);
    expect(state.peakStepGrowthBytes).toBe(20_480);
  });

  /**
   * The honest limit of the criterion, stated rather than discovered later: a
   * leak slow enough to fit inside the per-step budget is indistinguishable from
   * a settled page, and 2 kB/s is 172 MB/day. The per-window ceiling is what
   * catches that, not this loop.
   */
  it('settles under a 2 kB/s leak, which the per-window ceiling must catch instead', () => {
    const state = run(() => 2_048 * 5, 200);

    expect(state.settled).toBe(true);
    expect(state.steps).toBe(6);
  });

  /**
   * The exact CI failure this criterion was strengthened for: the old rule wanted
   * two quiet steps, found them at 65 s, and the very next window grew 277 kB —
   * about 46 kB per step. Five quiet steps followed by a burst must not certify.
   */
  it('refuses to settle on a lull followed by a burst', () => {
    const state = run((step) => ((step + 1) % 6 === 0 ? 46_000 : 1_000), 60);

    expect(state.settled).toBe(false);
    expect(state.peakStepGrowthBytes).toBe(46_000);
  });

  it('settles once decaying warm-up growth falls inside the budget', () => {
    // 240 kB halving each step: the fifth step (15,000 B) is the first inside the
    // 16,384 B budget, so six consecutive quiet steps land on the tenth.
    const state = run((step) => Math.floor(240_000 / 2 ** step), 40);

    expect(state.settled).toBe(true);
    expect(state.steps).toBe(10);
    expect(state.peakStepGrowthBytes).toBe(240_000);
  });

  it('treats a shrinking heap as quiet', () => {
    expect(run(() => -10_000, 10).settled).toBe(true);
  });

  it('reports nothing settled before enough samples exist', () => {
    const tracker = createHeapSettleTracker(CEILING, WINDOW_MS);
    expect(tracker.observe(1_000)).toBe(false);
    expect(tracker.state.steps).toBe(0);
    expect(tracker.state.requiredSteps).toBe(6);
  });
});
