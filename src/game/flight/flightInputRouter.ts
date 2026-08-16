import { WARP_LADDER } from '../../core/time.js';
import type { AttitudeMode, Commands, SimSnapshot } from '../../sim/simulationSnapshot.js';
import type { InputAction, InputFrame } from '../input/inputEngine.js';
import type { CruiseDirector } from './cruiseDirector.js';
import type { FlightController } from './flightController.js';

interface HoldBinding {
  readonly action: InputAction;
  readonly mode: AttitudeMode;
}

/** Press-edge bindings for all eight attitude modes, in `INPUT_ACTIONS` order. */
const HOLD_BINDINGS: readonly HoldBinding[] = Object.freeze([
  Object.freeze({ action: 'attitudeManual', mode: 'manual' }),
  Object.freeze({ action: 'attitudePrograde', mode: 'prograde' }),
  Object.freeze({ action: 'attitudeRetrograde', mode: 'retrograde' }),
  Object.freeze({ action: 'attitudeNormal', mode: 'normal' }),
  Object.freeze({ action: 'attitudeAntinormal', mode: 'antinormal' }),
  Object.freeze({ action: 'attitudeRadialOut', mode: 'radialOut' }),
  Object.freeze({ action: 'attitudeRadialIn', mode: 'radialIn' }),
  Object.freeze({ action: 'attitudeTarget', mode: 'target' }),
] as const satisfies readonly HoldBinding[]);

export interface FlightInputPorts {
  readonly commands: Commands;
  snapshot(): SimSnapshot;
}

/**
 * The one module that knows both `InputFrame` and `FlightController`.
 *
 * The plan §2 contract deliberately takes decomposed setters so the controller
 * never sees a device: T0106 drives the same setters from a gamepad and T0116's
 * `CruiseDirector` drives them with no device at all. Time warp is player
 * intent but not flight control, so it lives here and speaks to `Commands`
 * directly, exactly as T0105's interim bridge did.
 */
export class FlightInputRouter {
  private cruiseDirector: CruiseDirector | null = null;
  private lastThrottleAxis = 0;

  constructor(
    private readonly controller: FlightController,
    private ports: FlightInputPorts,
  ) {}

  /**
   * Binds the cruise autopilot (T0116). Additive setter rather than a third
   * constructor argument so the plan §2 signature is unchanged; this is the only
   * module that sees an `InputFrame`, so it is the only place that can tell the
   * director that the player has touched something.
   */
  setCruiseDirector(director: CruiseDirector | null): void {
    this.cruiseDirector = director;
  }

  /** Pushes one polled frame into the controller. Allocation-free. */
  apply(frame: InputFrame): void {
    this.controller.setLookDelta(frame.lookYawRad, frame.lookPitchRad);
    this.controller.setRotationAxes(frame.axes.pitch, frame.axes.yaw, frame.axes.roll);
    this.controller.setThrottleAxis(frame.axes.throttle);
    this.applyWarp(frame);
    this.applyAssists(frame);
    this.applyCruise(frame);
  }

  /** Re-points the warp path at a replacement simulation. */
  updatePorts(ports: FlightInputPorts): void {
    this.ports = ports;
  }

  private applyWarp(frame: InputFrame): void {
    const steps = frame.pressCount('warpIncrease') - frame.pressCount('warpDecrease');
    if (steps === 0) return;
    const currentIndex = WARP_LADDER.indexOf(this.ports.snapshot().requestedWarp);
    const nextIndex = Math.min(WARP_LADDER.length - 1, Math.max(0, currentIndex + steps));
    const nextWarp = WARP_LADDER[nextIndex];
    if (nextWarp !== undefined) this.ports.commands.setWarp(nextWarp);
  }

  /**
   * Cruise engage/abort, and the "any player input decompresses" rule.
   *
   * The throttle axis is a *lever position*, so it counts as input only when it
   * moves; the two cruise actions are excluded from the input test, or engaging
   * would immediately abort the cruise it just started.
   */
  private applyCruise(frame: InputFrame): void {
    const director = this.cruiseDirector;
    if (director === null) return;
    if (frame.pressed('cruiseAbort')) director.abort();
    const throttleAxis = frame.axes.throttle;
    const throttleMoved = throttleAxis !== this.lastThrottleAxis;
    this.lastThrottleAxis = throttleAxis;
    if (
      frame.lookYawRad !== 0 ||
      frame.lookPitchRad !== 0 ||
      frame.axes.pitch !== 0 ||
      frame.axes.yaw !== 0 ||
      frame.axes.roll !== 0 ||
      throttleMoved ||
      frame.pressCount('warpIncrease') > 0 ||
      frame.pressCount('warpDecrease') > 0 ||
      frame.pressed('killRotation') ||
      frame.pressed('stabilityAssistToggle') ||
      this.holdPressed(frame)
    ) {
      director.notifyPlayerInput();
    }
    if (frame.pressed('cruiseEngage')) {
      const targetBodyId = this.ports.snapshot().targetBodyId;
      if (targetBodyId !== null) director.engage(targetBodyId, 'orbit');
    }
  }

  private holdPressed(frame: InputFrame): boolean {
    for (let index = 0; index < HOLD_BINDINGS.length; index += 1) {
      const binding = HOLD_BINDINGS[index];
      if (binding !== undefined && frame.pressed(binding.action)) return true;
    }
    return false;
  }

  private applyAssists(frame: InputFrame): void {
    for (let index = 0; index < HOLD_BINDINGS.length; index += 1) {
      const binding = HOLD_BINDINGS[index];
      if (binding === undefined) continue;
      if (frame.pressed(binding.action)) this.controller.requestHold(binding.mode);
    }
    if (frame.pressed('killRotation')) this.controller.killRotation();
    if (frame.pressed('stabilityAssistToggle')) this.controller.toggleStabilityAssist();
  }
}
