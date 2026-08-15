import type { GamepadSettings, InputAction } from '../settings.js';
import { INPUT_ACTION_COUNT, actionIndex } from './bindings.js';

export { INPUT_ACTION_COUNT };

/** Standard `Gamepad` mapping axis indices (https://www.w3.org/TR/gamepad/#remapping). */
const AXIS_LEFT_X = 0;
const AXIS_LEFT_Y = 1;
const AXIS_RIGHT_X = 2;

/** Standard `Gamepad` mapping button indices this task uses. */
const BUTTON_A = 0;
const BUTTON_B = 1;
const BUTTON_LEFT_TRIGGER = 6;
const BUTTON_RIGHT_TRIGGER = 7;

const STANDARD_MAPPING = 'standard';

interface GamepadButtonBinding {
  readonly buttonIndex: number;
  readonly action: InputAction;
}

/**
 * A/B are reserved for T0116's `CruiseDirector`; nothing reads either action
 * yet (see `flightInputRouter.ts`'s `HOLD_BINDINGS`, which does not iterate
 * `INPUT_ACTIONS` and so cannot pick these up accidentally). This table is the
 * only place a gamepad button turns into an `InputAction` — extend it here
 * when a future task wants another button.
 */
export const GAMEPAD_BUTTON_BINDINGS: readonly GamepadButtonBinding[] = Object.freeze([
  Object.freeze({ buttonIndex: BUTTON_A, action: 'cruiseEngage' }),
  Object.freeze({ buttonIndex: BUTTON_B, action: 'cruiseAbort' }),
] as const satisfies readonly GamepadButtonBinding[]);

