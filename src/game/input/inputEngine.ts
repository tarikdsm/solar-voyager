import type { GamepadSettings } from '../settings.js';
import {
  BindingTable,
  INPUT_ACTION_COUNT,
  actionIndex,
  blocksGameKey,
  type InputAction,
  type InputBindings,
} from './bindings.js';
import type { GamepadSource } from './gamepad.js';

export type { InputAction, InputBindings };

/** Wall seconds a held throttle key needs to sweep the full [0, 1] range. */
export const THROTTLE_FULL_SWEEP_SEC = 1.5;
/** Analog throttle ramp rate while a throttle key is held, in units per wall second. */
export const THROTTLE_RAMP_PER_SEC = 1 / THROTTLE_FULL_SWEEP_SEC;
/**
 * Immediate change applied by a throttle key tap.
 *
 * A press and release that both land between two polls have zero held duration,
 * so a pure ramp would ignore them entirely. The lever value stays continuous;
 * only the nudge is quantized.
 */
export const THROTTLE_TAP_STEP = 0.1;
/** Default mouse-look sensitivity in radians per pointer-lock pixel (T0106 makes it a setting). */
export const DEFAULT_LOOK_RAD_PER_PIXEL = 0.0022;

const ESCAPE_CODE = 'Escape';
const MAX_EDGE_COUNT = 255;

export interface InputKeyboardEvent {
  readonly altKey: boolean;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly defaultPrevented?: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

export interface InputPointerMotionEvent {
  readonly movementX: number;
  readonly movementY: number;
}

export type InputKeyboardListener = (event: InputKeyboardEvent) => void;
export type InputBlurListener = () => void;

export interface InputKeyboardTarget {
  addEventListener(type: 'keydown' | 'keyup', listener: InputKeyboardListener): void;
  addEventListener(type: 'blur', listener: InputBlurListener): void;
  removeEventListener(type: 'keydown' | 'keyup', listener: InputKeyboardListener): void;
  removeEventListener(type: 'blur', listener: InputBlurListener): void;
}

/**
 * Port over the browser pointer-lock API.
 *
 * `src/game/` never touches globals; `main.ts` supplies the canvas/document
 * adapter, exactly as `KeyValueStorage` is supplied to `SettingsRepository`.
 */
export interface PointerLockSurface {
  isLocked(): boolean;
  requestLock(): void;
  releaseLock(): void;
  onMotion(listener: (event: InputPointerMotionEvent) => void): void;
  onLockChange(listener: () => void): void;
  dispose(): void;
}

export interface InputAxes {
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
  readonly throttle: number;
}

/**
 * One frame of player intent, polled once per frame and reused forever.
 *
 * Consumers must read the values before the next `poll()` and must never retain
 * the object: it is the engine's preallocated scratch, not a snapshot.
 */
export interface InputFrame {
  /** Pointer-lock yaw delta accumulated since the previous poll, wall frame, +right. */
  readonly lookYawRad: number;
  /** Pointer-lock pitch delta accumulated since the previous poll, wall frame, +up. */
  readonly lookPitchRad: number;
  readonly axes: InputAxes;
  /** Edge query: the action went down since the previous poll. */
  pressed(action: InputAction): boolean;
  /** How many times the action went down since the previous poll (saturating). */
  pressCount(action: InputAction): number;
  /** Level query: the action's key is down right now. */
  held(action: InputAction): boolean;
}

class MutableInputAxes implements InputAxes {
  pitch = 0;
  yaw = 0;
  roll = 0;
  throttle = 0;
}

class MutableInputFrame implements InputFrame {
  lookYawRad = 0;
  lookPitchRad = 0;
  readonly axes = new MutableInputAxes();
  readonly down = new Uint8Array(INPUT_ACTION_COUNT);
  readonly edges = new Uint8Array(INPUT_ACTION_COUNT);

  pressed(action: InputAction): boolean {
    return this.pressCount(action) > 0;
  }

  pressCount(action: InputAction): number {
    const index = actionIndex(action);
    return index < 0 ? 0 : (this.edges[index] ?? 0);
  }

