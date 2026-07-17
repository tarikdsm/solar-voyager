import { describe, expect, it } from 'vitest';

import {
  compareBenchmarkRuns,
  parsePerformanceGolden,
  validateBundleSizes,
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
    maxDrawCalls: 26,
    maxTriangles: 65_094,
  });

  it('accepts timing variance below five percent and exact workload counts', () => {
    expect(
      compareBenchmarkRuns(first, {
        medianMs: 10.4,
        p75Ms: 12.5,
        p99Ms: 16.7,
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
        maxDrawCalls: 27,
        maxTriangles: 65_095,
      }),
    ).toEqual([
      'Benchmark medianMs variance must be < 5.0%; measured 5.83%.',
      'Benchmark draw-call counts differ: 26 versus 27.',
      'Benchmark triangle counts differ: 65,094 versus 65,095.',
    ]);
  });

  it('compares each scripted-flight leg instead of the mixed aggregate distribution', () => {
    expect(
      compareBenchmarkRuns(
        {
          ...first,
          p99Ms: 133.3,
          legs: [
            { id: 'leo', medianMs: 100, p75Ms: 116.6, p99Ms: 133.3 },
            { id: 'moon-flyby', medianMs: 16.7, p75Ms: 16.7, p99Ms: 33.565 },
            { id: 'jupiter-approach', medianMs: 16.7, p75Ms: 16.7, p99Ms: 16.8 },
          ],
        },
        {
          ...first,
          p99Ms: 116.965,
          legs: [
            { id: 'leo', medianMs: 100, p75Ms: 116.6, p99Ms: 133.4 },
            { id: 'moon-flyby', medianMs: 16.7, p75Ms: 16.7, p99Ms: 33.566 },
            { id: 'jupiter-approach', medianMs: 16.7, p75Ms: 16.7, p99Ms: 16.8 },
          ],
        },
      ),
    ).toEqual([]);
  });

  it('rejects unstable scripted-flight legs and mismatched leg identities', () => {
    expect(
      compareBenchmarkRuns(
        {
          ...first,
          legs: [{ id: 'leo', medianMs: 10, p75Ms: 12, p99Ms: 16 }],
        },
        {
          ...first,
          legs: [{ id: 'moon-flyby', medianMs: 11, p75Ms: 12, p99Ms: 16 }],
        },
      ),
    ).toEqual([
      'Benchmark leg identities differ at index 0: "leo" versus "moon-flyby".',
      'Benchmark leg "leo" medianMs variance must be < 5.0%; measured 9.52%.',
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
