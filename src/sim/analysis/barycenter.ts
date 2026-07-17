// physics-spec.md §6 — solar-system center of mass from GM-weighted rails.

function validateBuffers(
  positionOutKm: Float64Array,
  velocityOutKmS: Float64Array,
  bodyMuKm3S2: Float64Array,
  bodyPositionsKm: Float64Array,
  bodyVelocitiesKmS: Float64Array,
): void {
  if (positionOutKm.length < 3 || velocityOutKmS.length < 3) {
    throw new RangeError('barycenter outputs must contain at least three components');
  }

  const componentCount = bodyMuKm3S2.length * 3;
  if (bodyPositionsKm.length !== componentCount) {
    throw new RangeError(`barycenter requires ${componentCount} packed position components`);
  }
  if (bodyVelocitiesKmS.length !== componentCount) {
    throw new RangeError(`barycenter requires ${componentCount} packed velocity components`);
  }
}

/**
 * Writes the GM-weighted position and velocity of the catalog barycenter.
 * GM is a valid mass weight because the common gravitational constant cancels.
 */
export function evaluateBarycenterInto(
  positionOutKm: Float64Array,
  velocityOutKmS: Float64Array,
  bodyMuKm3S2: Float64Array,
  bodyPositionsKm: Float64Array,
  bodyVelocitiesKmS: Float64Array,
): Float64Array {
  validateBuffers(positionOutKm, velocityOutKmS, bodyMuKm3S2, bodyPositionsKm, bodyVelocitiesKmS);

  let totalMuKm3S2 = 0;
  let totalMuCorrection = 0;
  let positionXWeighted = 0;
  let positionXCorrection = 0;
  let positionYWeighted = 0;
  let positionYCorrection = 0;
  let positionZWeighted = 0;
  let positionZCorrection = 0;
  let velocityXWeighted = 0;
  let velocityXCorrection = 0;
  let velocityYWeighted = 0;
  let velocityYCorrection = 0;
  let velocityZWeighted = 0;
  let velocityZCorrection = 0;

  for (let bodyIndex = 0; bodyIndex < bodyMuKm3S2.length; bodyIndex += 1) {
    const muKm3S2 = bodyMuKm3S2[bodyIndex] as number;
    const componentIndex = bodyIndex * 3;
    let adjusted = muKm3S2 - totalMuCorrection;
    let next = totalMuKm3S2 + adjusted;
    totalMuCorrection = next - totalMuKm3S2 - adjusted;
    totalMuKm3S2 = next;

    adjusted = muKm3S2 * (bodyPositionsKm[componentIndex] as number) - positionXCorrection;
    next = positionXWeighted + adjusted;
    positionXCorrection = next - positionXWeighted - adjusted;
    positionXWeighted = next;

    adjusted = muKm3S2 * (bodyPositionsKm[componentIndex + 1] as number) - positionYCorrection;
    next = positionYWeighted + adjusted;
    positionYCorrection = next - positionYWeighted - adjusted;
    positionYWeighted = next;

    adjusted = muKm3S2 * (bodyPositionsKm[componentIndex + 2] as number) - positionZCorrection;
    next = positionZWeighted + adjusted;
    positionZCorrection = next - positionZWeighted - adjusted;
    positionZWeighted = next;

    adjusted = muKm3S2 * (bodyVelocitiesKmS[componentIndex] as number) - velocityXCorrection;
    next = velocityXWeighted + adjusted;
    velocityXCorrection = next - velocityXWeighted - adjusted;
    velocityXWeighted = next;

    adjusted = muKm3S2 * (bodyVelocitiesKmS[componentIndex + 1] as number) - velocityYCorrection;
    next = velocityYWeighted + adjusted;
    velocityYCorrection = next - velocityYWeighted - adjusted;
    velocityYWeighted = next;

    adjusted = muKm3S2 * (bodyVelocitiesKmS[componentIndex + 2] as number) - velocityZCorrection;
    next = velocityZWeighted + adjusted;
    velocityZCorrection = next - velocityZWeighted - adjusted;
    velocityZWeighted = next;
  }

  if (!Number.isFinite(totalMuKm3S2) || totalMuKm3S2 <= 0) {
    throw new RangeError('barycenter requires a finite positive total GM');
  }

  const inverseTotalMu = 1 / totalMuKm3S2;
  positionOutKm[0] = positionXWeighted * inverseTotalMu;
  positionOutKm[1] = positionYWeighted * inverseTotalMu;
  positionOutKm[2] = positionZWeighted * inverseTotalMu;
  velocityOutKmS[0] = velocityXWeighted * inverseTotalMu;
  velocityOutKmS[1] = velocityYWeighted * inverseTotalMu;
  velocityOutKmS[2] = velocityZWeighted * inverseTotalMu;
  return positionOutKm;
}
