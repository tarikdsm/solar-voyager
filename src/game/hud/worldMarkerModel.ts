import type { SimSnapshot } from '../../sim/simulationSnapshot.js';
import type { CameraPose } from '../cameraDirector.js';
import {
  CAMERA_BASIS_COMPONENTS,
  PROJECTED_POINT_COMPONENTS,
  clampToViewportEdge,
  projectPointInto,
  writeCameraBasisInto,
} from './markerProjection.js';

/**
 * In-world HUD markers (plan §T0112, spec §7 "In-world markers").
 *
 * Turns one `SimSnapshot` plus one published `CameraPose` into viewport pixels
 * for the DOM overlay. Allocation-free: every result lands in a caller-owned
 * {@link WorldMarkerBuffer} created once at setup.
 */

/** Direction/point markers, in buffer order. */
export const WorldMarkerIndex = Object.freeze({
  TARGET: 0,
  PROGRADE: 1,
  RETROGRADE: 2,
} as const);

export type WorldMarkerIndex = (typeof WorldMarkerIndex)[keyof typeof WorldMarkerIndex];

export const WORLD_MARKER_COUNT = 3;

/** Per marker: visible, x px, y px, behind (0|1), offscreen (0|1). */
export const WORLD_MARKER_COMPONENTS = 5;

/**
 * Body labels drawn at once.
 *
 * A legibility budget, not a performance one. The catalog has 43 bodies and a
 * wide-field view of the inner system can put a dozen inside the frustum; past
 * about eight the labels overlap into a wall of text and stop being navigation
 * aids. All 43 are still scanned every sample — the nearest eight win.
 */
export const BODY_LABEL_SLOT_COUNT = 8;

/** Distance from the viewport edge that an off-screen marker is pinned at, in CSS px. */
export const MARKER_EDGE_INSET_PX = 28;

/** Labels are suppressed this close to the edge, where they would be clipped. */
const LABEL_EDGE_MARGIN_PX = 8;

export interface WorldMarkerBuffer {
  /** False when the pose had no usable basis; every marker is hidden. */
  valid: boolean;
  readonly markers: Float64Array;
  /** Distance to the navigation target in km, NaN when none is selected. */
  targetDistanceKm: number;
  /** Catalog index of the navigation target, or -1. */
  targetBodyIndex: number;
  /** Populated label slots, 0..BODY_LABEL_SLOT_COUNT. */
  labelCount: number;
  readonly labelBodyIndices: Int32Array;
  /** Two components (x px, y px) per slot. */
  readonly labelPixels: Float64Array;
  readonly labelDistancesKm: Float64Array;
}

export function createWorldMarkerBuffer(): WorldMarkerBuffer {
  return {
    valid: false,
    markers: new Float64Array(WORLD_MARKER_COUNT * WORLD_MARKER_COMPONENTS),
    targetDistanceKm: Number.NaN,
    targetBodyIndex: -1,
    labelCount: 0,
    labelBodyIndices: new Int32Array(BODY_LABEL_SLOT_COUNT),
    labelPixels: new Float64Array(BODY_LABEL_SLOT_COUNT * 2),
    labelDistancesKm: new Float64Array(BODY_LABEL_SLOT_COUNT),
  };
}

/** Scratch owned by the module: one basis and one projected point per call. */
const basisScratch = new Float64Array(CAMERA_BASIS_COMPONENTS);
const pointScratch = new Float64Array(PROJECTED_POINT_COMPONENTS);

function clearBuffer(buffer: WorldMarkerBuffer): void {
  buffer.valid = false;
  buffer.markers.fill(0);
  buffer.targetDistanceKm = Number.NaN;
  buffer.targetBodyIndex = -1;
  buffer.labelCount = 0;
}

function writeMarker(
  buffer: WorldMarkerBuffer,
  index: WorldMarkerIndex,
  widthPx: number,
  heightPx: number,
  clampOffscreen: boolean,
): void {
  const offset = index * WORLD_MARKER_COMPONENTS;
  const depthKm = pointScratch[2] as number;
  if (!Number.isFinite(pointScratch[0] as number) || !Number.isFinite(depthKm)) return;
  const behind = depthKm <= 0;
  const offscreen = clampToViewportEdge(
    pointScratch,
    widthPx,
    heightPx,
    MARKER_EDGE_INSET_PX,
    behind,
  );
  if (offscreen && !clampOffscreen) return;
  buffer.markers[offset] = 1;
  buffer.markers[offset + 1] = pointScratch[0] as number;
  buffer.markers[offset + 2] = pointScratch[1] as number;
  buffer.markers[offset + 3] = behind ? 1 : 0;
  buffer.markers[offset + 4] = offscreen ? 1 : 0;
}

