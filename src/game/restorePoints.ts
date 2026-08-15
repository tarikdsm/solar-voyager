import type { SimulationCore } from '../sim/simulation.js';
import type { SimulationPersistentState } from '../sim/simulationState.js';
import type { SimulationReplacementOrigin } from './sessionController.js';

/**
 * Whether a core replacement invalidates the ring.
 *
 * Only a **timeline change** does. Each slot is a self-contained
 * `SimulationPersistentState`, so after a restore or a respawn the older slots
 * are still valid, flyable states of the mission still in progress — clearing
 * them would reduce a six-slot ring to a one-deep undo. A new game, a loaded
 * save or an import start a mission those slots do not belong to.
 *
 * Exported so `main.ts` and the regression test share one rule instead of two
 * that can drift.
 */
export function replacementInvalidatesRestorePoints(origin: SimulationReplacementOrigin): boolean {
  return origin === 'new-game' || origin === 'load' || origin === 'import';
}

/** Slots retained by the ring; the oldest is overwritten (plan §3.4). */
export const RESTORE_POINT_CAPACITY = 6;

/** Wall-time cadence between captures, in seconds (plan §3.4). */
export const RESTORE_POINT_INTERVAL_SEC = 10;

/** One captured restore point, newest first in `list()`. */
export interface RestorePoint {
  /** Simulation time the slot was captured at, for labelling recovery UI. */
  readonly simTimeSec: number;
  readonly state: SimulationPersistentState;
}

/**
 * Fixed ring of recent flyable states, the recovery source after a surface
 * impact (ADR-036).
 *
 * `update` is called from the frame loop with the wall delta the loop already
 * has, so no clock reaches this module and the cadence is testable without
 * fake timers. Captures are skipped while the core is frozen, which keeps the
 * ring full of states the player can actually fly out of.
 *
 * Capture calls `SimulationCore.exportPersistentState()` and therefore
 * allocates, once per `RESTORE_POINT_INTERVAL_SEC` — about one allocation per
 * 600 frames. That is a deliberate, measured exception to the zero-allocation
 * rule, recorded in ADR-036 "Allocation": the rule binds the per-frame path, the
 * CI gate measures retained growth across a forced double-GC, and a parallel
 * allocation-free capture path would mean two persistence implementations that
 * must agree forever.
 */
export class RestorePointRing {
  private readonly slots: (RestorePoint | null)[] = new Array<RestorePoint | null>(
    RESTORE_POINT_CAPACITY,
  ).fill(null);

  private nextWriteIndex = 0;
  private retainedCount = 0;
  private elapsedSinceCaptureSec = Number.POSITIVE_INFINITY;

  constructor(
    private readonly intervalSec: number = RESTORE_POINT_INTERVAL_SEC,
    private readonly capacity: number = RESTORE_POINT_CAPACITY,
  ) {
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
      throw new RangeError('restore point interval must be finite and positive');
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('restore point capacity must be a positive integer');
    }
    this.slots.length = capacity;
    this.slots.fill(null);
  }

  get count(): number {
    return this.retainedCount;
  }

  /** Newest retained point, or null before the first capture. */
  get latest(): RestorePoint | null {
    if (this.retainedCount === 0) return null;
    return this.slots[(this.nextWriteIndex - 1 + this.capacity) % this.capacity] ?? null;
  }

  /** Index 0 is the newest retained point. */
  get(index: number): RestorePoint | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.retainedCount) return null;
    return (
      this.slots[(this.nextWriteIndex - 1 - index + 2 * this.capacity) % this.capacity] ?? null
    );
  }

  /**
   * Advances the wall-time accumulator and captures when the cadence is due.
   * Returns the captured point, or null when nothing was taken this frame.
   */
  update(simulation: SimulationCore, wallDeltaSec: number): RestorePoint | null {
    if (!Number.isFinite(wallDeltaSec) || wallDeltaSec < 0) {
      throw new RangeError('restore point wall delta must be finite and non-negative');
    }
    // A frozen core has nothing worth keeping, and capturing one would push the
    // last flyable state out of the ring exactly when it is needed.
    if (simulation.snapshot.impactOccurred === 1) return null;
    this.elapsedSinceCaptureSec += wallDeltaSec;
    if (this.elapsedSinceCaptureSec < this.intervalSec) return null;
    return this.capture(simulation);
  }

  /** Takes a point immediately, ignoring the cadence. */
  capture(simulation: SimulationCore): RestorePoint | null {
    let state: SimulationPersistentState;
    try {
      state = simulation.exportPersistentState();
    } catch {
      // A core that cannot describe itself is not a recovery source. Losing a
      // slot is strictly better than storing one that fails validation later,
      // when the player is already crashed and out of other options.
      return null;
    }
    const point: RestorePoint = { simTimeSec: state.simTimeSec, state };
    this.slots[this.nextWriteIndex] = point;
    this.nextWriteIndex = (this.nextWriteIndex + 1) % this.capacity;
    this.retainedCount = Math.min(this.retainedCount + 1, this.capacity);
    this.elapsedSinceCaptureSec = 0;
    return point;
  }

  /** Drops every slot; used when a new session replaces the simulation. */
  reset(): void {
    this.slots.fill(null);
    this.nextWriteIndex = 0;
    this.retainedCount = 0;
    this.elapsedSinceCaptureSec = Number.POSITIVE_INFINITY;
  }
}
