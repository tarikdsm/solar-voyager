import type { CameraPose } from '../cameraDirector.js';

/**
 * Float64 world→viewport projection for the DOM marker layer (plan §T0112).
 *
 * The markers are DOM elements driven by CSS transforms, so they need viewport
 * pixels, not GL clip space. Doing the projection here — in `game/`, from the
 * float64 body positions and the published `CameraPose` — is what keeps
 * `src/render/spaceScene.ts` the only float64→float32 site in the codebase
 * (Global Constraints; `tests/render/float32Boundary.test.ts` enforces it by
 * scanning for `Math.fround(`). There is no `Math.fround` in this file and there
 * must never be one: the whole point is that a marker on Eris at 1e10 km is
 * placed from the same doubles the physics uses.
 *
 * The basis below must agree bit-for-bit in *convention* with
 * `render/cameraRig.ts`, which hands `pose.lookDirection` to
 * `PerspectiveCamera.lookAt` with the camera at the render origin. three.js
 * `Matrix4.lookAt(eye = 0, target = f, up = hint)` produces `z = −f`,
 * `x = normalize(hint × z)`, `y = z × x`. Re-expressed without the sign flips
 * that is `r = normalize(f × hint)` and `u = r × f`, which is what this writes.
 */

/** Components written per projected point: x px, y px, depth km along forward. */
export const PROJECTED_POINT_COMPONENTS = 3;

/** Components of the camera basis buffer: forward, right, up, then tan(fov/2). */
export const CAMERA_BASIS_COMPONENTS = 10;

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Writes the orthonormal camera basis and the projection scale into `out`.
 *
 * Layout: `[fx, fy, fz, rx, ry, rz, ux, uy, uz, tanHalfFov]`.
 *
 * Returns false — and leaves `out` untouched — when the pose cannot produce a
 * basis: a degenerate look direction, or an up *hint* parallel to it. Callers
 * hide every marker for that sample rather than drawing from a garbage frame.
 * `upDirection` is a hint and not necessarily orthogonal (the T0110 `CameraPose`
 * contract), which is exactly why `u` is recovered from `r × f` instead of used
 * as given.
 */
export function writeCameraBasisInto(out: Float64Array, pose: CameraPose): boolean {
  if (out.length < CAMERA_BASIS_COMPONENTS) {
    throw new RangeError(`camera basis requires ${String(CAMERA_BASIS_COMPONENTS)} components`);
  }
  const lookX = pose.lookDirection.x;
  const lookY = pose.lookDirection.y;
  const lookZ = pose.lookDirection.z;
  const lookLength = Math.hypot(lookX, lookY, lookZ);
  if (!Number.isFinite(lookLength) || lookLength === 0) return false;
  const forwardX = lookX / lookLength;
  const forwardY = lookY / lookLength;
  const forwardZ = lookZ / lookLength;

  const hintX = pose.upDirection.x;
  const hintY = pose.upDirection.y;
  const hintZ = pose.upDirection.z;
  const crossX = forwardY * hintZ - forwardZ * hintY;
  const crossY = forwardZ * hintX - forwardX * hintZ;
  const crossZ = forwardX * hintY - forwardY * hintX;
  const crossLength = Math.hypot(crossX, crossY, crossZ);
  if (!Number.isFinite(crossLength) || crossLength === 0) return false;
  const rightX = crossX / crossLength;
  const rightY = crossY / crossLength;
  const rightZ = crossZ / crossLength;

  const fovDeg = pose.fovDeg;
  if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) return false;
  const tanHalfFov = Math.tan(fovDeg * 0.5 * DEGREES_TO_RADIANS);
  if (!Number.isFinite(tanHalfFov) || tanHalfFov <= 0) return false;

  out[0] = forwardX;
  out[1] = forwardY;
  out[2] = forwardZ;
  out[3] = rightX;
  out[4] = rightY;
  out[5] = rightZ;
  out[6] = rightY * forwardZ - rightZ * forwardY;
  out[7] = rightZ * forwardX - rightX * forwardZ;
  out[8] = rightX * forwardY - rightY * forwardX;
  out[9] = tanHalfFov;
  return true;
}

/**
 * Projects one world point into viewport pixels.
 *
 * Writes `[xPx, yPx, depthKm]` into `out`. `depthKm` is the signed distance along
 * the camera forward axis: **negative or zero means behind the camera**, and the
 * pixel coordinates are then the mirrored direction, which is what lets a target
 * marker say "turn around" instead of vanishing. Callers decide what to do with
 * that; this function never hides anything.
 *
 * Coordinates are CSS pixels with the origin at the top-left of the canvas, which
 * is the frame the DOM overlay lives in.
 */