/**
 * Inserts one candidate label into the nearest-N slots, keeping them sorted by
 * distance. Fixed-size insertion sort: N is 8, so the shift is cheaper than any
 * structure that would allocate.
 */
function insertLabel(
  buffer: WorldMarkerBuffer,
  bodyIndex: number,
  distanceKm: number,
  xPx: number,
  yPx: number,
): void {
  let position = buffer.labelCount;
  while (position > 0 && (buffer.labelDistancesKm[position - 1] as number) > distanceKm) {
    position -= 1;
  }
  if (position >= BODY_LABEL_SLOT_COUNT) return;
  const last = Math.min(buffer.labelCount, BODY_LABEL_SLOT_COUNT - 1);
  for (let slot = last; slot > position; slot -= 1) {
    buffer.labelBodyIndices[slot] = buffer.labelBodyIndices[slot - 1] as number;
    buffer.labelDistancesKm[slot] = buffer.labelDistancesKm[slot - 1] as number;
    buffer.labelPixels[slot * 2] = buffer.labelPixels[(slot - 1) * 2] as number;
    buffer.labelPixels[slot * 2 + 1] = buffer.labelPixels[(slot - 1) * 2 + 1] as number;
  }
  buffer.labelBodyIndices[position] = bodyIndex;
  buffer.labelDistancesKm[position] = distanceKm;
  buffer.labelPixels[position * 2] = xPx;
  buffer.labelPixels[position * 2 + 1] = yPx;
  if (buffer.labelCount < BODY_LABEL_SLOT_COUNT) buffer.labelCount += 1;
}

/**
 * Projects the target diamond, the prograde/retrograde pair and the body labels.
 *
 * `labelsEnabled` is threaded in rather than filtered by the view so a disabled
 * label layer costs nothing: the 43-body scan is the most expensive thing here
 * and it does not run when the toggle is off.
 *
 * The ship is excluded structurally, not by a predicate:
 * `snapshot.bodyPositionsKm` holds catalog bodies only, and the assertion below
 * makes a future change that appends to it fail here instead of drawing a label
 * on the player's own hull. (`EpochWorld.positionsKm` is the array with the ship
 * triple appended, and it lives in `render/`.)
 */
export function writeWorldMarkersInto(
  buffer: WorldMarkerBuffer,
  snapshot: SimSnapshot,
  pose: CameraPose,
  widthPx: number,
  heightPx: number,
  labelsEnabled: boolean,
): WorldMarkerBuffer {
  clearBuffer(buffer);
  if (!(widthPx > 0) || !(heightPx > 0)) return buffer;
  const bodyCount = snapshot.bodyIds.length;
  if (snapshot.bodyPositionsKm.length !== bodyCount * 3) {
    throw new RangeError('world markers require one position triple per catalog body');
  }
  if (!writeCameraBasisInto(basisScratch, pose)) return buffer;
  buffer.valid = true;

  const cameraXKm = pose.positionKm.x;
  const cameraYKm = pose.positionKm.y;
  const cameraZKm = pose.positionKm.z;

  const targetBodyIndex = snapshot.targetBodyIndex;
  if (targetBodyIndex >= 0 && targetBodyIndex < bodyCount) {
    const offset = targetBodyIndex * 3;
    const targetXKm = snapshot.bodyPositionsKm[offset] as number;
    const targetYKm = snapshot.bodyPositionsKm[offset + 1] as number;
    const targetZKm = snapshot.bodyPositionsKm[offset + 2] as number;
    buffer.targetBodyIndex = targetBodyIndex;
    buffer.targetDistanceKm = Math.hypot(
      targetXKm - (snapshot.shipState[0] as number),
      targetYKm - (snapshot.shipState[1] as number),
      targetZKm - (snapshot.shipState[2] as number),
    );
    projectPointInto(
      pointScratch,
      basisScratch,
      cameraXKm,
      cameraYKm,
      cameraZKm,
      targetXKm,
      targetYKm,
      targetZKm,
      widthPx,
      heightPx,
    );
    // The target marker is the one that stays pinned to the edge: losing it is
    // losing the only in-world cue for where you are going.
    writeMarker(buffer, WorldMarkerIndex.TARGET, widthPx, heightPx, true);
  }

  writeVelocityMarkers(buffer, snapshot, cameraXKm, cameraYKm, cameraZKm, widthPx, heightPx);
  if (labelsEnabled) {
    writeBodyLabels(buffer, snapshot, cameraXKm, cameraYKm, cameraZKm, widthPx, heightPx);
  }
  return buffer;
}

