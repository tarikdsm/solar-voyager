import type { SimulationSnapshotBuffer } from '../simulationSnapshot.js';
import {
  coordinateVelocityInto,
  lorentzFactorFromCelerity,
  speedFractionOfLightFromCelerity,
  STATE_RX,
  STATE_RY,
  STATE_RZ,
  STATE_TAU,
  STATE_UX,
  STATE_UY,
  STATE_UZ,
} from '../ship/relativity.js';

/** Writes all physics-spec.md §3/§6 relativistic snapshot derivatives in place. */
export function updateSnapshotDerivedState(
  snapshot: SimulationSnapshotBuffer,
  shipMassKg: number,
): void {
  if (!Number.isFinite(shipMassKg) || shipMassKg <= 0) {
    throw new RangeError('ship mass must be finite and positive');
  }

  const uxKmS = snapshot.shipState[STATE_UX] as number;
  const uyKmS = snapshot.shipState[STATE_UY] as number;
  const uzKmS = snapshot.shipState[STATE_UZ] as number;
  const gamma = lorentzFactorFromCelerity(uxKmS, uyKmS, uzKmS);
  coordinateVelocityInto(snapshot.shipCoordinateVelocityKmS, uxKmS, uyKmS, uzKmS);

  snapshot.shipProperTimeSec = snapshot.shipState[STATE_TAU] as number;
  snapshot.gamma = gamma;
  snapshot.speedFractionOfLight = speedFractionOfLightFromCelerity(uxKmS, uyKmS, uzKmS);

  const relativeVxKmS =
    (snapshot.shipCoordinateVelocityKmS[0] as number) -
    (snapshot.barycenterVelocityKmS[0] as number);
  const relativeVyKmS =
    (snapshot.shipCoordinateVelocityKmS[1] as number) -
    (snapshot.barycenterVelocityKmS[1] as number);
  const relativeVzKmS =
    (snapshot.shipCoordinateVelocityKmS[2] as number) -
    (snapshot.barycenterVelocityKmS[2] as number);
  snapshot.shipCmRelativeVelocityKmS[0] = relativeVxKmS;
  snapshot.shipCmRelativeVelocityKmS[1] = relativeVyKmS;
  snapshot.shipCmRelativeVelocityKmS[2] = relativeVzKmS;

  // physics-spec.md §6 — p = gamma*m*(v-v_cm).
  const massGamma = shipMassKg * gamma;
  const momentumXKgKmS = massGamma * relativeVxKmS;
  const momentumYKgKmS = massGamma * relativeVyKmS;
  const momentumZKgKmS = massGamma * relativeVzKmS;
  snapshot.shipRelativisticMomentumKgKmS[0] = momentumXKgKmS;
  snapshot.shipRelativisticMomentumKgKmS[1] = momentumYKgKmS;
  snapshot.shipRelativisticMomentumKgKmS[2] = momentumZKgKmS;

  // physics-spec.md §6 — L = (r-r_cm) × p.
  const relativeRxKm =
    (snapshot.shipState[STATE_RX] as number) - (snapshot.barycenterPositionKm[0] as number);
  const relativeRyKm =
    (snapshot.shipState[STATE_RY] as number) - (snapshot.barycenterPositionKm[1] as number);
  const relativeRzKm =
    (snapshot.shipState[STATE_RZ] as number) - (snapshot.barycenterPositionKm[2] as number);
  snapshot.shipAngularMomentumKgKm2S[0] =
    relativeRyKm * momentumZKgKmS - relativeRzKm * momentumYKgKmS;
  snapshot.shipAngularMomentumKgKm2S[1] =
    relativeRzKm * momentumXKgKmS - relativeRxKm * momentumZKgKmS;
  snapshot.shipAngularMomentumKgKm2S[2] =
    relativeRxKm * momentumYKgKmS - relativeRyKm * momentumXKgKmS;
}
