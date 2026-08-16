// v2 plan §5 T0116 — the CruiseDirector's time-warp pilot.
//
// Requests ladder tiers and nothing else: every clamp that already exists stays
// where it is. `Commands.setThrottle` forces 0 above `MAX_THRUST_WARP` and
// `Commands.rotate` forces 0 above `MANUAL_ATTITUDE_MAX_WARP`, so the ceilings
// here are the director's way of not asking for a tier that would silently
// discard the command it is about to issue.

import { MANUAL_ATTITUDE_MAX_WARP, WARP_LADDER, type WarpFactor } from '../../core/time.js';
import { WarpClampReason, type Commands, type SimSnapshot } from '../../sim/simulationSnapshot.js';

/** Wall seconds between successive downward ladder steps. */
export const DECOMPRESS_STEP_SEC = 0.05;

/**
 * Wall seconds between successive upward ladder steps.
 *
 * Only decompression carries a contract (<= 100x within 1 s), so compression is
 * paced purely for legibility. It is not free: the endgame re-aims a few hundred
 * times, and every re-aim drops five tiers, so a slow climb back is the single
 * largest wall-clock cost in an arrival.
 */
export const COMPRESS_STEP_SEC = 0.05;

/**
 * Wall seconds a decompression trigger pins the request at or below 100x.
 *
 * The acceptance bound is "<= 100x within 1 s wall"; the ladder is ten tiers, so
 * the worst case (1e7x to 100x, five steps at {@link DECOMPRESS_STEP_SEC}) is
 * 0.25 s and the hold is what keeps it there long enough to be seen.
 */
export const DECOMPRESSION_HOLD_SEC = 1;

/** Wall seconds the pilot stays off the accelerator after an integration-budget clamp. */
export const BUDGET_COOLDOWN_SEC = 2;

/** Highest tier reached while any decompression trigger is live. */
export const DECOMPRESSED_WARP: WarpFactor = MANUAL_ATTITUDE_MAX_WARP;

function ladderIndexAtOrBelow(ceiling: number): number {
  let index = 0;
  for (let candidate = 0; candidate < WARP_LADDER.length; candidate += 1) {
    if ((WARP_LADDER[candidate] as number) <= ceiling) index = candidate;
  }
  return index;
}

/**
 * Steps the requested warp toward a per-phase ceiling, one ladder tier at a time.
 *
 * Allocation-free. The pilot owns no timers of its own beyond two wall-second
 * accumulators, and issues `setWarp` only when the tier actually changes.
 */
export class CruiseWarpPilot {
  private currentIndex = 0;
  private stepAccumulatorSec = 0;
  private decompressionHoldSec = 0;
  private budgetCooldownSec = 0;
  private engaged = false;

  /** The ladder tier last requested; meaningless before the first `update`. */
  get requestedWarp(): WarpFactor {
    return WARP_LADDER[this.currentIndex] as WarpFactor;
  }

  /** True while a decompression trigger is still pinning the request at 100x. */
  get decompressing(): boolean {
    return this.decompressionHoldSec > 0;
  }

  /** Adopts the tier already in force so the first step is relative to reality. */
  engage(snapshot: SimSnapshot): void {
    this.currentIndex = ladderIndexAtOrBelow(snapshot.requestedWarp);
    this.stepAccumulatorSec = 0;
    this.budgetCooldownSec = 0;
    this.engaged = true;
  }

  /** Stops piloting; the player's ladder keys own the warp again. */
  release(): void {
    this.engaged = false;
    this.decompressionHoldSec = 0;
  }

  /** Pins the request at or below 100x for {@link DECOMPRESSION_HOLD_SEC} of wall time. */
  triggerDecompression(): void {
    this.decompressionHoldSec = DECOMPRESSION_HOLD_SEC;
  }

  /**
   * Advances one frame toward `ceilingWarp` and issues `setWarp` when the tier moves.
   *
   * `ceilingWarp` is the phase's own limit (thrust ceiling, slew ceiling, or a
   * bound derived from how much simulated time the current manoeuvre has left).
   */
  update(wallDtSec: number, ceilingWarp: number, snapshot: SimSnapshot, commands: Commands): void {
    const dtSec = Number.isFinite(wallDtSec) && wallDtSec > 0 ? wallDtSec : 0;
    if (this.decompressionHoldSec > 0) this.decompressionHoldSec -= dtSec;
    if (this.budgetCooldownSec > 0) this.budgetCooldownSec -= dtSec;
    if (!this.engaged) return;

    // A frozen ship is pinned at 1x by `setWarp` itself (ADR-036); asking for
    // anything else would be a command the simulation is right to discard.
    if (snapshot.impactOccurred === 1) {
      this.currentIndex = 0;
      return;
    }
    // The integration budget clamped the tier the simulation actually completed.
    // Respect it by dropping one rung rather than re-requesting what was refused.
    if (snapshot.warpClampReason === WarpClampReason.INTEGRATION_BUDGET) {
      this.budgetCooldownSec = BUDGET_COOLDOWN_SEC;
      if (this.currentIndex > 0) this.currentIndex -= 1;
      this.stepAccumulatorSec = 0;
      this.flush(snapshot, commands);
      return;
    }

    const effectiveCeiling =
      this.decompressionHoldSec > 0 ? Math.min(ceilingWarp, DECOMPRESSED_WARP) : ceilingWarp;
    let targetIndex = ladderIndexAtOrBelow(effectiveCeiling);
    if (this.budgetCooldownSec > 0 && targetIndex > this.currentIndex) {
      targetIndex = this.currentIndex;
    }
    if (targetIndex === this.currentIndex) {
      this.stepAccumulatorSec = 0;
      this.flush(snapshot, commands);
      return;
    }
    this.stepAccumulatorSec += dtSec;
    const stepSec = targetIndex < this.currentIndex ? DECOMPRESS_STEP_SEC : COMPRESS_STEP_SEC;
    while (this.stepAccumulatorSec >= stepSec && targetIndex !== this.currentIndex) {
      this.stepAccumulatorSec -= stepSec;
      this.currentIndex += targetIndex < this.currentIndex ? -1 : 1;
    }
    this.flush(snapshot, commands);
  }

  private flush(snapshot: SimSnapshot, commands: Commands): void {
    const warp = WARP_LADDER[this.currentIndex] as WarpFactor;
    if (snapshot.requestedWarp === warp) return;
    commands.setWarp(warp);
  }
}