  held(action: InputAction): boolean {
    const index = actionIndex(action);
    return index >= 0 && this.down[index] === 1;
  }
}

export interface InputEngineOptions {
  readonly keyboardTarget: InputKeyboardTarget;
  readonly bindings: InputBindings;
  readonly pointerLock?: PointerLockSurface;
  /** Raised when the player asks to pause. T0112 owns the menu; T0105 wires a stub. */
  readonly onPauseRequested?: () => void;
  readonly lookRadPerPixel?: number;
  /** T0106: polls the Gamepad API and is merged into the same frame every poll(). */
  readonly gamepad?: GamepadSource;
  /**
   * True while a real text-entry control has focus. Keyboard gates this per
   * `KeyboardEvent.target`; a gamepad has no event target to check, so the
   * frame loop supplies this instead. Defaults to "never typing" so tests and
   * callers that never wire a gamepad are unaffected.
   */
  readonly isTextEntryActive?: () => boolean;
}

/**
 * Turns raw keyboard and pointer-lock events into one allocation-free
 * {@link InputFrame} per frame.
 *
 * Replaces v1's `KeyboardCommandMapper`. The engine never speaks to the
 * simulation: `game/flight/flightInputRouter.ts` turns a frame into
 * `FlightController` intent, and the controller is the only writer of
 * attitude and throttle `Commands`.
 */
export class InputEngine {
  private readonly frame = new MutableInputFrame();
  private readonly pendingEdges = new Uint8Array(INPUT_ACTION_COUNT);
  /**
   * Keyboard-only down state, mutated directly by key events. `frame.down` is
   * no longer written here: it is republished from this array every `poll()`
   * and then OR-combined with the gamepad's own down state, so a released
   * gamepad button cannot leave a bit stuck when the keyboard never touched
   * that action (a plain "OR into the shared frame array and never clear"
   * merge would do exactly that).
   */
  private readonly keyboardDown = new Uint8Array(INPUT_ACTION_COUNT);
  private readonly bindingTable: BindingTable;
  private readonly keyboardTarget: InputKeyboardTarget;
  private readonly pointerLock: PointerLockSurface | null;
  private readonly gamepad: GamepadSource | null;
  private readonly isTextEntryActive: () => boolean;
  private readonly onPauseRequested: (() => void) | null;
  private readonly lookRadPerPixel: number;
  private pendingLookYawRad = 0;
  private pendingLookPitchRad = 0;
  private throttle = 0;
  private throttleHoldDirection = 0;
  private throttleHoldSec = 0;
  private throttleHoldOrigin = 0;
  private lockReleaseRequested = false;
  private disposed = false;

  private readonly handleKeyDown = (event: InputKeyboardEvent): void => {
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    // Shift is deliberately absent: v1 bailed on it and disabled all flight input.
    if (blocksGameKey(event)) return;
    if (event.code === ESCAPE_CODE) {
      this.requestPause();
      return;
    }
    const action = this.bindingTable.resolve(event.code);
    if (action === undefined) return;
    const index = actionIndex(action);
    if (index < 0) return;
    event.preventDefault();
    this.keyboardDown[index] = 1;
    const count = this.pendingEdges[index] ?? 0;
    if (count < MAX_EDGE_COUNT) this.pendingEdges[index] = count + 1;
  };

  private readonly handleKeyUp = (event: InputKeyboardEvent): void => {
    // Never gated on focus or modifiers: a key released over a focused button
    // must still clear, or the axis sticks until the next press.
    const action = this.bindingTable.resolve(event.code);
    if (action === undefined) return;
    const index = actionIndex(action);
    if (index < 0 || this.keyboardDown[index] === 0) return;
    this.keyboardDown[index] = 0;
    event.preventDefault();
  };

  private readonly handleBlur = (): void => {
    this.releaseHeldKeys();
  };

  private readonly handleMotion = (event: InputPointerMotionEvent): void => {
    if (this.pointerLock === null || !this.pointerLock.isLocked()) return;
    this.pendingLookYawRad += event.movementX * this.lookRadPerPixel;
    this.pendingLookPitchRad -= event.movementY * this.lookRadPerPixel;
  };

