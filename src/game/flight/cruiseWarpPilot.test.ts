import { describe, expect, it } from 'vitest';

import { MAX_THRUST_WARP, WARP_LADDER, type WarpFactor } from '../../core/time.js';
import { WarpClampReason, type Commands, type SimSnapshot } from '../../sim/simulationSnapshot.js';

import {
  BUDGET_COOLDOWN_SEC,
  COMPRESS_STEP_SEC,
  CruiseWarpPilot,
  DECOMPRESS_STEP_SEC,
  DECOMPRESSED_WARP,
  DECOMPRESSION_HOLD_SEC,
} from './cruiseWarpPilot.js';

const FRAME_SEC = 1 / 60;

interface Harness {
  readonly pilot: CruiseWarpPilot;
  readonly snapshot: { requestedWarp: WarpFactor; warpClampReason: number; impactOccurred: 0 | 1 };
  readonly commands: Commands;
  readonly issued: WarpFactor[];
  run(ceiling: number, frames: number): void;
}

function harness(initialWarp: WarpFactor = 1): Harness {
  const snapshot = {
    requestedWarp: initialWarp,
    warpClampReason: WarpClampReason.NONE as number,
    impactOccurred: 0 as 0 | 1,
  };
  const issued: WarpFactor[] = [];
  const commands = {
    setThrottle: () => {},
    setAttitudeMode: () => {},
    rotate: () => {},
    setTarget: () => {},
    setWarp: (warp: WarpFactor) => {
      issued.push(warp);
      snapshot.requestedWarp = warp;
    },
  } satisfies Commands;
  const pilot = new CruiseWarpPilot();
  pilot.engage(snapshot as unknown as SimSnapshot);
  return {
    pilot,
    snapshot,
    commands,
    issued,
    run(ceiling: number, frames: number): void {
      for (let index = 0; index < frames; index += 1) {
        pilot.update(FRAME_SEC, ceiling, snapshot as unknown as SimSnapshot, commands);
      }
    },
  };
}

describe('CruiseWarpPilot', () => {
  it('climbs the ladder one tier at a time and stops at the ceiling', () => {
    const h = harness(1);
    h.run(MAX_THRUST_WARP, Math.ceil((6 * COMPRESS_STEP_SEC) / FRAME_SEC));
    expect(h.snapshot.requestedWarp).toBe(MAX_THRUST_WARP);
    expect(h.issued).toEqual([5, 10, 50, 100, 1_000]);
  });

  it('never requests a tier above the ceiling it is given', () => {
    const h = harness(1);
    h.run(DECOMPRESSED_WARP, 600);
    expect(h.snapshot.requestedWarp).toBe(DECOMPRESSED_WARP);
    for (const warp of h.issued) expect(warp).toBeLessThanOrEqual(DECOMPRESSED_WARP);
  });

  it('decompresses to 100x well inside the 1 s wall acceptance bound', () => {
    const h = harness(WARP_LADDER[WARP_LADDER.length - 1]);
    h.pilot.triggerDecompression();
    const frames = Math.ceil(1 / FRAME_SEC);
    let reachedFrame = -1;
    for (let index = 0; index < frames; index += 1) {
      h.run(MAX_THRUST_WARP, 1);
      if (reachedFrame < 0 && h.snapshot.requestedWarp <= DECOMPRESSED_WARP) reachedFrame = index + 1;
    }
    expect(reachedFrame).toBeGreaterThan(0);
    expect(reachedFrame * FRAME_SEC).toBeLessThanOrEqual(1);
    // Five tiers at DECOMPRESS_STEP_SEC each, and not one frame sooner.
    expect(reachedFrame * FRAME_SEC).toBeGreaterThanOrEqual(5 * DECOMPRESS_STEP_SEC - FRAME_SEC);
  });

  it('holds at 100x for the full decompression window before climbing again', () => {
    const h = harness(1_000);
    h.pilot.triggerDecompression();
    h.run(MAX_THRUST_WARP, Math.ceil((DECOMPRESSION_HOLD_SEC * 0.5) / FRAME_SEC));
    expect(h.snapshot.requestedWarp).toBeLessThanOrEqual(DECOMPRESSED_WARP);
    expect(h.pilot.decompressing).toBe(true);
    h.run(MAX_THRUST_WARP, Math.ceil(DECOMPRESSION_HOLD_SEC / FRAME_SEC));
    expect(h.pilot.decompressing).toBe(false);
    expect(h.snapshot.requestedWarp).toBe(MAX_THRUST_WARP);
  });

  it('backs off a tier on an integration-budget clamp and waits before climbing', () => {
    const h = harness(1);
    h.run(MAX_THRUST_WARP, 400);
    expect(h.snapshot.requestedWarp).toBe(MAX_THRUST_WARP);
    h.snapshot.warpClampReason = WarpClampReason.INTEGRATION_BUDGET;
    h.run(MAX_THRUST_WARP, 1);
    expect(h.snapshot.requestedWarp).toBe(100);
    h.snapshot.warpClampReason = WarpClampReason.NONE;
    h.run(MAX_THRUST_WARP, Math.ceil((BUDGET_COOLDOWN_SEC * 0.5) / FRAME_SEC));
    expect(h.snapshot.requestedWarp).toBe(100);
    h.run(MAX_THRUST_WARP, Math.ceil(BUDGET_COOLDOWN_SEC / FRAME_SEC) + 60);
    expect(h.snapshot.requestedWarp).toBe(MAX_THRUST_WARP);
  });

  it('pins a frozen ship at 1x and issues nothing after release', () => {
    const h = harness(1);
    h.run(MAX_THRUST_WARP, 400);
    h.snapshot.impactOccurred = 1;
    const before = h.issued.length;
    h.run(MAX_THRUST_WARP, 10);
    expect(h.issued.length).toBe(before);
    expect(h.pilot.requestedWarp).toBe(1);
    h.pilot.release();
    h.run(MAX_THRUST_WARP, 100);
    expect(h.issued.length).toBe(before);
  });
});
