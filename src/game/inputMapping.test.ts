import { describe, expect, it, vi } from 'vitest';

import { createCommandController } from '../sim/simulationSnapshot.js';
import {
  KeyboardCommandMapper,
  ROTATION_RATE_RAD_S,
  type KeyboardInputEvent,
} from './inputMapping.js';
import { DEFAULT_GAME_SETTINGS, rebindInput } from './settings.js';

type KeyboardListener = (event: KeyboardInputEvent) => void;

class FakeKeyboardTarget {
  private readonly keyDownListeners = new Set<KeyboardListener>();
  private readonly keyUpListeners = new Set<KeyboardListener>();

  addEventListener(type: 'keydown' | 'keyup', listener: KeyboardListener): void {
    (type === 'keydown' ? this.keyDownListeners : this.keyUpListeners).add(listener);
  }

  removeEventListener(type: 'keydown' | 'keyup', listener: KeyboardListener): void {
    (type === 'keydown' ? this.keyDownListeners : this.keyUpListeners).delete(listener);
  }

  keyDown(
    code: string,
    options: Partial<KeyboardInputEvent> = {},
  ): { readonly prevented: boolean } {
    return this.emit(this.keyDownListeners, code, options);
  }

  keyUp(code: string, options: Partial<KeyboardInputEvent> = {}): { readonly prevented: boolean } {
    return this.emit(this.keyUpListeners, code, options);
  }