  private readonly handleLockChange = (): void => {
    if (this.pointerLock === null || this.pointerLock.isLocked()) return;
    this.pendingLookYawRad = 0;
    this.pendingLookPitchRad = 0;
    // Browsers swallow the Escape keydown that exits pointer lock, so an
    // unrequested release is the signal that the player wants out. Alt-tab and
    // window blur land here too, which is the behavior a game wants anyway.
    if (this.lockReleaseRequested) {
      this.lockReleaseRequested = false;
      return;
    }
    this.onPauseRequested?.();
  };

  constructor(options: InputEngineOptions) {
    this.keyboardTarget = options.keyboardTarget;
    this.bindingTable = new BindingTable(options.bindings);
    this.pointerLock = options.pointerLock ?? null;
    this.gamepad = options.gamepad ?? null;
    this.isTextEntryActive = options.isTextEntryActive ?? (() => false);
    this.onPauseRequested = options.onPauseRequested ?? null;
    this.lookRadPerPixel = options.lookRadPerPixel ?? DEFAULT_LOOK_RAD_PER_PIXEL;
    this.keyboardTarget.addEventListener('keydown', this.handleKeyDown);
    this.keyboardTarget.addEventListener('keyup', this.handleKeyUp);
    this.keyboardTarget.addEventListener('blur', this.handleBlur);
    this.pointerLock?.onMotion(this.handleMotion);
    this.pointerLock?.onLockChange(this.handleLockChange);
  }

  get pointerLocked(): boolean {
    return this.pointerLock?.isLocked() ?? false;
  }

  /** Publishes one frame of intent. Allocation-free; returns the same object every call. */
  poll(wallDtSec: number): InputFrame {
    const frame = this.frame;
    frame.down.set(this.keyboardDown);
    frame.edges.set(this.pendingEdges);
    this.pendingEdges.fill(0);
    frame.lookYawRad = this.pendingLookYawRad;
    frame.lookPitchRad = this.pendingLookPitchRad;
    this.pendingLookYawRad = 0;
    this.pendingLookPitchRad = 0;
    frame.axes.pitch = this.axisValue('pitchUp', 'pitchDown');
    frame.axes.yaw = this.axisValue('yawRight', 'yawLeft');
    frame.axes.roll = this.axisValue('rollRight', 'rollLeft');
    frame.axes.throttle = this.integrateThrottle(frame, wallDtSec);
    this.pollGamepad(frame);
    return frame;
  }

  applyBindings(bindings: InputBindings): void {
    this.bindingTable.rebuild(bindings);
  }

  /** Applies new deadzone/curve/invert/sensitivity calibration to the gamepad, if one is wired. */
  applyGamepadSettings(settings: GamepadSettings): void {
    this.gamepad?.applySettings(settings);
  }

  /**
   * Clears every held key and every queued press edge.
   *
   * The edges must go too: a press latched just before a blur or a rebind would
   * otherwise fire on the next poll and steal a warp rung or an attitude mode.
   */
  releaseHeldKeys(): void {
    this.keyboardDown.fill(0);
    this.frame.down.fill(0);
    this.pendingEdges.fill(0);
  }

  /** Seeds the analog lever, e.g. from a restored snapshot. */
  setThrottleAxis(value01: number): void {
    if (!Number.isFinite(value01)) throw new RangeError('throttle axis must be finite');
    this.throttle = clamp01(value01);
    this.frame.axes.throttle = this.throttle;
    // Re-anchor any hold in progress so the next poll sweeps from the seeded value.
    this.throttleHoldDirection = 0;
    this.throttleHoldSec = 0;
    this.throttleHoldOrigin = this.throttle;
  }

  requestPointerLock(): void {
    this.lockReleaseRequested = false;
    this.pointerLock?.requestLock();
  }

