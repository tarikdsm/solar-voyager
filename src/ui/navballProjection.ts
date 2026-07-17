import type { SimSnapshot } from '../sim/simulationSnapshot.js';

export const NAVBALL_MARKER_COMPONENTS = 3;

export const NavballMarkerIndex = Object.freeze({
  PROGRADE: 0,
  RETROGRADE: 1,
  NORMAL: 2,
  ANTINORMAL: 3,
  RADIAL_OUT: 4,
  RADIAL_IN: 5,
} as const);

export type NavballMarkerIndex = (typeof NavballMarkerIndex)[keyof typeof NavballMarkerIndex];

const NAVBALL_MARKER_COUNT = 6;
const FRONT_HEMISPHERE_EPSILON = 32 * Number.EPSILON;
const RADIANS_TO_DEGREES = 180 / Math.PI;

export interface NavballProjectionBuffer {
  readonly markers: Float64Array;
  valid: boolean;
  horizonAngleDeg: number;
  horizonOffset: number;
  horizonScaleY: number;
  thrustX: number;
  thrustY: number;
  thrustVisible: number;
}

interface InertialFromLocalMatrix {
  xx: number;
  xy: number;
  xz: number;
  yx: number;
  yy: number;
  yz: number;
  zx: number;
  zy: number;
  zz: number;
}

const inertialFromLocal: InertialFromLocalMatrix = {
  xx: 1,
  xy: 0,
  xz: 0,
  yx: 0,
  yy: 1,
  yz: 0,
  zx: 0,
  zy: 0,
  zz: 1,
};

function clearProjection(output: NavballProjectionBuffer): void {
  output.markers.fill(0);
  output.valid = false;
  output.horizonAngleDeg = 0;
  output.horizonOffset = 0;
  output.horizonScaleY = 0;
  output.thrustX = 0;
  output.thrustY = 0;
  output.thrustVisible = 0;
}

function writeInertialFromLocalMatrix(quaternion: Float64Array): boolean {
  const quaternionX = quaternion[0] as number;
  const quaternionY = quaternion[1] as number;
  const quaternionZ = quaternion[2] as number;
  const quaternionW = quaternion[3] as number;
  const quaternionNorm = Math.hypot(quaternionX, quaternionY, quaternionZ, quaternionW);
  if (!Number.isFinite(quaternionNorm) || quaternionNorm === 0) return false;

  const x = quaternionX / quaternionNorm;
  const y = quaternionY / quaternionNorm;
  const z = quaternionZ / quaternionNorm;
  const w = quaternionW / quaternionNorm;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const xw = x * w;
  const yw = y * w;
  const zw = z * w;

  inertialFromLocal.xx = 1 - 2 * (yy + zz);
  inertialFromLocal.xy = 2 * (xy - zw);
  inertialFromLocal.xz = 2 * (xz + yw);
  inertialFromLocal.yx = 2 * (xy + zw);
  inertialFromLocal.yy = 1 - 2 * (xx + zz);
  inertialFromLocal.yz = 2 * (yz - xw);
  inertialFromLocal.zx = 2 * (xz - yw);
  inertialFromLocal.zy = 2 * (yz + xw);
  inertialFromLocal.zz = 1 - 2 * (xx + yy);
  return true;
}

function writeMarker(
  markers: Float64Array,
  markerIndex: NavballMarkerIndex,
  inertialX: number,
  inertialY: number,
  inertialZ: number,
  directionValid: boolean,
): void {
  const offset = markerIndex * NAVBALL_MARKER_COMPONENTS;
  if (!directionValid) {
    markers[offset] = 0;
    markers[offset + 1] = 0;
    markers[offset + 2] = 0;
    return;
  }

  const localX =
    inertialFromLocal.xx * inertialX +
    inertialFromLocal.yx * inertialY +
    inertialFromLocal.zx * inertialZ;
  const localY =
    inertialFromLocal.xy * inertialX +
    inertialFromLocal.yy * inertialY +
    inertialFromLocal.zy * inertialZ;
  const localZ =
    inertialFromLocal.xz * inertialX +
    inertialFromLocal.yz * inertialY +
    inertialFromLocal.zz * inertialZ;
  markers[offset] = localY;
  markers[offset + 1] = -localZ;
  markers[offset + 2] = localX >= -FRONT_HEMISPHERE_EPSILON ? 1 : 0;
}

/** Allocates the stable output storage used by the sampled HUD publisher. */
export function createNavballProjectionBuffer(): NavballProjectionBuffer {
  return {
    markers: new Float64Array(NAVBALL_MARKER_COUNT * NAVBALL_MARKER_COMPONENTS),
    valid: false,
    horizonAngleDeg: 0,
    horizonOffset: 0,
    horizonScaleY: 0,
    thrustX: 0,
    thrustY: 0,
    thrustVisible: 0,
  };
}

/**
 * Writes the dominant-body orbital frame from physics-spec.md §3.0.1 into
 * ship-local front-hemisphere display coordinates without allocating.
 */