/**
 * Prograde/retrograde, relative to the dominant body.
 *
 * The same frame `navballProjection.ts` uses. Two prograde markers that
 * disagreed about which velocity they meant would be worse than having one.
 * Projection along a ray is scale-invariant, so a *direction* is projected by
 * offsetting the camera position by the unit vector.
 */
function writeVelocityMarkers(
  buffer: WorldMarkerBuffer,
  snapshot: SimSnapshot,
  cameraXKm: number,
  cameraYKm: number,
  cameraZKm: number,
  widthPx: number,
  heightPx: number,
): void {
  const dominantBodyIndex = snapshot.dominantBodyIndex;
  if (dominantBodyIndex < 0 || dominantBodyIndex >= snapshot.bodyIds.length) return;
  const offset = dominantBodyIndex * 3;
  const velocityXKmS =
    (snapshot.shipCoordinateVelocityKmS[0] as number) -
    (snapshot.bodyVelocitiesKmS[offset] as number);
  const velocityYKmS =
    (snapshot.shipCoordinateVelocityKmS[1] as number) -
    (snapshot.bodyVelocitiesKmS[offset + 1] as number);
  const velocityZKmS =
    (snapshot.shipCoordinateVelocityKmS[2] as number) -
    (snapshot.bodyVelocitiesKmS[offset + 2] as number);
  const speedKmS = Math.hypot(velocityXKmS, velocityYKmS, velocityZKmS);
  if (!Number.isFinite(speedKmS) || speedKmS === 0) return;
  const unitXKm = velocityXKmS / speedKmS;
  const unitYKm = velocityYKmS / speedKmS;
  const unitZKm = velocityZKmS / speedKmS;

  projectPointInto(
    pointScratch,
    basisScratch,
    cameraXKm,
    cameraYKm,
    cameraZKm,
    cameraXKm + unitXKm,
    cameraYKm + unitYKm,
    cameraZKm + unitZKm,
    widthPx,
    heightPx,
  );
  writeMarker(buffer, WorldMarkerIndex.PROGRADE, widthPx, heightPx, false);
  projectPointInto(
    pointScratch,
    basisScratch,
    cameraXKm,
    cameraYKm,
    cameraZKm,
    cameraXKm - unitXKm,
    cameraYKm - unitYKm,
    cameraZKm - unitZKm,
    widthPx,
    heightPx,
  );
  writeMarker(buffer, WorldMarkerIndex.RETROGRADE, widthPx, heightPx, false);
}

function writeBodyLabels(
  buffer: WorldMarkerBuffer,
  snapshot: SimSnapshot,
  cameraXKm: number,
  cameraYKm: number,
  cameraZKm: number,
  widthPx: number,
  heightPx: number,
): void {
  const bodyCount = snapshot.bodyIds.length;
  const shipXKm = snapshot.shipState[0] as number;
  const shipYKm = snapshot.shipState[1] as number;
  const shipZKm = snapshot.shipState[2] as number;
  for (let bodyIndex = 0; bodyIndex < bodyCount; bodyIndex += 1) {
    const offset = bodyIndex * 3;
    const bodyXKm = snapshot.bodyPositionsKm[offset] as number;
    const bodyYKm = snapshot.bodyPositionsKm[offset + 1] as number;
    const bodyZKm = snapshot.bodyPositionsKm[offset + 2] as number;
    projectPointInto(
      pointScratch,
      basisScratch,
      cameraXKm,
      cameraYKm,
      cameraZKm,
      bodyXKm,
      bodyYKm,
      bodyZKm,
      widthPx,
      heightPx,
    );
    if (!((pointScratch[2] as number) > 0)) continue;
    const xPx = pointScratch[0] as number;
    const yPx = pointScratch[1] as number;
    if (!Number.isFinite(xPx) || !Number.isFinite(yPx)) continue;
    if (
      xPx < LABEL_EDGE_MARGIN_PX ||
      xPx > widthPx - LABEL_EDGE_MARGIN_PX ||
      yPx < LABEL_EDGE_MARGIN_PX ||
      yPx > heightPx - LABEL_EDGE_MARGIN_PX
    ) {
      continue;
    }
    // Ranked by distance from the ship, not from the camera: the label answers
    // "how far do I have to fly", and in observatory mode the camera can be
    // parsecs from the vessel it belongs to.
    const distanceKm = Math.hypot(bodyXKm - shipXKm, bodyYKm - shipYKm, bodyZKm - shipZKm);
    if (!Number.isFinite(distanceKm)) continue;
    if (
      buffer.labelCount === BODY_LABEL_SLOT_COUNT &&
      distanceKm >= (buffer.labelDistancesKm[BODY_LABEL_SLOT_COUNT - 1] as number)
    ) {
      continue;
    }
    insertLabel(buffer, bodyIndex, distanceKm, xPx, yPx);
  }
}
