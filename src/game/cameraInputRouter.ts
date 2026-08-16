import {
  CINEMATIC_FOV_RATE_DEG_PER_SEC,
  CINEMATIC_ROLL_RATE_RAD_PER_SEC,
} from './cinematicCameraController.js';
import type { InputAction } from './input/bindings.js';
import type { InputFrame } from './input/inputEngine.js';

/**
 * Actions that exist only while the cinematic camera is running.
 *
 * `InputEngine` consults this through its `isActionActive` port, so outside
 * cinematic these keys are not merely inert — they are **not claimed at all**,
 * and `E` goes on reaching `ui/cameraInputController.ts` as the Earth shortcut it
 * has always been. Scoping the effect without scoping the claim is what broke
 * focus cycling in every camera mode (design doc section 2.4).
 *
 * `photoCapture` is deliberately absent: a photo is worth taking from any camera.
 */
export const CINEMATIC_ONLY_ACTIONS: readonly InputAction[] = Object.freeze([
  'cameraRollLeft',
  'cameraRollRight',
  'cameraFovNarrow',
  'cameraFovWiden',
]);

/** Allocation-free membership test for the `isActionActive` port. */
export function isCinematicOnlyAction(action: InputAction): boolean {
  for (let index = 0; index < CINEMATIC_ONLY_ACTIONS.length; index += 1) {
    if (CINEMATIC_ONLY_ACTIONS[index] === action) return true;
  }
  return false;
}

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