export function writeNavballProjectionInto(
  output: NavballProjectionBuffer,
  snapshot: SimSnapshot,
): NavballProjectionBuffer {
  clearProjection(output);
  const bodyIndex = snapshot.dominantBodyIndex;
  if (bodyIndex < 0 || bodyIndex >= snapshot.bodyIds.length) return output;
  if (!writeInertialFromLocalMatrix(snapshot.attitudeQuaternion)) return output;

  const bodyOffset = bodyIndex * 3;
  const radialX =
    (snapshot.shipState[0] as number) - (snapshot.bodyPositionsKm[bodyOffset] as number);
  const radialY =
    (snapshot.shipState[1] as number) - (snapshot.bodyPositionsKm[bodyOffset + 1] as number);
  const radialZ =
    (snapshot.shipState[2] as number) - (snapshot.bodyPositionsKm[bodyOffset + 2] as number);
  const radialMagnitude = Math.hypot(radialX, radialY, radialZ);
  if (!Number.isFinite(radialMagnitude) || radialMagnitude === 0) return output;
  const radialUnitX = radialX / radialMagnitude;
  const radialUnitY = radialY / radialMagnitude;
  const radialUnitZ = radialZ / radialMagnitude;

  const progradeX =
    (snapshot.shipCoordinateVelocityKmS[0] as number) -
    (snapshot.bodyVelocitiesKmS[bodyOffset] as number);
  const progradeY =
    (snapshot.shipCoordinateVelocityKmS[1] as number) -
    (snapshot.bodyVelocitiesKmS[bodyOffset + 1] as number);
  const progradeZ =
    (snapshot.shipCoordinateVelocityKmS[2] as number) -
    (snapshot.bodyVelocitiesKmS[bodyOffset + 2] as number);
  const progradeMagnitude = Math.hypot(progradeX, progradeY, progradeZ);
  const progradeValid = Number.isFinite(progradeMagnitude) && progradeMagnitude > 0;
  const progradeUnitX = progradeValid ? progradeX / progradeMagnitude : 0;
  const progradeUnitY = progradeValid ? progradeY / progradeMagnitude : 0;
  const progradeUnitZ = progradeValid ? progradeZ / progradeMagnitude : 0;

  const normalX = radialUnitY * progradeUnitZ - radialUnitZ * progradeUnitY;
  const normalY = radialUnitZ * progradeUnitX - radialUnitX * progradeUnitZ;
  const normalZ = radialUnitX * progradeUnitY - radialUnitY * progradeUnitX;
  const normalMagnitude = Math.hypot(normalX, normalY, normalZ);
  const normalValid = progradeValid && Number.isFinite(normalMagnitude) && normalMagnitude > 0;
  const normalUnitX = normalValid ? normalX / normalMagnitude : 0;
  const normalUnitY = normalValid ? normalY / normalMagnitude : 0;
  const normalUnitZ = normalValid ? normalZ / normalMagnitude : 0;

  writeMarker(
    output.markers,
    NavballMarkerIndex.PROGRADE,
    progradeUnitX,
    progradeUnitY,
    progradeUnitZ,
    progradeValid,
  );
  writeMarker(
    output.markers,
    NavballMarkerIndex.RETROGRADE,
    -progradeUnitX,
    -progradeUnitY,
    -progradeUnitZ,
    progradeValid,
  );
  writeMarker(
    output.markers,
    NavballMarkerIndex.NORMAL,
    normalUnitX,
    normalUnitY,
    normalUnitZ,
    normalValid,
  );
  writeMarker(
    output.markers,
    NavballMarkerIndex.ANTINORMAL,
    -normalUnitX,
    -normalUnitY,
    -normalUnitZ,
    normalValid,
  );
  writeMarker(
    output.markers,
    NavballMarkerIndex.RADIAL_OUT,
    radialUnitX,
    radialUnitY,
    radialUnitZ,
    true,
  );
  writeMarker(
    output.markers,
    NavballMarkerIndex.RADIAL_IN,
    -radialUnitX,
    -radialUnitY,
    -radialUnitZ,
    true,
  );

  const radialLocalX =
    inertialFromLocal.xx * radialUnitX +
    inertialFromLocal.yx * radialUnitY +
    inertialFromLocal.zx * radialUnitZ;
  const radialLocalY =
    inertialFromLocal.xy * radialUnitX +
    inertialFromLocal.yy * radialUnitY +
    inertialFromLocal.zy * radialUnitZ;
  const radialLocalZ =
    inertialFromLocal.xz * radialUnitX +
    inertialFromLocal.yz * radialUnitY +
    inertialFromLocal.zz * radialUnitZ;
  output.horizonAngleDeg = Math.atan2(radialLocalY, radialLocalZ) * RADIANS_TO_DEGREES;
  output.horizonOffset = radialLocalX * 100;
  output.horizonScaleY = Math.abs(radialLocalX);

  const thrustX = snapshot.shipProperAccelerationKmS2[0] as number;
  const thrustY = snapshot.shipProperAccelerationKmS2[1] as number;
  const thrustZ = snapshot.shipProperAccelerationKmS2[2] as number;
  const thrustMagnitude = Math.hypot(thrustX, thrustY, thrustZ);
  if (Number.isFinite(thrustMagnitude) && thrustMagnitude > 0) {
    const thrustUnitX = thrustX / thrustMagnitude;
    const thrustUnitY = thrustY / thrustMagnitude;
    const thrustUnitZ = thrustZ / thrustMagnitude;
    const thrustLocalX =
      inertialFromLocal.xx * thrustUnitX +
      inertialFromLocal.yx * thrustUnitY +
      inertialFromLocal.zx * thrustUnitZ;
    output.thrustX =
      inertialFromLocal.xy * thrustUnitX +
      inertialFromLocal.yy * thrustUnitY +
      inertialFromLocal.zy * thrustUnitZ;
    output.thrustY = -(
      inertialFromLocal.xz * thrustUnitX +
      inertialFromLocal.yz * thrustUnitY +
      inertialFromLocal.zz * thrustUnitZ
    );
    output.thrustVisible = thrustLocalX >= -FRONT_HEMISPHERE_EPSILON ? 1 : 0;
  }
  output.valid = true;
  return output;
}
