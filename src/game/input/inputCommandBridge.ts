import { WARP_LADDER, type WarpFactor } from '../../core/time.js';
import type { Commands } from '../../sim/simulationSnapshot.js';
import type { InputFrame } from './inputEngine.js';

/** Manual rotation rate commanded by a fully deflected axis, in sim rad/s. */
export const ROTATION_RATE_RAD_S = 0.6;

export interface InputCommandSnapshot {
  readonly requestedWarp: WarpFactor;
  readonly throttle: number;
}

export type InputCommandSnapshotProvider = () => InputCommandSnapshot;

/**
 * Applies an {@link InputFrame} to the simulation `Commands` facade.
 *
 * **Interim.** T0108's `FlightController` replaces this module; it exists so the
 * deployed game stays playable while the input engine lands. It reproduces v1's
 * `KeyboardCommandMapper` semantics, including the deliberate flush shape
 * documented per rule below. Wall-time rate normalization (plan §3.1) is not
 * applied here — it arrives with ADR-035.
 */
export class InputCommandBridge {
  private commands: Commands;
  private snapshotProvider: InputCommandSnapshotProvider;
  private appliedPitchRateRadS = 0;
  private appliedYawRateRadS = 0;
  private appliedRollRateRadS = 0;

  constructor(commands: Commands, snapshotProvider: InputCommandSnapshotProvider) {
    this.commands = commands;
    this.snapshotProvider = snapshotProvider;
  }

  /** Pushes one frame of intent into the simulation. Allocation-free. */
  apply(frame: InputFrame): void {
    this.applyRotation(frame);
    const snapshot = this.snapshotProvider();
    this.applyThrottle(frame, snapshot);
    this.applyWarp(frame, snapshot);
    this.applyAttitude(frame);
  }

  /** Forgets the commanded axis state and zeroes rotation in the simulation. */
  releaseAxes(): void {
    this.resetAxes();
    this.commands.rotate(0, 0, 0);
  }

  /**
   * Forgets the commanded axis state without touching the simulation.
   *
   * Used after a restore: the simulation already carries the saved rotation
   * rates, and commanding the (just released) axes over them would erase them.
   */
  resetAxes(): void {
    this.appliedPitchRateRadS = 0;
    this.appliedYawRateRadS = 0;
    this.appliedRollRateRadS = 0;
  }

  updateCommands(commands: Commands, snapshotProvider: InputCommandSnapshotProvider): void {
    this.releaseAxes();
    this.commands = commands;
    this.snapshotProvider = snapshotProvider;
  }

  private applyRotation(frame: InputFrame): void {
    const pitchRateRadS = frame.axes.pitch * ROTATION_RATE_RAD_S;
    const yawRateRadS = frame.axes.yaw * ROTATION_RATE_RAD_S;
    const rollRateRadS = frame.axes.roll * ROTATION_RATE_RAD_S;
    // Change-latched on purpose: rotate() overwrites the simulation's rotation
    // rates, so flushing every frame would clobber restored state.
    if (
      pitchRateRadS === this.appliedPitchRateRadS &&
      yawRateRadS === this.appliedYawRateRadS &&
      rollRateRadS === this.appliedRollRateRadS
    ) {
      return;
    }
    this.appliedPitchRateRadS = pitchRateRadS;
    this.appliedYawRateRadS = yawRateRadS;
    this.appliedRollRateRadS = rollRateRadS;
    this.commands.rotate(pitchRateRadS, yawRateRadS, rollRateRadS);
  }

  private applyThrottle(frame: InputFrame, snapshot: InputCommandSnapshot): void {
    // Compared against the simulation, not a local latch: setThrottle() forces 0
    // above MAX_THRUST_WARP, so a latch would leave the lever and the sim
    // permanently disagreed instead of resuming when warp drops back.
    if (frame.axes.throttle === snapshot.throttle) return;
    this.commands.setThrottle(frame.axes.throttle);
  }

  private applyWarp(frame: InputFrame, snapshot: InputCommandSnapshot): void {
    const steps = frame.pressCount('warpIncrease') - frame.pressCount('warpDecrease');
    if (steps === 0) return;
    const currentIndex = WARP_LADDER.indexOf(snapshot.requestedWarp);
    const nextIndex = Math.min(WARP_LADDER.length - 1, Math.max(0, currentIndex + steps));
    const nextWarp = WARP_LADDER[nextIndex];
    if (nextWarp !== undefined) this.commands.setWarp(nextWarp);
  }

  private applyAttitude(frame: InputFrame): void {
    if (frame.pressed('attitudeManual')) this.commands.setAttitudeMode('manual');
    if (frame.pressed('attitudePrograde')) this.commands.setAttitudeMode('prograde');
    if (frame.pressed('attitudeRetrograde')) this.commands.setAttitudeMode('retrograde');
  }
}
