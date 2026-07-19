import { describe, expect, it, vi } from 'vitest';

import { CameraInputController, type CameraControlPort } from './cameraInputController.js';

class FakeEventTarget {
  private readonly listeners = new Map<string, EventListenerOrEventListenerObject>();
  readonly addEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject): void => {
      this.listeners.set(type, listener);
    },
  );
  readonly removeEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject): void => {
      if (this.listeners.get(type) === listener) this.listeners.delete(type);
    },
  );

  emit(type: string, event: object): void {
    const listener = this.listeners.get(type);
    if (typeof listener === 'function') listener(event as Event);
    else listener?.handleEvent(event as Event);
  }
}

class FakeCanvas extends FakeEventTarget {
  private readonly capturedPointerIds = new Set<number>();
  readonly setPointerCapture = vi.fn((pointerId: number): void => {
    this.capturedPointerIds.add(pointerId);
  });
  readonly releasePointerCapture = vi.fn((pointerId: number): void => {
    this.capturedPointerIds.delete(pointerId);
  });
  readonly hasPointerCapture = vi.fn((pointerId: number): boolean =>
    this.capturedPointerIds.has(pointerId),
  );
}

function createFixture(initiallyEnabled = true) {
  const canvas = new FakeCanvas();
  const keyboard = new FakeEventTarget();
  const label = { textContent: '' };
  let focusId = 'earth';
  const controls: CameraControlPort = {
    get focusId() {
      return focusId;
    },
    orbitBy: vi.fn(),
    zoomByWheel: vi.fn(),
    focusBody: vi.fn((id: string) => {
      focusId = id;
      return true;
    }),
    cycleFocus: vi.fn((step: number) => {
      focusId = step > 0 ? 'jupiter' : 'venus';
      return focusId;
    }),
  };
  const interactions: string[] = [];
  const input = new CameraInputController(
    canvas as unknown as HTMLCanvasElement,
    keyboard as unknown as Window,
    label as unknown as HTMLElement,
    controls,
    initiallyEnabled,
    (interaction) => interactions.push(interaction),
  );
  return { canvas, controls, input, interactions, keyboard, label };
}