export function projectPointInto(
  out: Float64Array,
  basis: Float64Array,
  cameraPositionXKm: number,
  cameraPositionYKm: number,
  cameraPositionZKm: number,
  pointXKm: number,
  pointYKm: number,
  pointZKm: number,
  widthPx: number,
  heightPx: number,
): void {
  if (out.length < PROJECTED_POINT_COMPONENTS) {
    throw new RangeError(
      `projected point requires ${String(PROJECTED_POINT_COMPONENTS)} components`,
    );
  }
  const deltaX = pointXKm - cameraPositionXKm;
  const deltaY = pointYKm - cameraPositionYKm;
  const deltaZ = pointZKm - cameraPositionZKm;
  const depthKm =
    deltaX * (basis[0] as number) + deltaY * (basis[1] as number) + deltaZ * (basis[2] as number);
  const rightKm =
    deltaX * (basis[3] as number) + deltaY * (basis[4] as number) + deltaZ * (basis[5] as number);
  const upKm =
    deltaX * (basis[6] as number) + deltaY * (basis[7] as number) + deltaZ * (basis[8] as number);
  const tanHalfFov = basis[9] as number;
  // Behind the camera the perspective divide flips both axes, which would put a
  // target that is directly astern in the centre of the screen. Dividing by the
  // magnitude instead keeps the direction honest, and `depthKm` still carries the
  // sign so the caller can render an arrow rather than a diamond.
  const divisor = depthKm > 0 ? depthKm : -depthKm;
  if (!Number.isFinite(divisor) || divisor === 0 || !Number.isFinite(upKm)) {
    out[0] = Number.NaN;
    out[1] = Number.NaN;
    out[2] = Number.NaN;
    return;
  }
  const aspect = widthPx / heightPx;
  const normalizedX = rightKm / (divisor * tanHalfFov * aspect);
  const normalizedY = upKm / (divisor * tanHalfFov);
  out[0] = (normalizedX + 1) * 0.5 * widthPx;
  out[1] = (1 - normalizedY) * 0.5 * heightPx;
  out[2] = depthKm;
}

/**
 * Apparent radius of a sphere in viewport pixels.
 *
 * Small-angle form `radiusKm / depthKm`, which is the same approximation the
 * body point-cloud threshold already uses and is exact to better than a pixel for
 * everything that is not filling the screen.
 */
export function apparentRadiusPx(
  radiusKm: number,
  depthKm: number,
  tanHalfFov: number,
  heightPx: number,
): number {
  if (!(depthKm > 0) || !(radiusKm > 0)) return 0;
  const radiusPx = (radiusKm / depthKm / tanHalfFov) * (heightPx * 0.5);
  return Number.isFinite(radiusPx) ? radiusPx : 0;
}

/**
 * Clamps a projected pixel onto the viewport edge, keeping its direction.
 *
 * Writes the clamped pair back into `out[0]`/`out[1]` and returns true when the
 * point was outside the inset rectangle (so the view can swap a diamond for an
 * edge arrow). Direction is measured from the viewport centre, so a marker slides
 * around the border towards the thing it points at instead of snapping to a
 * corner.
 */
export function clampToViewportEdge(
  out: Float64Array,
  widthPx: number,
  heightPx: number,
  insetPx: number,
  behind: boolean,
): boolean {
  const centerX = widthPx * 0.5;
  const centerY = heightPx * 0.5;
  const minX = insetPx;
  const maxX = Math.max(insetPx, widthPx - insetPx);
  const minY = insetPx;
  const maxY = Math.max(insetPx, heightPx - insetPx);
  let x = out[0] as number;
  let y = out[1] as number;
  if (behind) {
    // A behind-camera point projects to where its mirror image would be; the
    // player needs the opposite bearing.
    x = 2 * centerX - x;
    y = 2 * centerY - y;
  }
  if (!behind && x >= minX && x <= maxX && y >= minY && y <= maxY) {
    out[0] = x;
    out[1] = y;
    return false;
  }
  let directionX = x - centerX;
  let directionY = y - centerY;
  if (directionX === 0 && directionY === 0) directionY = -1;
  const halfWidth = Math.max(1e-9, centerX - insetPx);
  const halfHeight = Math.max(1e-9, centerY - insetPx);
  const scaleX = directionX === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(directionX);
  const scaleY = directionY === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(directionY);
  const scale = Math.min(scaleX, scaleY);
  if (Number.isFinite(scale)) {
    directionX *= scale;
    directionY *= scale;
  }
  out[0] = centerX + directionX;
  out[1] = centerY + directionY;
  return true;
}
