import { describe, expect, it, vi } from 'vitest';

import { CameraInputController, type CameraControlPort } from './cameraInputController.js';

class FakeEventTarget {
  private readonly listeners = new Map<string, EventListenerOrEventListenerObject>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  emit(type: string, event: object): void {
    const listener = this.listeners.get(type);
    if (typeof listener === 'function') listener(event as Event);
    else listener?.handleEvent(event as Event);
  }
}

class FakeCanvas extends FakeEventTarget {
  readonly setPointerCapture = vi.fn();
  readonly releasePointerCapture = vi.fn();
}

function createFixture() {
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
  const input = new CameraInputController(
    canvas as unknown as HTMLCanvasElement,
    keyboard as unknown as Window,
    label as unknown as HTMLElement,
    controls,
  );
  return { canvas, controls, input, keyboard, label };
}

describe('CameraInputController', () => {
  it('drags with pointer capture and forwards wheel zoom', () => {
    const { canvas, controls } = createFixture();
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
});
