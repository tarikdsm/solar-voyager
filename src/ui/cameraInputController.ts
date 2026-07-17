const ORBIT_RADIANS_PER_PIXEL = 0.004;
const NON_PASSIVE_LISTENER_OPTIONS: AddEventListenerOptions = { passive: false };

export interface CameraControlPort {
  readonly focusId: string;
  orbitBy(deltaYawRad: number, deltaPitchRad: number): void;
  zoomByWheel(wheelDelta: number): void;
  focusBody(id: string): boolean;
  cycleFocus(step: number): string;
}

function formatFocusLabel(id: string): string {
  return `Focus: ${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/** Owns disposable DOM input listeners for the orbit camera. */
export class CameraInputController {
  private activePointerId = -1;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private disposed = false;

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.activePointerId >= 0) return;
    this.activePointerId = event.pointerId;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    const deltaX = event.clientX - this.lastPointerX;
    const deltaY = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.controls.orbitBy(-deltaX * ORBIT_RADIANS_PER_PIXEL, -deltaY * ORBIT_RADIANS_PER_PIXEL);
    event.preventDefault();
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.activePointerId = -1;
    this.canvas.releasePointerCapture(event.pointerId);
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.controls.zoomByWheel(event.deltaY);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    let handled = true;
    switch (event.key.toLowerCase()) {
      case '[':
        this.controls.cycleFocus(-1);
        break;
      case ']':
        this.controls.cycleFocus(1);
        break;
      case 'e':
        this.controls.focusBody('earth');
        break;
      case 'j':
        this.controls.focusBody('jupiter');
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    event.preventDefault();
    this.updateFocusLabel();
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly keyboardTarget: Window,
    private readonly focusLabel: HTMLElement,
    private readonly controls: CameraControlPort,
  ) {
    this.updateFocusLabel();
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerEnd);
    canvas.addEventListener('pointercancel', this.handlePointerEnd);
    canvas.addEventListener('wheel', this.handleWheel, NON_PASSIVE_LISTENER_OPTIONS);
    keyboardTarget.addEventListener('keydown', this.handleKeyDown);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerEnd);
    this.canvas.removeEventListener('pointercancel', this.handlePointerEnd);
    this.canvas.removeEventListener('wheel', this.handleWheel, NON_PASSIVE_LISTENER_OPTIONS);
    this.keyboardTarget.removeEventListener('keydown', this.handleKeyDown);
  }

  private updateFocusLabel(): void {
    this.focusLabel.textContent = formatFocusLabel(this.controls.focusId);
  }
}
