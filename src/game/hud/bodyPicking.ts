import type { ReadonlyVec3 } from '../../core/vec3.js';
import type { SimSnapshot } from '../../sim/simulationSnapshot.js';
import type { CameraPose } from '../cameraDirector.js';
import {
  CAMERA_BASIS_COMPONENTS,
  PROJECTED_POINT_COMPONENTS,
  apparentRadiusPx,
  projectPointInto,
  writeCameraBasisInto,
} from './markerProjection.js';

/**
 * Click-to-target by angular-disc picking (plan §T0112, spec §7).
 *
 * Deliberately *not* a three.js raycast. Three reasons, in order of weight:
 * bodies below the point-cloud threshold have no pickable mesh at all, so a
 * raycast would silently refuse to select the very targets you most need to
 * click; the scene is camera-relative float32, so a raycast would introduce a
 * second precision boundary the Global Constraints forbid; and `game/` may not
 * import `render/` anyway.
 */

/**
 * Floor on the clickable radius, in CSS pixels.
 *
 * Without it, Bennu subtends a few millionths of a degree and is unclickable in
 * practice. With it, every catalog body in front of the camera has a target you
 * can actually hit with a mouse. Ties are still broken by depth, so the floor
 * never lets a distant speck steal a click from the planet it is in front of.
 */
export const MIN_PICK_RADIUS_PX = 8;

/**
 * Vertical field of view of the system-map camera, in degrees.
 *
 * `render/spaceScene.ts` constructs every `CameraRelativeSpaceScene` camera with
 * this value and the map has no camera of its own, but `game/` may not import
 * `render/`. `src/render/systemMapScene.test.ts` asserts the two agree, the same
 * way `markerCameraAgreement.test.ts` pins the space-view convention.
 */
export const SYSTEM_MAP_CAMERA_FOV_DEG = 75;

const basisScratch = new Float64Array(CAMERA_BASIS_COMPONENTS);
const pointScratch = new Float64Array(PROJECTED_POINT_COMPONENTS);

/**
 * Mutable stand-in for a `CameraPose` the map camera does not publish.
 *
 * `OrbitCameraController` exposes a position and a look direction; the up hint
 * and the field of view come from the three.js camera it drives, which never has
 * `camera.up` reassigned and so keeps the library default. Preallocated: the map
 * pick path allocates nothing.
 */
const mapPoseScratch = {
  positionKm: { x: 0, y: 0, z: 0 },
  lookDirection: { x: 0, y: 0, z: -1 },
  upDirection: { x: 0, y: 1, z: 0 },
  fovDeg: SYSTEM_MAP_CAMERA_FOV_DEG,
};

/**
 * Shared hit test. `radiiKm === null` means "flat {@link MIN_PICK_RADIUS_PX} for
 * every body", which is the system map's constant-size icon rule.
 */
function pickNearestBodyIndex(
  snapshot: SimSnapshot,
  pose: CameraPose,
  radiiKm: Float64Array | null,
  widthPx: number,
  heightPx: number,
  pixelX: number,
  pixelY: number,
): number {
  const bodyCount = snapshot.bodyIds.length;
  if (radiiKm !== null && radiiKm.length < bodyCount) {
    throw new RangeError('body picking requires one mean radius per catalog body');
  }
  if (snapshot.bodyPositionsKm.length !== bodyCount * 3) {
    throw new RangeError('body picking requires one position triple per catalog body');
  }
  if (!(widthPx > 0) || !(heightPx > 0)) return -1;
  if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) return -1;
  if (!writeCameraBasisInto(basisScratch, pose)) return -1;
  const tanHalfFov = basisScratch[9] as number;

  let bestIndex = -1;
  let bestDepthKm = Number.POSITIVE_INFINITY;
  for (let bodyIndex = 0; bodyIndex < bodyCount; bodyIndex += 1) {
    const offset = bodyIndex * 3;
    projectPointInto(
      pointScratch,
      basisScratch,
      pose.positionKm.x,
      pose.positionKm.y,
      pose.positionKm.z,
      snapshot.bodyPositionsKm[offset] as number,
      snapshot.bodyPositionsKm[offset + 1] as number,
      snapshot.bodyPositionsKm[offset + 2] as number,
      widthPx,
      heightPx,
    );
    const depthKm = pointScratch[2] as number;
    if (!(depthKm > 0) || depthKm >= bestDepthKm) continue;
    const centerX = pointScratch[0] as number;
    const centerY = pointScratch[1] as number;
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) continue;
    const pickRadiusPx =
      radiiKm === null
        ? MIN_PICK_RADIUS_PX
        : Math.max(
            MIN_PICK_RADIUS_PX,
            apparentRadiusPx(radiiKm[bodyIndex] as number, depthKm, tanHalfFov, heightPx),
          );
    const deltaX = pixelX - centerX;
    const deltaY = pixelY - centerY;
    if (deltaX * deltaX + deltaY * deltaY > pickRadiusPx * pickRadiusPx) continue;
    bestIndex = bodyIndex;
    bestDepthKm = depthKm;
  }
  return bestIndex;
}

/**
 * Returns the catalog index of the body under a viewport pixel, or -1.
 *
 * `radiiKm` is the catalog mean radius per body, in `snapshot.bodyIds` order.
 * The ship is not a candidate because `snapshot.bodyPositionsKm` contains
 * catalog bodies only; the length check makes that structural rather than
 * assumed.
 *
 * Selection rule: among every body whose projected disc contains the pixel, the
 * one with the smallest positive depth wins — nearest along the ray, which is
 * what makes clicking Io in front of Jupiter select Io.
 */
export function pickBodyIndexAtPixel(
  snapshot: SimSnapshot,
  pose: CameraPose,
  radiiKm: Float64Array,
  widthPx: number,
  heightPx: number,
  pixelX: number,
  pixelY: number,
): number {
  return pickNearestBodyIndex(snapshot, pose, radiiKm, widthPx, heightPx, pixelX, pixelY);
}

/**
 * Returns the catalog index of the body whose **system-map icon** covers a
 * viewport pixel, or -1.
 *
 * The map draws one constant-size icon batch rather than angular discs, so every
 * candidate gets a flat {@link MIN_PICK_RADIUS_PX} radius — enough to cover the
 * 4 px icon with slop, and small enough that the Sun does not swallow a third of
 * the screen. Everything else is the space view's rule: nearest along the ray
 * wins, and the ship is excluded because `snapshot.bodyPositionsKm` is the
 * catalog-only array.
 *
 * The up hint and field of view are the map camera's implicit ones (three.js
 * default up, {@link SYSTEM_MAP_CAMERA_FOV_DEG}); `OrbitCameraController`
 * publishes only the position and the look direction.
 */
export function pickMapBodyIndexAtPixel(
  snapshot: SimSnapshot,
  cameraPositionKm: ReadonlyVec3,
  lookDirection: ReadonlyVec3,
  widthPx: number,
  heightPx: number,
  pixelX: number,
  pixelY: number,
): number {
  mapPoseScratch.positionKm.x = cameraPositionKm.x;
  mapPoseScratch.positionKm.y = cameraPositionKm.y;
  mapPoseScratch.positionKm.z = cameraPositionKm.z;
  mapPoseScratch.lookDirection.x = lookDirection.x;
  mapPoseScratch.lookDirection.y = lookDirection.y;
  mapPoseScratch.lookDirection.z = lookDirection.z;
  return pickNearestBodyIndex(snapshot, mapPoseScratch, null, widthPx, heightPx, pixelX, pixelY);
}