function clampAxis(value: number): number {
  if (value > 1) return 1;
  return value < -1 ? -1 : value;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/**
 * Rescales `raw` so `|raw| <= deadzone` maps to exactly 0 and the surviving
 * range maps back onto `[0, 1]`, preserving sign. A raw clamp (just zeroing
 * the dead band without rescaling) would leave the top `deadzone` fraction of
 * physical stick travel unreachable; this keeps `|raw| = 1` reachable at any
 * deadzone setting below 1.
 */
export function applyDeadzone(raw: number, deadzone: number): number {
  const magnitude = Math.abs(raw);
  if (magnitude <= deadzone) return 0;
  const sign = raw < 0 ? -1 : 1;
  return (sign * (magnitude - deadzone)) / (1 - deadzone);
}

/**
 * Signed power-law response curve ("expo" in flight-sim terminology).
 *
 * `exponent > 1` gives finer control near center while `magnitude === 1` still
 * maps to `1` (full deflection stays reachable) for any positive exponent.
 */
export function applyResponseCurve(value: number, exponent: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.abs(value) ** exponent;
}

/**
 * Deadzone -> curve -> invert -> sensitivity -> clamp. The one shaping
 * pipeline every logical axis (pitch, yaw, roll, and the trigger-derived
 * throttle) goes through, so deadzone/curve behave identically everywhere and
 * only invert/sensitivity vary per axis.
 */
export function shapeGamepadAxis(
  raw: number,
  deadzone: number,
  curveExponent: number,
  axis: { readonly invert: boolean; readonly sensitivity: number },
): number {
  const deadzoned = applyDeadzone(raw, deadzone);
  if (deadzoned === 0) return 0;
  const curved = applyResponseCurve(deadzoned, curveExponent);
  const signed = axis.invert ? -curved : curved;
  return clampAxis(signed * axis.sensitivity);
}

export interface GamepadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

/** The subset of the DOM `Gamepad` interface this module reads. */
export interface GamepadLike {
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly GamepadButtonLike[];
}

/**
 * Device access, behind a structural port exactly like `PointerLockSurface`.
 *
 * `getGamepads()` is expected to return a fresh array on every call (a
 * documented Chromium behavior) — callers must not rely on reference
 * identity across calls, and must not retain the returned array or any
 * `GamepadLike` read out of it past the synchronous call that read it.
 */
export interface GamepadHost {
  getGamepads(): readonly (GamepadLike | null | undefined)[];
  addEventListener(type: 'gamepadconnected' | 'gamepaddisconnected', listener: () => void): void;
  removeEventListener(type: 'gamepadconnected' | 'gamepaddisconnected', listener: () => void): void;
}

/** What `InputEngine` depends on; `GamepadPoller` is the concrete implementation. */
export interface GamepadSource {
  /**
   * Reads the current device state. Allocation-free and calls `getGamepads()`
   * zero times when nothing is connected (the early-out the CI heap gate
   * depends on); while connected it calls `getGamepads()` exactly once and
   * copies only primitive values out of the result before returning.
   */
  poll(): void;
  readonly connected: boolean;
  /** Shaped `[-1, 1]`, 0 when centered, deadzoned, or disconnected. */
  readonly pitchAxis: number;
  readonly yawAxis: number;
  readonly rollAxis: number;
  /** True when the trigger pair is deflected past the deadzone this poll. */
  readonly throttleActive: boolean;
  /** Shaped `[0, 1]` lever position; only meaningful while `throttleActive`. */
  readonly throttleValue: number;
  /** ORs button-down state and adds fresh-this-poll press edges into the caller's frame arrays. */
  mergeButtonsInto(targetDown: Uint8Array, targetEdges: Uint8Array): void;
  applySettings(settings: GamepadSettings): void;
  dispose(): void;
}

const MAX_EDGE_COUNT = 255;

/**
 * Polls the Gamepad API into the shaped axis values `InputEngine` merges into
 * its `InputFrame`, and the two reserved cruise-button actions.
 *
 * Connect/disconnect gates every `getGamepads()` call: `primaryIndex` is
 * maintained only inside the (rare) connect/disconnect callback by rescanning
 * once, so the steady-state `poll()` on every disconnected frame is a single
 * field comparison with zero device calls and zero allocation.
 */
export class GamepadPoller implements GamepadSource {
  private readonly host: GamepadHost;
  private settings: GamepadSettings;
  private primaryIndex = -1;
  private _connected = false;
  private _pitchAxis = 0;
  private _yawAxis = 0;
  private _rollAxis = 0;
  private _throttleActive = false;
  private _throttleValue = 0;
  private readonly down = new Uint8Array(INPUT_ACTION_COUNT);
  private readonly edgeThisPoll = new Uint8Array(INPUT_ACTION_COUNT);
  private disposed = false;

  private readonly handleConnectionChange = (): void => {
    this.rescanConnectedGamepads();
  };

  constructor(host: GamepadHost, settings: GamepadSettings) {
    this.host = host;
    this.settings = settings;
    this.host.addEventListener('gamepadconnected', this.handleConnectionChange);
    this.host.addEventListener('gamepaddisconnected', this.handleConnectionChange);
  }

  get connected(): boolean {
    return this._connected;
  }

  get pitchAxis(): number {
    return this._pitchAxis;
  }

  get yawAxis(): number {
    return this._yawAxis;
  }

  get rollAxis(): number {
    return this._rollAxis;
  }

  get throttleActive(): boolean {
    return this._throttleActive;
  }

  get throttleValue(): number {
    return this._throttleValue;
  }

  applySettings(settings: GamepadSettings): void {
    this.settings = settings;
  }

  poll(): void {
    if (this.primaryIndex < 0) {
      this.resetSample();
      return;
    }
    const pads = this.host.getGamepads();
    const pad = pads[this.primaryIndex];
    if (pad === null || pad === undefined || !pad.connected || pad.mapping !== STANDARD_MAPPING) {
      // A disconnect this instance has not been notified of yet, or a sparse
      // slot: fail safe rather than read stale/garbage indices.
      this.resetSample();
      return;
    }
    this._connected = true;
    const axes = pad.axes;
    const buttons = pad.buttons;
    const deadzone = this.settings.deadzone;
    const curveExponent = this.settings.curveExponent;
    const axisSettings = this.settings.axes;

    const rawLeftX = axes[AXIS_LEFT_X] ?? 0;
    const rawLeftY = axes[AXIS_LEFT_Y] ?? 0;
    const rawRightX = axes[AXIS_RIGHT_X] ?? 0;
    // Left-stick Y is +1 toward the player per the standard-mapping spec; the
    // keyboard/mouse-look convention this game already ships is "away from the
    // body = pitch up" (see gamepad-design.md), hence the negation here.
    this._pitchAxis = shapeGamepadAxis(-rawLeftY, deadzone, curveExponent, axisSettings.pitch);
    this._yawAxis = shapeGamepadAxis(rawLeftX, deadzone, curveExponent, axisSettings.yaw);
    this._rollAxis = shapeGamepadAxis(rawRightX, deadzone, curveExponent, axisSettings.roll);

    const leftTrigger = buttons[BUTTON_LEFT_TRIGGER]?.value ?? 0;
    const rightTrigger = buttons[BUTTON_RIGHT_TRIGGER]?.value ?? 0;
    const shapedThrottle = shapeGamepadAxis(
      rightTrigger - leftTrigger,
      deadzone,
      curveExponent,
      axisSettings.throttle,
    );
    this._throttleActive = shapedThrottle !== 0;
    this._throttleValue = clamp01(shapedThrottle);

    for (let index = 0; index < GAMEPAD_BUTTON_BINDINGS.length; index += 1) {
      const binding = GAMEPAD_BUTTON_BINDINGS[index];
      if (binding === undefined) continue;
      const actionIdx = actionIndex(binding.action);
      if (actionIdx < 0) continue;
      const pressed = buttons[binding.buttonIndex]?.pressed === true;
      const wasDown = this.down[actionIdx] === 1;
      this.edgeThisPoll[actionIdx] = pressed && !wasDown ? 1 : 0;
      this.down[actionIdx] = pressed ? 1 : 0;
    }
  }

  mergeButtonsInto(targetDown: Uint8Array, targetEdges: Uint8Array): void {
    for (let index = 0; index < GAMEPAD_BUTTON_BINDINGS.length; index += 1) {
      const binding = GAMEPAD_BUTTON_BINDINGS[index];
      if (binding === undefined) continue;
      const actionIdx = actionIndex(binding.action);
      if (actionIdx < 0) continue;
      if (this.down[actionIdx] === 1) targetDown[actionIdx] = 1;
      if (this.edgeThisPoll[actionIdx] === 1) {
        const current = targetEdges[actionIdx] ?? 0;
        if (current < MAX_EDGE_COUNT) targetEdges[actionIdx] = current + 1;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.removeEventListener('gamepadconnected', this.handleConnectionChange);
    this.host.removeEventListener('gamepaddisconnected', this.handleConnectionChange);
  }

  /**
   * Rebuilds `primaryIndex` from scratch. Only ever called from the
   * connect/disconnect callback, never from `poll()` — this is the one place
   * allowed to call `getGamepads()` unconditionally, since gamepad connection
   * changes are rare, user-driven events rather than per-frame work.
   */
  private rescanConnectedGamepads(): void {
    const pads = this.host.getGamepads();
    let lowestIndex = -1;
    for (let index = 0; index < pads.length; index += 1) {
      const pad = pads[index];
      if (
        pad !== null &&
        pad !== undefined &&
        pad.connected &&
        pad.mapping === STANDARD_MAPPING &&
        (lowestIndex < 0 || index < lowestIndex)
      ) {
        lowestIndex = index;
      }
    }
    this.primaryIndex = lowestIndex;
    if (lowestIndex < 0) this.resetSample();
  }

  /** Clears shaped output and button latches. Mirrors `InputEngine.releaseHeldKeys()`'s intent for keyboard. */
  private resetSample(): void {
    this._connected = false;
    this._pitchAxis = 0;
    this._yawAxis = 0;
    this._rollAxis = 0;
    this._throttleActive = false;
    this._throttleValue = 0;
    this.down.fill(0);
    this.edgeThisPoll.fill(0);
  }
}
