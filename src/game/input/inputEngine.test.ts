import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_GAME_SETTINGS, DEFAULT_GAMEPAD_SETTINGS, rebindInput } from '../settings.js';
import {
  GamepadPoller,
  shapeGamepadAxis,
  type GamepadButtonLike,
  type GamepadHost,
  type GamepadLike,
} from './gamepad.js';
import {
  DEFAULT_LOOK_RAD_PER_PIXEL,
  InputEngine,
  THROTTLE_FULL_SWEEP_SEC,
  THROTTLE_TAP_STEP,
  type InputBlurListener,
  type InputKeyboardEvent,
  type InputKeyboardListener,
  type InputPointerMotionEvent,
  type PointerLockSurface,
} from './inputEngine.js';

class FakeKeyboardTarget {
  private readonly keyDown: InputKeyboardListener[] = [];
  private readonly keyUp: InputKeyboardListener[] = [];
  private readonly blur: InputBlurListener[] = [];

  addEventListener(type: 'keydown' | 'keyup', listener: InputKeyboardListener): void;
  addEventListener(type: 'blur', listener: InputBlurListener): void;
  addEventListener(
    type: 'keydown' | 'keyup' | 'blur',
    listener: InputKeyboardListener | InputBlurListener,
  ): void {
    if (type === 'blur') this.blur.push(listener as InputBlurListener);
    else if (type === 'keydown') this.keyDown.push(listener as InputKeyboardListener);
    else this.keyUp.push(listener as InputKeyboardListener);
  }

  removeEventListener(type: 'keydown' | 'keyup', listener: InputKeyboardListener): void;
  removeEventListener(type: 'blur', listener: InputBlurListener): void;
  removeEventListener(
    type: 'keydown' | 'keyup' | 'blur',
    listener: InputKeyboardListener | InputBlurListener,
  ): void {
    const listeners: Array<InputKeyboardListener | InputBlurListener> =
      type === 'blur' ? this.blur : type === 'keydown' ? this.keyDown : this.keyUp;
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  }

  get listenerCount(): number {
    return this.keyDown.length + this.keyUp.length + this.blur.length;
  }

  press(code: string, options: Partial<InputKeyboardEvent> = {}): { readonly prevented: boolean } {
    return this.emit(this.keyDown, code, options);
  }

  release(
    code: string,
    options: Partial<InputKeyboardEvent> = {},
  ): { readonly prevented: boolean } {
    return this.emit(this.keyUp, code, options);
  }

  blurWindow(): void {
    for (const listener of this.blur) listener();
  }

  private emit(
    listeners: readonly InputKeyboardListener[],
    code: string,
    options: Partial<InputKeyboardEvent>,
  ): { readonly prevented: boolean } {
    let prevented = false;
    const event: InputKeyboardEvent = {
      altKey: false,
      code,
      ctrlKey: false,
      defaultPrevented: false,
      metaKey: false,
      repeat: false,
      shiftKey: false,
      target: null,
      preventDefault: () => {
        prevented = true;
      },
      ...options,
    };
    for (const listener of listeners) listener(event);
    return { prevented };
  }
}

class FakePointerLock implements PointerLockSurface {
  locked = false;
  requestCount = 0;
  releaseCount = 0;
  disposeCount = 0;
  private motion: ((event: InputPointerMotionEvent) => void) | null = null;
  private lockChange: (() => void) | null = null;

  isLocked(): boolean {
    return this.locked;
  }

  requestLock(): void {
    this.requestCount += 1;
    this.locked = true;
    this.lockChange?.();
  }

  releaseLock(): void {
    this.releaseCount += 1;
    this.locked = false;
    this.lockChange?.();
  }

  /** Lock loss the engine did not ask for: Escape while locked, alt-tab, blur. */
  loseLock(): void {
    this.locked = false;
    this.lockChange?.();
  }

  onMotion(listener: (event: InputPointerMotionEvent) => void): void {
    this.motion = listener;
  }

