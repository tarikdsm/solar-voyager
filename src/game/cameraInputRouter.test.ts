import { describe, expect, it, vi } from 'vitest';

import { CameraInputRouter } from './cameraInputRouter.js';
import {
  CINEMATIC_FOV_RATE_DEG_PER_SEC,
  CINEMATIC_ROLL_RATE_RAD_PER_SEC,
} from './cinematicCameraController.js';
import type { InputAction } from './input/bindings.js';
import type { InputFrame } from './input/inputEngine.js';

const FRAME_SEC = 1 / 60;

function createFrame(
  held: readonly InputAction[],
  presses: readonly InputAction[] = [],
): InputFrame {
  return {
    lookYawRad: 0,
    lookPitchRad: 0,
    axes: { pitch: 0, yaw: 0, roll: 0, throttle: 0 },
    held: (action: InputAction) => held.includes(action),
    pressed: (action: InputAction) => presses.includes(action),
    pressCount: (action: InputAction) => presses.filter((entry) => entry === action).length,
  } as unknown as InputFrame;
}

function createPorts() {
  return {
    rollCameraBy: vi.fn(() => true),
    adjustCameraFovBy: vi.fn(() => true),
    capturePhoto: vi.fn(),
  };
}

describe('CameraInputRouter', () => {
  it('rolls continuously while a key is held, at the published rate', () => {
    const ports = createPorts();
    const router = new CameraInputRouter(ports);
    router.apply(createFrame(['cameraRollRight']), FRAME_SEC);
    expect(ports.rollCameraBy).toHaveBeenCalledWith(CINEMATIC_ROLL_RATE_RAD_PER_SEC * FRAME_SEC);

    router.apply(createFrame(['cameraRollLeft']), FRAME_SEC);
    expect(ports.rollCameraBy).toHaveBeenLastCalledWith(
      -CINEMATIC_ROLL_RATE_RAD_PER_SEC * FRAME_SEC,
    );

    // Both down cancel; nothing is sent rather than a zero being sent.
    ports.rollCameraBy.mockClear();
    router.apply(createFrame(['cameraRollLeft', 'cameraRollRight']), FRAME_SEC);
    expect(ports.rollCameraBy).not.toHaveBeenCalled();
  });

  it('widens and narrows the field of view at the published rate', () => {
    const ports = createPorts();
    const router = new CameraInputRouter(ports);
    router.apply(createFrame(['cameraFovWiden']), FRAME_SEC);
    expect(ports.adjustCameraFovBy).toHaveBeenCalledWith(
      CINEMATIC_FOV_RATE_DEG_PER_SEC * FRAME_SEC,
    );
    router.apply(createFrame(['cameraFovNarrow']), FRAME_SEC);
    expect(ports.adjustCameraFovBy).toHaveBeenLastCalledWith(
      -CINEMATIC_FOV_RATE_DEG_PER_SEC * FRAME_SEC,
    );
  });

  it('takes at most one photo per poll however many presses arrived', () => {
    const ports = createPorts();
    const router = new CameraInputRouter(ports);
    router.apply(createFrame([], ['photoCapture', 'photoCapture', 'photoCapture']), FRAME_SEC);
    expect(ports.capturePhoto).toHaveBeenCalledTimes(1);
    router.apply(createFrame([]), FRAME_SEC);
    expect(ports.capturePhoto).toHaveBeenCalledTimes(1);
  });

  it('does nothing on an empty frame and rejects an impossible delta', () => {
    const ports = createPorts();
    const router = new CameraInputRouter(ports);
    router.apply(createFrame([]), FRAME_SEC);
    expect(ports.rollCameraBy).not.toHaveBeenCalled();
    expect(ports.adjustCameraFovBy).not.toHaveBeenCalled();
    expect(ports.capturePhoto).not.toHaveBeenCalled();
    expect(() => router.apply(createFrame([]), -1)).toThrow(RangeError);
  });
});
