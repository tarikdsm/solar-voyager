import {
  CINEMATIC_FOV_RATE_DEG_PER_SEC,
  CINEMATIC_ROLL_RATE_RAD_PER_SEC,
} from './cinematicCameraController.js';
import type { InputFrame } from './input/inputEngine.js';

/**
 * What one polled frame can ask of the camera and the photo path (T0125).
 *
 * `rollCameraBy` and `adjustCameraFovBy` report whether the active mode consumed
 * the input, so `Q`/`E` can be cinematic roll without this router — or any other
 * caller — knowing which camera mode is running.
 */
export interface CameraInputPorts {
  rollCameraBy(deltaRad: number): boolean;
  adjustCameraFovBy(deltaDeg: number): boolean;
  capturePhoto(): void;
}

/**
 * Turns one {@link InputFrame} into camera and photo intent.
 *
 * The third sibling of `flight/flightInputRouter.ts` and `hud/hudInputRouter.ts`,
 * and separate for the same reason: exactly one place knows how a polled frame
 * maps onto a subsystem's API.
 *
 * Roll and field of view are **level** queries so the keys are continuous — a
 * keydown ladder rolls a shot in visible steps — while capture is an **edge**
 * query collapsed to at most one photo per poll, because a held key must not
 * enqueue encodes (the controller drops the surplus, but never generating it is
 * cheaper).
 *
 * Allocation-free; called from the frame loop next to the other two routers.
 */
export class CameraInputRouter {
  constructor(private readonly ports: CameraInputPorts) {}

  apply(frame: InputFrame, wallDtSec: number): void {
    if (!Number.isFinite(wallDtSec) || wallDtSec < 0) {
      throw new RangeError('Camera input router delta must be finite and nonnegative.');
    }
    // Positive rolls the up vector clockwise about the view axis, which tips the
    // horizon the way rolling right does from a cockpit.
    const rollAxis =
      (frame.held('cameraRollRight') ? 1 : 0) - (frame.held('cameraRollLeft') ? 1 : 0);
    if (rollAxis !== 0 && wallDtSec > 0) {
      this.ports.rollCameraBy(rollAxis * CINEMATIC_ROLL_RATE_RAD_PER_SEC * wallDtSec);
    }
    const fovAxis =
      (frame.held('cameraFovWiden') ? 1 : 0) - (frame.held('cameraFovNarrow') ? 1 : 0);
    if (fovAxis !== 0 && wallDtSec > 0) {
      this.ports.adjustCameraFovBy(fovAxis * CINEMATIC_FOV_RATE_DEG_PER_SEC * wallDtSec);
    }
    if (frame.pressCount('photoCapture') > 0) this.ports.capturePhoto();
  }
}