  onLockChange(listener: () => void): void {
    this.lockChange = listener;
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  move(movementX: number, movementY: number): void {
    this.motion?.({ movementX, movementY });
  }
}

/** Same deep-clone requirement as `gamepad.test.ts`'s `clonePad` — see that file's doc comment. */
function clonePad(pad: GamepadLike): GamepadLike {
  return {
    connected: pad.connected,
    mapping: pad.mapping,
    axes: [...pad.axes],
    buttons: pad.buttons.map((button) => ({ pressed: button.pressed, value: button.value })),
  };
}

/**
 * Minimal fake of the real `navigator.getGamepads()` + connect/disconnect
 * events. Every call returns a fresh top-level array *and* a fresh cloned pad
 * (fresh `axes`/`buttons` too) so a caching shortcut in `InputEngine`'s merge
 * path can't accidentally read a stale-but-still-correct reference.
 */
class FakeGamepadHost implements GamepadHost {
  private readonly slots = new Map<number, GamepadLike>();
  private readonly connectedListeners: (() => void)[] = [];
  private readonly disconnectedListeners: (() => void)[] = [];

  getGamepads(): readonly (GamepadLike | null)[] {
    const highestIndex = Math.max(-1, ...this.slots.keys());
    const snapshot: (GamepadLike | null)[] = [];
    for (let index = 0; index <= highestIndex; index += 1) {
      const pad = this.slots.get(index);
      snapshot.push(pad === undefined ? null : clonePad(pad));
    }
    return snapshot; // a fresh array every call, faithful to the real API
  }

  addEventListener(type: 'gamepadconnected' | 'gamepaddisconnected', listener: () => void): void {
    (type === 'gamepadconnected' ? this.connectedListeners : this.disconnectedListeners).push(
      listener,
    );
  }

