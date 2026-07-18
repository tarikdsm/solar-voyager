import { STATE_RX, STATE_RY, STATE_RZ } from '../ship/relativity.js';

export interface TrajectoryImpactResult {
  bodyIndex: number;
  fraction: number;
}

/** Setup-allocated storage reused for every accepted predictor step. */
export interface TrajectoryImpactWorkspace {
  readonly bodyCount: number;
  readonly startBodyPositionsKm: Float64Array;
  readonly result: TrajectoryImpactResult;
}

/** Allocates body-relative segment storage once for one prediction job. */
export function createTrajectoryImpactWorkspace(bodyCount: number): TrajectoryImpactWorkspace {
  if (!Number.isInteger(bodyCount) || bodyCount < 0) {
    throw new RangeError('trajectory impact body count must be a non-negative integer');
  }
  return {
    bodyCount,
    startBodyPositionsKm: new Float64Array(bodyCount * 3),
    result: { bodyIndex: -1, fraction: Number.POSITIVE_INFINITY },
  };
}

/** Captures rails positions before an accepted DP54 step without allocating. */
export function captureTrajectoryImpactStepStart(
  workspace: TrajectoryImpactWorkspace,
  bodyPositionsKm: Float64Array,
): void {
  if (bodyPositionsKm.length !== workspace.startBodyPositionsKm.length) {
    throw new RangeError(
      `trajectory impact body positions must contain ${workspace.startBodyPositionsKm.length} components`,
    );
  }
  workspace.startBodyPositionsKm.set(bodyPositionsKm);
}

function smallestUnitRoot(halfB: number, a: number, c: number): number {
  const discriminant = halfB * halfB - a * c;
  if (discriminant < 0 || a === 0) return Number.POSITIVE_INFINITY;

  const squareRoot = Math.sqrt(discriminant);
  const q = -halfB - (halfB < 0 ? -squareRoot : squareRoot);
  if (q === 0) {
    const root = -halfB / a;
    return root >= 0 && root <= 1 ? root : Number.POSITIVE_INFINITY;
  }

  const firstRoot = q / a;
  const secondRoot = c / q;
  let selectedRoot = Number.POSITIVE_INFINITY;
  if (firstRoot >= 0 && firstRoot <= 1) selectedRoot = firstRoot;
  if (secondRoot >= 0 && secondRoot <= 1 && secondRoot < selectedRoot) {
    selectedRoot = secondRoot;
  }
  return selectedRoot;
}

/**
 * Finds the first body-relative segment/sphere crossing from physics-spec.md section 6.
 * The returned result belongs to `workspace` and is overwritten on the next call.
 */
export function findFirstTrajectoryImpactInto(
  workspace: TrajectoryImpactWorkspace,
  startShipXKm: number,
  startShipYKm: number,
  startShipZKm: number,
  endShipState: Float64Array,
  endBodyPositionsKm: Float64Array,
  collisionRadiiKm: Float64Array,
): TrajectoryImpactResult {
  const expectedBodyComponents = workspace.bodyCount * 3;
  if (
    endBodyPositionsKm.length !== expectedBodyComponents ||
    collisionRadiiKm.length !== workspace.bodyCount
  ) {
    throw new RangeError('trajectory impact storage must match body count');
  }

  const result = workspace.result;
  result.bodyIndex = -1;
  result.fraction = Number.POSITIVE_INFINITY;
  const endShipXKm = endShipState[STATE_RX] as number;
  const endShipYKm = endShipState[STATE_RY] as number;
  const endShipZKm = endShipState[STATE_RZ] as number;

  // physics-spec.md section 6: |r0 + f * (r1 - r0)|^2 = R^2.
  for (let bodyIndex = 0; bodyIndex < workspace.bodyCount; bodyIndex += 1) {
    const offset = bodyIndex * 3;
    const r0xKm = startShipXKm - (workspace.startBodyPositionsKm[offset] as number);
    const r0yKm = startShipYKm - (workspace.startBodyPositionsKm[offset + 1] as number);
    const r0zKm = startShipZKm - (workspace.startBodyPositionsKm[offset + 2] as number);
    const radiusKm = collisionRadiiKm[bodyIndex] as number;
    const c = r0xKm * r0xKm + r0yKm * r0yKm + r0zKm * r0zKm - radiusKm * radiusKm;
    if (c <= 0) continue;

    const r1xKm = endShipXKm - (endBodyPositionsKm[offset] as number);
    const r1yKm = endShipYKm - (endBodyPositionsKm[offset + 1] as number);
    const r1zKm = endShipZKm - (endBodyPositionsKm[offset + 2] as number);
    const dxKm = r1xKm - r0xKm;
    const dyKm = r1yKm - r0yKm;
    const dzKm = r1zKm - r0zKm;
    const a = dxKm * dxKm + dyKm * dyKm + dzKm * dzKm;
    const halfB = r0xKm * dxKm + r0yKm * dyKm + r0zKm * dzKm;
    const fraction = smallestUnitRoot(halfB, a, c);
    if (fraction < result.fraction) {
      result.bodyIndex = bodyIndex;
      result.fraction = fraction;
    }
  }
  return result;
}

/** Replaces the propagated endpoint position with the segment crossing position. */
export function interpolateTrajectoryImpactPositionInto(
  state: Float64Array,
  startXKm: number,
  startYKm: number,
  startZKm: number,
  fraction: number,
): void {
  state[STATE_RX] = startXKm + fraction * ((state[STATE_RX] as number) - startXKm);
  state[STATE_RY] = startYKm + fraction * ((state[STATE_RY] as number) - startYKm);
  state[STATE_RZ] = startZKm + fraction * ((state[STATE_RZ] as number) - startZKm);
}

/** Returns the sampled target-centre distance without allocating. */
export function trajectoryDistanceToBodyKm(
  shipState: Float64Array,
  bodyPositionsKm: Float64Array,
  bodyIndex: number,
): number {
  const bodyOffset = bodyIndex * 3;
  return Math.hypot(
    (shipState[STATE_RX] as number) - (bodyPositionsKm[bodyOffset] as number),
    (shipState[STATE_RY] as number) - (bodyPositionsKm[bodyOffset + 1] as number),
    (shipState[STATE_RZ] as number) - (bodyPositionsKm[bodyOffset + 2] as number),
  );
}
