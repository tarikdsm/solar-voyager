import {
  BindingTable,
  INPUT_ACTION_COUNT,
  actionIndex,
  blocksGameKey,
  type InputAction,
  type InputBindings,
} from './bindings.js';

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
}

/**
 * Turns raw keyboard and pointer-lock events into one allocation-free
 * {@link InputFrame} per frame.
 *
 * Replaces v1's `KeyboardCommandMapper`. The engine never speaks to the
 * simulation: `game/input/inputCommandBridge.ts` does that today and T0108's
 * `FlightController` takes over.
 */
export class InputEngine {
  private readonly frame = new MutableInputFrame();
  private readonly pendingEdges = new Uint8Array(INPUT_ACTION_COUNT);
  private readonly bindingTable: BindingTable;
  private readonly keyboardTarget: InputKeyboardTarget;
  private readonly pointerLock: PointerLockSurface | null;
  private readonly onPauseRequested: (() => void) | null;
  private readonly lookRadPerPixel: number;
  private pendingLookYawRad = 0;
  private pendingLookPitchRad = 0;
  private throttle = 0;
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
    this.frame.down[index] = 1;
    const count = this.pendingEdges[index] ?? 0;
    if (count < MAX_EDGE_COUNT) this.pendingEdges[index] = count + 1;
  };

  private readonly handleKeyUp = (event: InputKeyboardEvent): void => {
    // Never gated on focus or modifiers: a key released over a focused button
    // must still clear, or the axis sticks until the next press.
    const action = this.bindingTable.resolve(event.code);
    if (action === undefined) return;
    const index = actionIndex(action);
    if (index < 0 || this.frame.down[index] === 0) return;
    this.frame.down[index] = 0;
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
    return frame;
  }

  applyBindings(bindings: InputBindings): void {
    this.bindingTable.rebuild(bindings);
  }

  /** Clears every held key without touching the throttle lever or look deltas. */
  releaseHeldKeys(): void {
    this.frame.down.fill(0);
  }

  /** Seeds the analog lever, e.g. from a restored snapshot. */
  setThrottleAxis(value01: number): void {
    if (!Number.isFinite(value01)) throw new RangeError('throttle axis must be finite');
    this.throttle = clamp01(value01);
    this.frame.axes.throttle = this.throttle;
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
  }

  private requestPause(): void {
    this.releasePointerLock();
    this.onPauseRequested?.();
  }

  private axisValue(positive: InputAction, negative: InputAction): number {
    const positiveIndex = actionIndex(positive);
    const negativeIndex = actionIndex(negative);
    return (this.frame.down[positiveIndex] ?? 0) - (this.frame.down[negativeIndex] ?? 0);
  }

  private integrateThrottle(frame: MutableInputFrame, wallDtSec: number): number {
    const tapSteps = frame.pressCount('throttleIncrease') - frame.pressCount('throttleDecrease');
    const rampDirection = this.axisValue('throttleIncrease', 'throttleDecrease');
    if (tapSteps === 0 && rampDirection === 0) return this.throttle;
    const dtSec = Number.isFinite(wallDtSec) && wallDtSec > 0 ? wallDtSec : 0;
    const delta = tapSteps * THROTTLE_TAP_STEP + rampDirection * THROTTLE_RAMP_PER_SEC * dtSec;
    this.throttle = clamp01(this.throttle + delta);
    return this.throttle;
  }
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  return value >= 1 ? 1 : value;
}