describe('CameraInputController', () => {
  it('drags with pointer capture and forwards wheel zoom', () => {
    const { canvas, controls, interactions } = createFixture();
    const dragPreventDefault = vi.fn();
    canvas.emit('pointerdown', {
      pointerId: 7,
      clientX: 100,
      clientY: 80,
      button: 0,
      preventDefault: dragPreventDefault,
    });
    canvas.emit('pointermove', {
      pointerId: 7,
      clientX: 125,
      clientY: 70,
      preventDefault: dragPreventDefault,
    });
    canvas.emit('pointerup', { pointerId: 7 });

    expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);
    expect(controls.orbitBy).toHaveBeenCalledWith(-0.1, 0.04);
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);

    const wheelPreventDefault = vi.fn();
    canvas.emit('wheel', { deltaY: -120, preventDefault: wheelPreventDefault });
    expect(wheelPreventDefault).toHaveBeenCalledOnce();
    expect(controls.zoomByWheel).toHaveBeenCalledWith(-120);
    expect(interactions).toEqual(['orbit', 'zoom']);
  });

  it('orbits and zooms with collision-free Shift keyboard chords', () => {
    const { controls, interactions, keyboard } = createFixture();
    const preventDefault = vi.fn();
    const base = {
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
      shiftKey: true,
      target: null,
      preventDefault,
    };

    keyboard.emit('keydown', { ...base, code: 'ArrowLeft', key: 'ArrowLeft' });
    keyboard.emit('keydown', { ...base, code: 'ArrowUp', key: 'ArrowUp' });
    keyboard.emit('keydown', { ...base, code: 'PageUp', key: 'PageUp' });
    keyboard.emit('keydown', { ...base, code: 'PageDown', key: 'PageDown' });

    expect(controls.orbitBy).toHaveBeenNthCalledWith(1, 0.12, 0);
    expect(controls.orbitBy).toHaveBeenNthCalledWith(2, 0, 0.12);
    expect(controls.zoomByWheel).toHaveBeenNthCalledWith(1, -120);
    expect(controls.zoomByWheel).toHaveBeenNthCalledWith(2, 120);
    expect(interactions).toEqual(['orbit', 'orbit', 'zoom', 'zoom']);
    expect(preventDefault).toHaveBeenCalledTimes(4);
  });

  it('does not steer from editable targets or unmodified camera keys', () => {
    const { controls, interactions, keyboard } = createFixture();
    const input = { isContentEditable: false, tagName: 'INPUT' };
    const base = {
      altKey: false,
      code: 'ArrowLeft',
      ctrlKey: false,
      key: 'ArrowLeft',
      metaKey: false,
      repeat: false,
      preventDefault: vi.fn(),
    };

    keyboard.emit('keydown', { ...base, shiftKey: false, target: null });
    keyboard.emit('keydown', { ...base, shiftKey: true, target: input });

    expect(controls.orbitBy).not.toHaveBeenCalled();
    expect(interactions).toEqual([]);
    expect(base.preventDefault).not.toHaveBeenCalled();
  });

  it('supports target cycling and direct Earth/Jupiter shortcuts', () => {
    const { controls, keyboard, label } = createFixture();
    expect(label.textContent).toBe('Focus: Earth');

    const preventDefault = vi.fn();
    keyboard.emit('keydown', {
      key: ']',
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault,
    });
    expect(controls.cycleFocus).toHaveBeenCalledWith(1);
    expect(label.textContent).toBe('Focus: Jupiter');

    keyboard.emit('keydown', {
      key: '[',
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault,
    });
    expect(controls.cycleFocus).toHaveBeenCalledWith(-1);
    expect(label.textContent).toBe('Focus: Venus');

    keyboard.emit('keydown', {
      key: 'e',
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault,
    });
    keyboard.emit('keydown', {
      key: 'J',
      target: { isContentEditable: false, tagName: 'BUTTON' },
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault,
    });
    expect(controls.focusBody).toHaveBeenNthCalledWith(1, 'earth');
    expect(controls.focusBody).toHaveBeenNthCalledWith(2, 'jupiter');
    expect(label.textContent).toBe('Focus: Jupiter');
    expect(preventDefault).toHaveBeenCalledTimes(4);
  });

  it('ignores modified/repeated keys and removes every listener on dispose', () => {
    const { canvas, controls, input, keyboard } = createFixture();
    keyboard.emit('keydown', {
      key: 'j',
      repeat: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    });
    keyboard.emit('keydown', {
      key: 'j',
      repeat: false,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    });
    expect(controls.focusBody).not.toHaveBeenCalled();

    input.dispose();
    canvas.emit('wheel', { deltaY: 1, preventDefault: vi.fn() });
    keyboard.emit('keydown', {
      key: 'j',
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    });
    expect(controls.zoomByWheel).not.toHaveBeenCalled();
    expect(controls.focusBody).not.toHaveBeenCalled();
  });

  it('has no camera or event effects while disabled', () => {
    const { canvas, controls, input, keyboard } = createFixture(false);
    const pointerPreventDefault = vi.fn();
    const wheelPreventDefault = vi.fn();
    const keyPreventDefault = vi.fn();

    canvas.emit('pointerdown', {
      pointerId: 7,
      clientX: 100,
      clientY: 80,
      button: 0,
      preventDefault: pointerPreventDefault,
    });
    canvas.emit('pointermove', {
      pointerId: 7,
      clientX: 125,
      clientY: 70,
      preventDefault: pointerPreventDefault,
    });
    canvas.emit('pointerup', { pointerId: 7 });
    canvas.emit('wheel', { deltaY: -120, preventDefault: wheelPreventDefault });
    keyboard.emit('keydown', {
      key: 'j',
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: keyPreventDefault,
    });

    expect(canvas.setPointerCapture).not.toHaveBeenCalled();
    expect(canvas.releasePointerCapture).not.toHaveBeenCalled();
    expect(controls.orbitBy).not.toHaveBeenCalled();
    expect(controls.zoomByWheel).not.toHaveBeenCalled();
    expect(controls.focusBody).not.toHaveBeenCalled();
    expect(pointerPreventDefault).not.toHaveBeenCalled();
    expect(wheelPreventDefault).not.toHaveBeenCalled();
    expect(keyPreventDefault).not.toHaveBeenCalled();

    input.setEnabled(true);
    canvas.emit('wheel', { deltaY: -120, preventDefault: wheelPreventDefault });
    expect(controls.zoomByWheel).toHaveBeenCalledWith(-120);
    expect(wheelPreventDefault).toHaveBeenCalledOnce();
  });

  it('toggles the enabled gate without listener churn', () => {
    const { canvas, input, keyboard } = createFixture();
    const canvasAdds = canvas.addEventListener.mock.calls.slice();
    const keyboardAdds = keyboard.addEventListener.mock.calls.slice();

    for (let index = 0; index < 100; index += 1) {
      input.setEnabled(index % 2 === 0);
    }

    expect(canvas.addEventListener.mock.calls).toEqual(canvasAdds);
    expect(keyboard.addEventListener.mock.calls).toEqual(keyboardAdds);
    expect(canvas.removeEventListener).not.toHaveBeenCalled();
    expect(keyboard.removeEventListener).not.toHaveBeenCalled();
  });

  it('ends an active capture when disabled so the next drag can start', () => {
    const { canvas, controls, input } = createFixture();
    const firstPreventDefault = vi.fn();
    canvas.emit('pointerdown', {
      pointerId: 7,
      clientX: 100,
      clientY: 80,
      button: 0,
      preventDefault: firstPreventDefault,
    });
    expect(canvas.hasPointerCapture(7)).toBe(true);

    input.setEnabled(false);
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(canvas.hasPointerCapture(7)).toBe(false);

    const disabledPreventDefault = vi.fn();
    canvas.emit('pointermove', {
      pointerId: 7,
      clientX: 120,
      clientY: 70,
      preventDefault: disabledPreventDefault,
    });
    canvas.emit('pointerup', { pointerId: 7 });
    expect(controls.orbitBy).not.toHaveBeenCalled();
    expect(disabledPreventDefault).not.toHaveBeenCalled();

    input.setEnabled(true);
    const nextPreventDefault = vi.fn();
    canvas.emit('pointerdown', {
      pointerId: 8,
      clientX: 20,
      clientY: 30,
      button: 0,
      preventDefault: nextPreventDefault,
    });
    canvas.emit('pointermove', {
      pointerId: 8,
      clientX: 30,
      clientY: 35,
      preventDefault: nextPreventDefault,
    });

    expect(canvas.setPointerCapture).toHaveBeenNthCalledWith(2, 8);
    expect(controls.orbitBy).toHaveBeenCalledWith(-0.04, -0.02);
  });
});