  removeEventListener(
    type: 'gamepadconnected' | 'gamepaddisconnected',
    listener: () => void,
  ): void {
    const list = type === 'gamepadconnected' ? this.connectedListeners : this.disconnectedListeners;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  connect(index: number, pad: GamepadLike): void {
    this.slots.set(index, pad);
    for (const listener of [...this.connectedListeners]) listener();
  }

  update(index: number, pad: GamepadLike): void {
    this.slots.set(index, pad);
  }

  disconnect(index: number): void {
    this.slots.delete(index);
    for (const listener of [...this.disconnectedListeners]) listener();
  }

  get listenerCount(): number {
    return this.connectedListeners.length + this.disconnectedListeners.length;
  }
}

function standardPad(
  overrides: {
    readonly axes?: readonly [number, number, number, number];
    readonly buttons?: Readonly<Record<number, Partial<GamepadButtonLike>>>;
  } = {},
): GamepadLike {
  const buttons: GamepadButtonLike[] = Array.from({ length: 17 }, () => ({
    pressed: false,
    value: 0,
  }));
  for (const [index, patch] of Object.entries(overrides.buttons ?? {})) {
    const existing = buttons[Number(index)];
    if (existing !== undefined) buttons[Number(index)] = { ...existing, ...patch };
  }
  return { connected: true, mapping: 'standard', axes: overrides.axes ?? [0, 0, 0, 0], buttons };
}

function createEngine(
  overrides: {
    readonly onPauseRequested?: () => void;
    readonly gamepad?: GamepadPoller;
    readonly isTextEntryActive?: () => boolean;
  } = {},
) {
  const keyboard = new FakeKeyboardTarget();
  const pointerLock = new FakePointerLock();
  const engine = new InputEngine({
    bindings: DEFAULT_GAME_SETTINGS.inputBindings,
    keyboardTarget: keyboard,
    pointerLock,
    ...overrides,
  });
  return { engine, keyboard, pointerLock };
}

function createEngineWithGamepad(
  isTextEntryActive?: () => boolean,
): ReturnType<typeof createEngine> & { readonly gamepadHost: FakeGamepadHost } {
  const gamepadHost = new FakeGamepadHost();
  const gamepad = new GamepadPoller(gamepadHost, DEFAULT_GAMEPAD_SETTINGS);
  return { ...createEngine({ gamepad, isTextEntryActive }), gamepadHost };
}

const BUTTON_TARGET = { isContentEditable: false, tagName: 'BUTTON' } as unknown as EventTarget;
const INPUT_TARGET = { isContentEditable: false, tagName: 'INPUT' } as unknown as EventTarget;
const SUMMARY_TARGET = { isContentEditable: false, tagName: 'SUMMARY' } as unknown as EventTarget;
const CANVAS_TARGET = { isContentEditable: false, tagName: 'CANVAS' } as unknown as EventTarget;

describe('InputEngine — v1 defect regressions', () => {
  it('still pitches while Shift is held', () => {
    const { engine, keyboard } = createEngine();

    expect(keyboard.press('KeyW', { shiftKey: true }).prevented).toBe(true);

    expect(engine.poll(1 / 60).axes.pitch).toBe(1);
  });

  it('still pitches while a HUD button has focus', () => {
    const { engine, keyboard } = createEngine();

    expect(keyboard.press('KeyW', { target: BUTTON_TARGET }).prevented).toBe(true);

    expect(engine.poll(1 / 60).axes.pitch).toBe(1);
  });

  it('keeps every flight action live with Shift held and a button focused', () => {
    const { engine, keyboard } = createEngine();
    const options = { shiftKey: true, target: BUTTON_TARGET };

    keyboard.press('KeyS', options);
    keyboard.press('KeyA', options);
    keyboard.press('KeyC', options);
    keyboard.press('KeyR', options);
    keyboard.press('Equal', options);
    keyboard.press('Digit2', options);
    const frame = engine.poll(1 / 60);

    expect(frame.axes.pitch).toBe(-1);
    expect(frame.axes.yaw).toBe(-1);
    expect(frame.axes.roll).toBe(1);
    expect(frame.axes.throttle).toBeCloseTo(THROTTLE_TAP_STEP, 12);
    expect(frame.pressed('warpIncrease')).toBe(true);
    expect(frame.pressed('attitudePrograde')).toBe(true);
  });
});

describe('InputEngine — focus policy', () => {
  it('ignores keys typed into editable targets and keys another control consumed', () => {
    const { engine, keyboard } = createEngine();

    expect(keyboard.press('KeyW', { target: INPUT_TARGET }).prevented).toBe(false);
    expect(
      keyboard.press('KeyS', { defaultPrevented: true, target: BUTTON_TARGET }).prevented,
    ).toBe(false);
    expect(keyboard.press('KeyR', { repeat: true }).prevented).toBe(false);
    expect(keyboard.press('KeyR', { ctrlKey: true }).prevented).toBe(false);
    expect(keyboard.press('KeyR', { altKey: true }).prevented).toBe(false);
    expect(keyboard.press('KeyR', { metaKey: true }).prevented).toBe(false);

    const frame = engine.poll(1 / 60);
    expect(frame.axes.pitch).toBe(0);
    expect(frame.axes.throttle).toBe(0);
  });

  it('leaves Space and Enter to a focused button so HUD controls stay operable', () => {
    const { engine, keyboard } = createEngine();
    engine.applyBindings({
      ...DEFAULT_GAME_SETTINGS.inputBindings,
      throttleIncrease: 'Space',
      warpIncrease: 'Enter',
    });

    // A bubble-phase preventDefault would cancel the button's activation.
    expect(keyboard.press('Space', { target: BUTTON_TARGET }).prevented).toBe(false);
    expect(keyboard.press('Enter', { target: BUTTON_TARGET }).prevented).toBe(false);
    expect(keyboard.press('Space', { target: SUMMARY_TARGET }).prevented).toBe(false);

    const blocked = engine.poll(1 / 60);
    expect(blocked.axes.throttle).toBe(0);
    expect(blocked.pressed('warpIncrease')).toBe(false);

    // The same bindings must still fly the ship when no activatable control has focus.
    expect(keyboard.press('Space', { target: CANVAS_TARGET }).prevented).toBe(true);
    expect(keyboard.press('Enter', { target: null }).prevented).toBe(true);

    const live = engine.poll(1 / 60);
    expect(live.axes.throttle).toBeCloseTo(THROTTLE_TAP_STEP, 12);
    expect(live.pressed('warpIncrease')).toBe(true);
  });

  it('still flies every non-activation key while a button has focus', () => {
    const { engine, keyboard } = createEngine();
    engine.applyBindings({
      ...DEFAULT_GAME_SETTINGS.inputBindings,
      throttleIncrease: 'Space',
    });

    expect(keyboard.press('KeyW', { target: BUTTON_TARGET }).prevented).toBe(true);

    expect(engine.poll(1 / 60).axes.pitch).toBe(1);
  });

  it('releases a held axis on keyup even when focus moved to a button', () => {
    const { engine, keyboard } = createEngine();
    keyboard.press('KeyW');
    expect(engine.poll(1 / 60).axes.pitch).toBe(1);

    expect(keyboard.release('KeyW', { target: BUTTON_TARGET, shiftKey: true }).prevented).toBe(
      true,
    );

    expect(engine.poll(1 / 60).axes.pitch).toBe(0);
  });

  it('releases every held key when the window loses focus', () => {
    const { engine, keyboard } = createEngine();
    keyboard.press('KeyW');
    keyboard.press('KeyD');
    expect(engine.poll(1 / 60).axes.yaw).toBe(1);

    keyboard.blurWindow();

    const frame = engine.poll(1 / 60);
    expect(frame.axes.pitch).toBe(0);
    expect(frame.axes.yaw).toBe(0);
  });

  it('drops a press edge that was queued when focus or bindings changed', () => {
    const { engine, keyboard } = createEngine();

    // Latched but never polled: a blur must not let it fire a warp rung later.
    keyboard.press('Equal');
    keyboard.blurWindow();
    expect(engine.poll(1 / 60).pressed('warpIncrease')).toBe(false);

    keyboard.press('Digit2');
    engine.releaseHeldKeys();
    expect(engine.poll(1 / 60).pressed('attitudePrograde')).toBe(false);
  });
});

describe('InputEngine — edges and axes', () => {
  it('reports an edge for exactly one poll and keeps the level for the whole hold', () => {
    const { engine, keyboard } = createEngine();
    keyboard.press('Digit2');

    const first = engine.poll(1 / 60);
    expect(first.pressed('attitudePrograde')).toBe(true);
    expect(first.held('attitudePrograde')).toBe(true);

    const second = engine.poll(1 / 60);
    expect(second.pressed('attitudePrograde')).toBe(false);
    expect(second.held('attitudePrograde')).toBe(true);
  });

  it('counts repeated presses that land between two polls', () => {
    const { engine, keyboard } = createEngine();
    keyboard.press('Equal');
    keyboard.release('Equal');
    keyboard.press('Equal');
    keyboard.release('Equal');

    expect(engine.poll(1 / 60).pressCount('warpIncrease')).toBe(2);
    expect(engine.poll(1 / 60).pressCount('warpIncrease')).toBe(0);
  });

  it('cancels opposing axis keys and uses the documented sign convention', () => {
    const { engine, keyboard } = createEngine();
    keyboard.press('KeyW');
    keyboard.press('KeyS');
    keyboard.press('KeyD');
    keyboard.press('KeyC');

    const frame = engine.poll(1 / 60);
    expect(frame.axes.pitch).toBe(0);
    expect(frame.axes.yaw).toBe(1);
    expect(frame.axes.roll).toBe(1);
  });

  it('routes input to the rebound code and stops routing the old one', () => {
    const { engine, keyboard } = createEngine();
    engine.applyBindings(rebindInput(DEFAULT_GAME_SETTINGS, 'pitchUp', 'KeyI').inputBindings);

    expect(keyboard.press('KeyW').prevented).toBe(false);
    expect(keyboard.press('KeyI').prevented).toBe(true);

    expect(engine.poll(1 / 60).axes.pitch).toBe(1);
  });
});

describe('InputEngine — analog throttle', () => {
  it('sweeps from rest to full in exactly 1.5 s of hold, and back down in 1.5 s', () => {
    const { engine, keyboard } = createEngine();
    const stepSec = 1 / 120;
    const stepsPerSweep = Math.round(THROTTLE_FULL_SWEEP_SEC / stepSec);

    // No zeroing and no head start: this measures what docs/controls.md claims.
    keyboard.press('KeyR');
    for (let step = 0; step < stepsPerSweep - 1; step += 1) engine.poll(stepSec);
    expect(engine.poll(0).axes.throttle).toBeLessThan(1);
    expect(engine.poll(stepSec).axes.throttle).toBeCloseTo(1, 9);

    keyboard.release('KeyR');
    keyboard.press('KeyF');
    for (let step = 0; step < stepsPerSweep - 1; step += 1) engine.poll(stepSec);
    expect(engine.poll(0).axes.throttle).toBeGreaterThan(0);
    expect(engine.poll(stepSec).axes.throttle).toBe(0);
  });

  it('never moves the lever backwards as a press gets longer', () => {
    const { engine, keyboard } = createEngine();
    const samples: number[] = [];
    keyboard.press('KeyR');
    for (let step = 0; step < 120; step += 1) samples.push(engine.poll(1 / 240).axes.throttle);

    expect(samples[0]).toBeCloseTo(THROTTLE_TAP_STEP, 12);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeGreaterThanOrEqual(samples[index - 1] as number);
    }
    expect(samples.at(-1)).toBeGreaterThan(THROTTLE_TAP_STEP);
  });

  it('nudges by a tap step when press and release land between two polls', () => {
    const { engine, keyboard } = createEngine();
    keyboard.press('KeyR');
    keyboard.release('KeyR');
    expect(engine.poll(1 / 60).axes.throttle).toBeCloseTo(THROTTLE_TAP_STEP, 12);

    keyboard.press('KeyF');
    keyboard.release('KeyF');
    expect(engine.poll(1 / 60).axes.throttle).toBe(0);
  });

  it('clamps to [0, 1] and cancels opposing throttle keys', () => {
    const { engine, keyboard } = createEngine();
    keyboard.press('KeyF');
    expect(engine.poll(1).axes.throttle).toBe(0);

    engine.setThrottleAxis(0.5);
    keyboard.release('KeyF');
    keyboard.press('KeyR');
    keyboard.press('KeyF');
    expect(engine.poll(1).axes.throttle).toBe(0.5);

    keyboard.release('KeyF');
    expect(engine.poll(10).axes.throttle).toBe(1);
  });

  it('seeds the lever from a restored value and rejects a non-finite seed', () => {
    const { engine } = createEngine();
    engine.setThrottleAxis(0.42);

    expect(engine.poll(1 / 60).axes.throttle).toBe(0.42);
    expect(() => engine.setThrottleAxis(Number.NaN)).toThrow(RangeError);
  });
});

describe('InputEngine — pointer lock', () => {
  it('accumulates scaled wall-frame look deltas and drains them once per poll', () => {
    const { engine, pointerLock } = createEngine();
    engine.requestPointerLock();
    expect(engine.pointerLocked).toBe(true);

    pointerLock.move(10, -4);
    pointerLock.move(5, 2);

    const frame = engine.poll(1 / 60);
    expect(frame.lookYawRad).toBeCloseTo(15 * DEFAULT_LOOK_RAD_PER_PIXEL, 12);
    expect(frame.lookPitchRad).toBeCloseTo(2 * DEFAULT_LOOK_RAD_PER_PIXEL, 12);

    const drained = engine.poll(1 / 60);
    expect(drained.lookYawRad).toBe(0);
    expect(drained.lookPitchRad).toBe(0);
  });

  it('ignores motion while unlocked and discards pending deltas on lock loss', () => {
    const { engine, pointerLock } = createEngine();
    pointerLock.move(100, 100);
    expect(engine.poll(1 / 60).lookYawRad).toBe(0);

    engine.requestPointerLock();
    pointerLock.move(100, 100);
    pointerLock.loseLock();

    expect(engine.poll(1 / 60).lookYawRad).toBe(0);
  });

  it('raises the pause intent on an unrequested lock loss but not on a requested release', () => {
    const onPauseRequested = vi.fn();
    const { engine, pointerLock } = createEngine({ onPauseRequested });

    engine.requestPointerLock();
    engine.releasePointerLock();
    expect(onPauseRequested).not.toHaveBeenCalled();
    expect(pointerLock.releaseCount).toBe(1);

    engine.requestPointerLock();
    pointerLock.loseLock();
    expect(onPauseRequested).toHaveBeenCalledTimes(1);
  });

  it('raises the pause intent once when Escape arrives while locked', () => {
    const onPauseRequested = vi.fn();
    const { engine, keyboard, pointerLock } = createEngine({ onPauseRequested });
    engine.requestPointerLock();

    expect(keyboard.press('Escape').prevented).toBe(false);

    expect(onPauseRequested).toHaveBeenCalledTimes(1);
    expect(pointerLock.isLocked()).toBe(false);
  });

  it('raises the pause intent from an unlocked Escape but never from a text field', () => {
    const onPauseRequested = vi.fn();
    const { keyboard } = createEngine({ onPauseRequested });

    keyboard.press('Escape');
    expect(onPauseRequested).toHaveBeenCalledTimes(1);

    keyboard.press('Escape', { target: INPUT_TARGET });
    keyboard.press('Escape', { defaultPrevented: true, target: BUTTON_TARGET });
    expect(onPauseRequested).toHaveBeenCalledTimes(1);
  });
});

describe('InputEngine — frame identity and disposal', () => {
  it('returns one reused frame object and one reused axes object', () => {
    const { engine } = createEngine();
    const first = engine.poll(1 / 60);
    const second = engine.poll(1 / 60);

    expect(second).toBe(first);
    expect(second.axes).toBe(first.axes);
  });

  it('removes every listener and releases held keys on dispose', () => {
    const { engine, keyboard, pointerLock } = createEngine();
    keyboard.press('KeyW');

    engine.dispose();
    engine.dispose();

    expect(keyboard.listenerCount).toBe(0);
    expect(pointerLock.disposeCount).toBe(1);
    expect(engine.poll(1 / 60).axes.pitch).toBe(0);
  });
});

describe('InputEngine — gamepad integration (T0106)', () => {
  it('sums a connected stick with simultaneous keyboard input, each clamped to [-1, 1]', () => {
    const { engine, keyboard, gamepadHost } = createEngineWithGamepad();
    gamepadHost.connect(0, standardPad({ axes: [1, 0, 0, 0] })); // full yaw right
    keyboard.press('KeyD'); // yawRight, also +1

    const frame = engine.poll(1 / 60);

    expect(frame.axes.yaw).toBe(1); // 1 + 1 clamped, not 2
  });

  it('a connected-but-centered pad never fights a keyboard-only player', () => {
    const { engine, keyboard, gamepadHost } = createEngineWithGamepad();
    gamepadHost.connect(0, standardPad());
    keyboard.press('KeyW');

    expect(engine.poll(1 / 60).axes.pitch).toBe(1);
  });

  it('the right trigger sets the throttle lever directly, and keyboard resumes from there', () => {
    const { engine, keyboard, gamepadHost } = createEngineWithGamepad();
    const triggerValue = 0.6;
    // Trusts the pure function's own exhaustive coverage (gamepad.test.ts);
    // this test is about the wiring, not re-deriving the deadzone/curve math.
    const expectedLever = Math.max(
      0,
      shapeGamepadAxis(
        triggerValue,
        DEFAULT_GAMEPAD_SETTINGS.deadzone,
        DEFAULT_GAMEPAD_SETTINGS.curveExponent,
        DEFAULT_GAMEPAD_SETTINGS.axes.throttle,
      ),
    );
    gamepadHost.connect(0, standardPad({ buttons: { 7: { value: triggerValue, pressed: true } } }));

    expect(engine.poll(1 / 60).axes.throttle).toBeCloseTo(expectedLever, 12);

    // Release the trigger: the lever holds (does not snap to 0) because
    // nothing is actively deflected this frame.
    gamepadHost.update(0, standardPad());
    expect(engine.poll(1 / 60).axes.throttle).toBeCloseTo(expectedLever, 12);

    // Keyboard resumes the ramp from the trigger-set position, not from 0.
    keyboard.press('KeyR');
    const afterTap = engine.poll(1 / 60);
    expect(afterTap.axes.throttle).toBeCloseTo(expectedLever + THROTTLE_TAP_STEP, 9);
  });

  it('trigger and keyboard throttle held simultaneously: the trigger wins every frame, deterministically', () => {
    const { engine, keyboard, gamepadHost } = createEngineWithGamepad();
    const triggerValue = 0.6;
    const expectedLever = Math.max(
      0,
      shapeGamepadAxis(
        triggerValue,
        DEFAULT_GAMEPAD_SETTINGS.deadzone,
        DEFAULT_GAMEPAD_SETTINGS.curveExponent,
        DEFAULT_GAMEPAD_SETTINGS.axes.throttle,
      ),
    );
    gamepadHost.connect(0, standardPad({ buttons: { 7: { value: triggerValue, pressed: true } } }));
    keyboard.press('KeyR'); // throttleIncrease, held for the whole scenario

    // Both sources are active every frame for 30 frames (0.5 s): the lever
    // must sit exactly at the trigger's shaped value every single frame —
    // never drifting toward the keyboard ramp's ceiling of 1, never
    // oscillating between the two. pollGamepad() runs after the keyboard
    // ramp is computed and unconditionally overwrites axes.throttle while
    // throttleActive, so this is deterministic by construction, not by luck.
    for (let frame = 0; frame < 30; frame += 1) {
      const result = engine.poll(1 / 60);
      expect(result.axes.throttle).toBeCloseTo(expectedLever, 12);
    }
  });

  it('releasing the trigger while still holding the throttle key jumps by one tap step, not a resumed ramp', () => {
    // Documents a real, understood residual (see gamepad-design.md): holding
    // R and the trigger together re-anchors the keyboard ramp's hold origin
    // every single frame (setThrottleAxis always resets throttleHoldSec to
    // 0), so the first frame after the trigger releases always measures
    // exactly one frame's worth of held time. max(TAP_STEP, RAMP * oneFrameDt)
    // is TAP_STEP at any real frame rate, so the lever jumps by a discrete
    // 0.1 instead of continuing the smooth ramp a keyboard-only hold of the
    // same wall-clock duration would show. This is a one-frame artifact, not
    // a sustained glitch — pinned here so a future change to the re-anchor
    // logic is a deliberate decision, not an unnoticed regression either way.
    const { engine, keyboard, gamepadHost } = createEngineWithGamepad();
    const triggerValue = 0.6;
    const expectedLever = Math.max(
      0,
      shapeGamepadAxis(
        triggerValue,
        DEFAULT_GAMEPAD_SETTINGS.deadzone,
        DEFAULT_GAMEPAD_SETTINGS.curveExponent,
        DEFAULT_GAMEPAD_SETTINGS.axes.throttle,
      ),
    );
    gamepadHost.connect(0, standardPad({ buttons: { 7: { value: triggerValue, pressed: true } } }));
    keyboard.press('KeyR');
    engine.poll(1 / 60);
    engine.poll(1 / 60);
    expect(engine.poll(1 / 60).axes.throttle).toBeCloseTo(expectedLever, 12);

    gamepadHost.update(0, standardPad()); // release the trigger; KeyR stays held
    // Captured as a primitive immediately: `engine.poll()` returns the same
    // reused mutable frame every call (InputFrame's own contract), so holding
    // the frame object itself across the loop below and re-reading its
    // `.axes.throttle` later would silently observe the *latest* poll's
    // value instead of this one.
    const afterReleaseThrottle = engine.poll(1 / 60).axes.throttle;
    expect(afterReleaseThrottle).toBeCloseTo(expectedLever + THROTTLE_TAP_STEP, 9);

    // Not a sustained glitch: continuing to hold R resumes a normal monotonic
    // ramp from the jumped value — it never re-jumps and never reverses. The
    // ramp floors at TAP_STEP for a short hold regardless of source (the same
    // "never moves the lever backwards" property a keyboard-only press
    // already has — RAMP * heldSec does not exceed TAP_STEP until ~9 frames
    // at 60 Hz), then climbs past it.
    let last = afterReleaseThrottle;
    for (let frame = 0; frame < 30; frame += 1) {
      const value = engine.poll(1 / 60).axes.throttle;
      expect(value).toBeGreaterThanOrEqual(last);
      last = value;
    }
    expect(last).toBeGreaterThan(afterReleaseThrottle);
  });

  it('a text field in focus suppresses gamepad axes and buttons but not the keyboard', () => {
    let typing = true;
    const { engine, keyboard, gamepadHost } = createEngineWithGamepad(() => typing);
    // Pitch is gamepad-only (no keyboard pitch key pressed) so suppression is
    // observable; yaw is keyboard-only so it proves the gamepad gate never
    // touches keyboard input.
    gamepadHost.connect(0, standardPad({ axes: [0, -1, 0, 0], buttons: { 0: { pressed: true } } }));
    keyboard.press('KeyD'); // yawRight

    const whileTyping = engine.poll(1 / 60);
    expect(whileTyping.axes.pitch).toBe(0); // full gamepad deflection, still suppressed
    expect(whileTyping.axes.yaw).toBe(1); // keyboard's own input is never gated by this flag
    expect(whileTyping.pressed('cruiseEngage')).toBe(false);
    expect(whileTyping.held('cruiseEngage')).toBe(false);

    typing = false;
    const afterFocusReturns = engine.poll(1 / 60);
    expect(afterFocusReturns.axes.pitch).toBeCloseTo(1, 12);
    // The button was already held throughout the excursion: the poller kept
    // tracking it internally, so returning focus reports the level, not a
    // fresh press edge.
    expect(afterFocusReturns.pressed('cruiseEngage')).toBe(false);
    expect(afterFocusReturns.held('cruiseEngage')).toBe(true);
  });

  it('a disconnected gamepad cannot leave a button stuck held when the keyboard never touched it', () => {
    const { engine, gamepadHost } = createEngineWithGamepad();
    gamepadHost.connect(0, standardPad({ buttons: { 0: { pressed: true } } }));
    expect(engine.poll(1 / 60).held('cruiseEngage')).toBe(true);

    gamepadHost.disconnect(0);

    expect(engine.poll(1 / 60).held('cruiseEngage')).toBe(false);
  });

  it('A/B report a one-poll press edge mapped to cruiseEngage/cruiseAbort', () => {
    const { engine, gamepadHost } = createEngineWithGamepad();
    gamepadHost.connect(0, standardPad({ buttons: { 0: { pressed: true } } }));

    const first = engine.poll(1 / 60);
    expect(first.pressed('cruiseEngage')).toBe(true);
    expect(first.pressed('cruiseAbort')).toBe(false);

    const second = engine.poll(1 / 60);
    expect(second.pressed('cruiseEngage')).toBe(false);
    expect(second.held('cruiseEngage')).toBe(true);
  });

  it('applyGamepadSettings reaches the wired poller and changes shaping on the next poll', () => {
    const { engine, gamepadHost } = createEngineWithGamepad();
    gamepadHost.connect(0, standardPad({ axes: [1, 0, 0, 0] }));
    expect(engine.poll(1 / 60).axes.yaw).toBeCloseTo(1, 12);

    engine.applyGamepadSettings({
      ...DEFAULT_GAMEPAD_SETTINGS,
      axes: { ...DEFAULT_GAMEPAD_SETTINGS.axes, yaw: { invert: true, sensitivity: 1 } },
    });

    expect(engine.poll(1 / 60).axes.yaw).toBeCloseTo(-1, 12);
  });

  it('never calls getGamepads when no gamepad is wired at all', () => {
    const { engine, keyboard } = createEngine(); // no gamepad option at all
    keyboard.press('KeyW');

    expect(() => engine.poll(1 / 60)).not.toThrow();
    expect(engine.poll(1 / 60).axes.pitch).toBe(1);
  });

  it('dispose releases the gamepad poller too', () => {
    const { engine, gamepadHost } = createEngineWithGamepad();
    gamepadHost.connect(0, standardPad({ axes: [1, 0, 0, 0] }));
    engine.poll(1 / 60);
    expect(gamepadHost.listenerCount).toBe(2);

    engine.dispose();

    expect(gamepadHost.listenerCount).toBe(0);
  });
});