  private emit(
    listeners: ReadonlySet<KeyboardListener>,
    code: string,
    options: Partial<KeyboardInputEvent>,
  ): { readonly prevented: boolean } {
    let prevented = false;
    const event: KeyboardInputEvent = {
      altKey: false,
      code,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
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

function createMapper(target: FakeKeyboardTarget) {
  const controller = createCommandController(['earth']);
  const mapper = new KeyboardCommandMapper(
    target,
    controller.commands,
    () => ({
      requestedWarp: controller.state.requestedWarp,
      throttle: controller.state.throttle,
    }),
    DEFAULT_GAME_SETTINGS.inputBindings,
  );
  return { controller, mapper };
}

describe('KeyboardCommandMapper', () => {
  it('maps edge-triggered throttle, warp, and attitude actions', () => {
    const target = new FakeKeyboardTarget();
    const { controller } = createMapper(target);

    expect(target.keyDown('KeyR').prevented).toBe(true);
    expect(controller.state.throttle).toBeCloseTo(0.1, 12);
    target.keyDown('KeyF');
    expect(controller.state.throttle).toBe(0);
    target.keyDown('Equal');
    expect(controller.state.requestedWarp).toBe(5);
    target.keyDown('Minus');
    expect(controller.state.requestedWarp).toBe(1);
    target.keyDown('Digit2');
    expect(controller.state.attitudeMode).toBe('prograde');
    target.keyDown('Digit3');
    expect(controller.state.attitudeMode).toBe('retrograde');
    target.keyDown('Digit1');
    expect(controller.state.attitudeMode).toBe('manual');
  });

  it('maps held axes to one allocation-free rotation update', () => {
    const target = new FakeKeyboardTarget();
    const { controller, mapper } = createMapper(target);

    target.keyDown('KeyW');
    target.keyDown('KeyD');
    target.keyDown('KeyZ');
    mapper.update();
    expect([...controller.state.rotationRatesRadS]).toEqual([
      ROTATION_RATE_RAD_S,
      ROTATION_RATE_RAD_S,
      -ROTATION_RATE_RAD_S,
    ]);
    target.keyUp('KeyW');
    target.keyUp('KeyD');
    target.keyUp('KeyZ');
    mapper.update();
    expect([...controller.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });

  it('does not dirty or consume an unchanged axis transition', () => {
    const target = new FakeKeyboardTarget();
    const commands = {
      rotate: vi.fn(),
      setAttitudeMode: vi.fn(),
      setTarget: vi.fn(),
      setThrottle: vi.fn(),
      setWarp: vi.fn(),
    };
    const mapper = new KeyboardCommandMapper(
      target,
      commands,
      () => ({ requestedWarp: 1, throttle: 0 }),
      DEFAULT_GAME_SETTINGS.inputBindings,
    );
    const button = { isContentEditable: false, tagName: 'BUTTON' } as unknown as EventTarget;

    expect(target.keyUp('KeyW', { target: button }).prevented).toBe(false);
    mapper.update();
    expect(commands.rotate).not.toHaveBeenCalled();

    target.keyDown('KeyW');
    mapper.update();
    expect(commands.rotate).toHaveBeenCalledTimes(1);
    target.keyDown('KeyW');
    mapper.update();
    expect(commands.rotate).toHaveBeenCalledTimes(1);
  });

  it('releases a held axis when focus moves to a button before keyup', () => {
    const target = new FakeKeyboardTarget();
    const { controller, mapper } = createMapper(target);
    const button = { isContentEditable: false, tagName: 'BUTTON' } as unknown as EventTarget;

    target.keyDown('KeyW');
    mapper.update();
    expect(controller.state.rotationRatesRadS[0]).toBe(ROTATION_RATE_RAD_S);

    expect(target.keyUp('KeyW', { target: button }).prevented).toBe(true);
    mapper.update();
    expect([...controller.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });

  it('ignores repeats, browser modifiers, and editable targets', () => {
    const target = new FakeKeyboardTarget();
    const { controller } = createMapper(target);

    expect(target.keyDown('KeyR', { repeat: true }).prevented).toBe(false);
    expect(target.keyDown('KeyR', { ctrlKey: true }).prevented).toBe(false);
    expect(
      target.keyDown('KeyR', {
        target: { isContentEditable: false, tagName: 'INPUT' } as unknown as EventTarget,
      }).prevented,
    ).toBe(false);
    expect(controller.state.throttle).toBe(0);
  });

  it('releases held axes when bindings change and routes later input to the new key', () => {
    const target = new FakeKeyboardTarget();
    const { controller, mapper } = createMapper(target);
    target.keyDown('KeyW');
    mapper.update();
    expect(controller.state.rotationRatesRadS[0]).toBe(ROTATION_RATE_RAD_S);

    const rebound = rebindInput(DEFAULT_GAME_SETTINGS, 'pitchUp', 'KeyI');
    mapper.updateBindings(rebound.inputBindings);
    mapper.update();
    expect([...controller.state.rotationRatesRadS]).toEqual([0, 0, 0]);
    expect(target.keyDown('KeyW').prevented).toBe(false);
    expect(target.keyDown('KeyI').prevented).toBe(true);
    mapper.update();
    expect(controller.state.rotationRatesRadS[0]).toBe(ROTATION_RATE_RAD_S);
  });

  it('can replace commands after a load and disposes listeners', () => {
    const target = new FakeKeyboardTarget();
    const { controller, mapper } = createMapper(target);
    const replacement = createCommandController(['earth']);

    mapper.updateCommands(replacement.commands, () => ({
      requestedWarp: replacement.state.requestedWarp,
      throttle: replacement.state.throttle,
    }));
    target.keyDown('Equal');
    expect(replacement.state.requestedWarp).toBe(5);
    expect(controller.state.requestedWarp).toBe(1);

    mapper.dispose();
    expect(target.keyDown('KeyR').prevented).toBe(false);
    expect(replacement.state.throttle).toBe(0);
  });

  it('preserves restored rotation rates until a real keyboard transition', () => {
    const target = new FakeKeyboardTarget();
    const { mapper } = createMapper(target);
    const replacement = createCommandController(['earth']);
    replacement.commands.rotate(0.1, 0.2, 0.3);

    mapper.updateCommands(replacement.commands, () => ({
      requestedWarp: replacement.state.requestedWarp,
      throttle: replacement.state.throttle,
    }));
    mapper.update();
    expect([...replacement.state.rotationRatesRadS]).toEqual([0.1, 0.2, 0.3]);

    target.keyDown('KeyW');
    mapper.update();
    expect([...replacement.state.rotationRatesRadS]).toEqual([ROTATION_RATE_RAD_S, 0, 0]);
    target.keyUp('KeyW');
    mapper.update();
    expect([...replacement.state.rotationRatesRadS]).toEqual([0, 0, 0]);
  });
});
