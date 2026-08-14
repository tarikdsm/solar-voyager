import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_GAME_SETTINGS, rebindInput } from '../settings.js';
import {
  DEFAULT_LOOK_RAD_PER_PIXEL,
  InputEngine,
  THROTTLE_FULL_SWEEP_SEC,
  THROTTLE_RAMP_PER_SEC,
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

function createEngine(overrides: { readonly onPauseRequested?: () => void } = {}) {
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

const BUTTON_TARGET = { isContentEditable: false, tagName: 'BUTTON' } as unknown as EventTarget;
const INPUT_TARGET = { isContentEditable: false, tagName: 'INPUT' } as unknown as EventTarget;

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
    expect(frame.axes.throttle).toBeCloseTo(THROTTLE_TAP_STEP + THROTTLE_RAMP_PER_SEC / 60, 12);
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
  it('sweeps the full range in 1.5 s of held ramp', () => {
    const { engine, keyboard } = createEngine();
    keyboard.press('KeyR');
    // Consume the tap step first so the measurement is ramp-only.
    engine.poll(0);
    expect(engine.poll(0).axes.throttle).toBeCloseTo(THROTTLE_TAP_STEP, 12);
    engine.setThrottleAxis(0);

    let elapsedSec = 0;
    const stepSec = 1 / 120;
    while (elapsedSec < THROTTLE_FULL_SWEEP_SEC - stepSec / 2) {
      engine.poll(stepSec);
      elapsedSec += stepSec;
    }

    expect(engine.poll(0).axes.throttle).toBeCloseTo(1, 9);
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