  releasePointerLock(): void {
    if (this.pointerLock === null || !this.pointerLock.isLocked()) return;
    this.lockReleaseRequested = true;
    this.pointerLock.releaseLock();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseHeldKeys();
    this.keyboardTarget.removeEventListener('keydown', this.handleKeyDown);
    this.keyboardTarget.removeEventListener('keyup', this.handleKeyUp);
    this.keyboardTarget.removeEventListener('blur', this.handleBlur);
    this.pointerLock?.dispose();
    this.gamepad?.dispose();
  }

  private requestPause(): void {
    this.releasePointerLock();
    this.onPauseRequested?.();
  }

  private axisValue(positive: InputAction, negative: InputAction): number {
    const positiveIndex = actionIndex(positive);
    const negativeIndex = actionIndex(negative);
    return (this.keyboardDown[positiveIndex] ?? 0) - (this.keyboardDown[negativeIndex] ?? 0);
  }

  /**
   * Merges gamepad state into the frame keyboard already populated.
   *
   * Always polls the device (when one is wired) so its own edge-tracking
   * ("was this button already down") stays correct across a text-entry
   * excursion — otherwise a button held throughout a form fill-in would
   * report a false press the moment focus returns. Only the *merge* into the
   * frame is skipped while disconnected or while a text field is focused, so
   * a connected-but-unused pad can never fight the keyboard and never steals
   * input from a focused control (docs/accessibility.md).
   */
  private pollGamepad(frame: MutableInputFrame): void {
    const gamepad = this.gamepad;
    if (gamepad === null) return;
    gamepad.poll();
    if (!gamepad.connected || this.isTextEntryActive()) return;
    frame.axes.pitch = clampAxis(frame.axes.pitch + gamepad.pitchAxis);
    frame.axes.yaw = clampAxis(frame.axes.yaw + gamepad.yawAxis);
    frame.axes.roll = clampAxis(frame.axes.roll + gamepad.rollAxis);
    // The trigger pair is an absolute position, not a rate: it sets the lever
    // directly (and re-anchors the keyboard ramp) rather than participating
    // in integrateThrottle's hold-and-sweep model. See gamepad-design.md.
    if (gamepad.throttleActive) this.setThrottleAxis(gamepad.throttleValue);
    gamepad.mergeButtonsInto(frame.down, frame.edges);
  }

  /**
   * Advances the analog lever.
   *
   * A hold is measured cumulatively from where it started, and its swept
   * distance is `max(TAP_STEP, RAMP · heldSec)`. That makes the two documented
   * guarantees exact and mutually consistent: any press moves the lever at least
   * 10%, and a hold from rest reaches full travel at exactly
   * `THROTTLE_FULL_SWEEP_SEC`. Adding the tap step to the ramp instead (the
   * first implementation) made a hold from rest finish in 1.35 s, and applying
   * the tap step only to sub-frame presses made a slightly longer press move the
   * lever *less*. Cumulative sweep is monotonic in hold duration.
   */
  private integrateThrottle(frame: MutableInputFrame, wallDtSec: number): number {
    const direction = this.axisValue('throttleIncrease', 'throttleDecrease');
    if (direction !== this.throttleHoldDirection) {
      this.throttleHoldDirection = direction;
      this.throttleHoldSec = 0;
      this.throttleHoldOrigin = this.throttle;
    }
    if (direction !== 0) {
      const dtSec = Number.isFinite(wallDtSec) && wallDtSec > 0 ? wallDtSec : 0;
      this.throttleHoldSec += dtSec;
      const sweep = Math.max(THROTTLE_TAP_STEP, THROTTLE_RAMP_PER_SEC * this.throttleHoldSec);
      this.throttle = clamp01(this.throttleHoldOrigin + direction * sweep);
      return this.throttle;
    }
    // No key down at poll time: a press that opened and closed between two polls
    // still counts as a tap.
    const taps = frame.pressCount('throttleIncrease') - frame.pressCount('throttleDecrease');
    if (taps !== 0) this.throttle = clamp01(this.throttle + taps * THROTTLE_TAP_STEP);
    return this.throttle;
  }
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

function clampAxis(value: number): number {
  if (value > 1) return 1;
  return value < -1 ? -1 : value;
}
