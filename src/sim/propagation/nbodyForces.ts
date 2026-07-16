// physics-spec.md §3 — Newtonian n-body acceleration on the ship.

/**
 * Writes the acceleration from all packed point masses without allocating.
 * Point and output use XYZ in their first three float64 components.
 */
export function evaluateNBodyAccelerationInto(
  outputAccelerationKmS2: Float64Array,
  pointPositionKm: Float64Array,
  bodyMuKm3S2: Float64Array,
  bodyPositionsKm: Float64Array,
): Float64Array {
  if (outputAccelerationKmS2.length < 3) {
    throw new RangeError('n-body output must contain at least 3 components');
  }
  if (pointPositionKm.length < 3) {
    throw new RangeError('n-body point must contain at least 3 components');
  }
  const expectedBodyPositionComponents = bodyMuKm3S2.length * 3;
  if (bodyPositionsKm.length !== expectedBodyPositionComponents) {
    throw new RangeError(
      `n-body body positions must contain ${expectedBodyPositionComponents} components`,
    );
  }

  const pointXKm = pointPositionKm[0] as number;
  const pointYKm = pointPositionKm[1] as number;
  const pointZKm = pointPositionKm[2] as number;
  let accelerationXKmS2 = 0;
  let accelerationYKmS2 = 0;
  let accelerationZKmS2 = 0;
  let correctionXKmS2 = 0;
  let correctionYKmS2 = 0;
  let correctionZKmS2 = 0;

  for (let bodyIndex = 0; bodyIndex < bodyMuKm3S2.length; bodyIndex += 1) {
    const componentIndex = bodyIndex * 3;
    const dxKm = (bodyPositionsKm[componentIndex] as number) - pointXKm;
    const dyKm = (bodyPositionsKm[componentIndex + 1] as number) - pointYKm;
    const dzKm = (bodyPositionsKm[componentIndex + 2] as number) - pointZKm;
    const distanceSquaredKm2 = dxKm * dxKm + dyKm * dyKm + dzKm * dzKm;
    if (distanceSquaredKm2 === 0) {
      outputAccelerationKmS2[0] = Number.NaN;
      outputAccelerationKmS2[1] = Number.NaN;
      outputAccelerationKmS2[2] = Number.NaN;
      return outputAccelerationKmS2;
    }

    const inverseDistanceCubedKm3 = 1 / (distanceSquaredKm2 * Math.sqrt(distanceSquaredKm2));
    const accelerationFactorS2 = (bodyMuKm3S2[bodyIndex] as number) * inverseDistanceCubedKm3;

    const adjustedXKmS2 = dxKm * accelerationFactorS2 - correctionXKmS2;
    const nextAccelerationXKmS2 = accelerationXKmS2 + adjustedXKmS2;
    correctionXKmS2 = nextAccelerationXKmS2 - accelerationXKmS2 - adjustedXKmS2;
    accelerationXKmS2 = nextAccelerationXKmS2;

    const adjustedYKmS2 = dyKm * accelerationFactorS2 - correctionYKmS2;
    const nextAccelerationYKmS2 = accelerationYKmS2 + adjustedYKmS2;
    correctionYKmS2 = nextAccelerationYKmS2 - accelerationYKmS2 - adjustedYKmS2;
    accelerationYKmS2 = nextAccelerationYKmS2;

    const adjustedZKmS2 = dzKm * accelerationFactorS2 - correctionZKmS2;
    const nextAccelerationZKmS2 = accelerationZKmS2 + adjustedZKmS2;
    correctionZKmS2 = nextAccelerationZKmS2 - accelerationZKmS2 - adjustedZKmS2;
    accelerationZKmS2 = nextAccelerationZKmS2;
  }

  outputAccelerationKmS2[0] = accelerationXKmS2;
  outputAccelerationKmS2[1] = accelerationYKmS2;
  outputAccelerationKmS2[2] = accelerationZKmS2;
  return outputAccelerationKmS2;
}
