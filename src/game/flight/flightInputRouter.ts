import { WARP_LADDER } from '../../core/time.js';
import type { AttitudeMode, Commands, SimSnapshot } from '../../sim/simulationSnapshot.js';
import type { InputAction, InputFrame } from '../input/inputEngine.js';
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
  constructor(
    private readonly controller: FlightController,
    private ports: FlightInputPorts,
  ) {}

  /** Pushes one polled frame into the controller. Allocation-free. */
  apply(frame: InputFrame): void {
    this.controller.setLookDelta(frame.lookYawRad, frame.lookPitchRad);
    this.controller.setRotationAxes(frame.axes.pitch, frame.axes.yaw, frame.axes.roll);
    this.controller.setThrottleAxis(frame.axes.throttle);
    this.applyWarp(frame);
    this.applyAssists(frame);
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
