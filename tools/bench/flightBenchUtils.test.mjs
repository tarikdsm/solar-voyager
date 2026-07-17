import { describe, expect, it } from 'vitest';

import {
  FIXED_FLIGHT_SEED,
  createFlightSchedule,
  summarizeFlightRun,
} from './flightBenchUtils.mjs';

describe('createFlightSchedule', () => {
  it('builds the fixed 180-second Earth, Moon, and Jupiter route', () => {
    const schedule = createFlightSchedule(FIXED_FLIGHT_SEED, 1_800);

    expect(schedule.virtualDurationSec).toBe(180);
    expect(schedule.sampleFrames).toBe(1_800);
    expect(schedule.legs).toEqual([
      { endFrame: 600, endSec: 60, id: 'leo', startFrame: 0, startSec: 0, target: 'earth' },
      {
        endFrame: 1_200,
        endSec: 120,
        id: 'moon-flyby',
        startFrame: 600,
        startSec: 60,
        target: 'moon',
      },
      {
        endFrame: 1_800,
        endSec: 180,
        id: 'jupiter-approach',
        startFrame: 1_200,
        startSec: 120,
        target: 'jupiter',
      },
    ]);
    expect(schedule.focusEvents).toEqual([
      { frame: 600, key: ']' },
      { frame: 1_200, key: 'j' },
    ]);
  });

  it('is repeatable for one seed and changes the zoom schedule for another', () => {
    const first = createFlightSchedule(FIXED_FLIGHT_SEED, 1_800);
    const repeated = createFlightSchedule(FIXED_FLIGHT_SEED, 1_800);
    const changed = createFlightSchedule(FIXED_FLIGHT_SEED + 1, 1_800);

    expect(repeated).toEqual(first);
    expect(changed.zoomEvents).not.toEqual(first.zoomEvents);
    expect(first.zoomEvents).toHaveLength(14);
  });

  it('rejects a frame count that cannot divide equally across all three legs', () => {
    expect(() => createFlightSchedule(FIXED_FLIGHT_SEED, 1_001)).toThrow(
      'Flight sample frames must be a positive multiple of three.',
    );
  });
});

describe('summarizeFlightRun', () => {
  it('calculates stable aggregate and per-leg percentiles', () => {
    expect(
      summarizeFlightRun({
        frameDeltasMs: [10, 20, 30, 40],
        heapAfterBytes: 900,
        heapBeforeBytes: 1_000,
        legs: [
          { frameDeltasMs: [10, 20], id: 'leo' },
          { frameDeltasMs: [30], id: 'moon-flyby' },
          { frameDeltasMs: [40], id: 'jupiter-approach' },
        ],
        maxDrawCalls: 26,
        maxTriangles: 65_094,
      }),
    ).toEqual({
      heapDeltaBytes: -100,
      legs: [
        { id: 'leo', medianMs: 15, p75Ms: 17.5, p99Ms: 19.9 },
        { id: 'moon-flyby', medianMs: 30, p75Ms: 30, p99Ms: 30 },
        { id: 'jupiter-approach', medianMs: 40, p75Ms: 40, p99Ms: 40 },
      ],
      maxDrawCalls: 26,
      maxTriangles: 65_094,
      medianMs: 25,
      p75Ms: 32.5,
      p99Ms: 39.7,
    });
  });

  it('fails closed without frame samples', () => {
    expect(() =>
      summarizeFlightRun({
        frameDeltasMs: [],
        heapAfterBytes: null,
        heapBeforeBytes: null,
        legs: [],
        maxDrawCalls: 0,
        maxTriangles: 0,
      }),
    ).toThrow('Flight benchmark did not capture frame samples.');
  });
});
