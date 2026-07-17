import { describe, expect, it } from 'vitest';

import { createSimulationSnapshotBuffer } from '../simulationSnapshot.js';
import { createOsculatingWorkspace, updateOsculatingElements } from './osculating.js';

const EARTH_MU_KM3_S2 = 398_600.4418;

describe('osculating snapshot — physics-spec.md §6 / §7.1', () => {
  it('recovers an analytic circular orbit around the dominant body', () => {
    const radiusKm = 6_778.137;
    const snapshot = createSimulationSnapshotBuffer(Object.freeze(['earth']));
    snapshot.shipState[0] = radiusKm;
    snapshot.shipCoordinateVelocityKmS[1] = Math.sqrt(EARTH_MU_KM3_S2 / radiusKm);

    updateOsculatingElements(
      snapshot,
      new Float64Array([EARTH_MU_KM3_S2]),
      createOsculatingWorkspace(),
    );

    expect(snapshot.dominantBodyIndex).toBe(0);
    expect(snapshot.osculatingElements.valid).toBe(true);
    expect(snapshot.osculatingElements.semiMajorAxisKm).toBeCloseTo(radiusKm, 10);
    expect(snapshot.osculatingElements.eccentricity).toBe(0);
    expect(snapshot.osculatingElements.inclinationRad).toBe(0);
    expect(snapshot.osculatingElements.trueAnomalyRad).toBe(0);
    expect(snapshot.osculatingElements.periapsisRadiusKm).toBeCloseTo(radiusKm, 10);
    expect(snapshot.osculatingElements.apoapsisRadiusKm).toBeCloseTo(radiusKm, 10);
    expect(snapshot.osculatingElements.periodSec).toBeCloseTo(
      2 * Math.PI * Math.sqrt(radiusKm ** 3 / EARTH_MU_KM3_S2),
      10,
    );
  });

  it('publishes an open hyperbolic periapsis with infinite apoapsis and period', () => {
    const periapsisRadiusKm = 7_000;
    const eccentricity = 1.5;
    const semiMajorAxisKm = -periapsisRadiusKm / (eccentricity - 1);
    const periapsisSpeedKmS = Math.sqrt(
      EARTH_MU_KM3_S2 * (2 / periapsisRadiusKm - 1 / semiMajorAxisKm),
    );
    const snapshot = createSimulationSnapshotBuffer(Object.freeze(['earth']));
    snapshot.shipState[0] = periapsisRadiusKm;
    snapshot.shipCoordinateVelocityKmS[1] = periapsisSpeedKmS;

    updateOsculatingElements(
      snapshot,
      new Float64Array([EARTH_MU_KM3_S2]),
      createOsculatingWorkspace(),
    );

    expect(snapshot.osculatingElements.valid).toBe(true);
    expect(snapshot.osculatingElements.semiMajorAxisKm).toBeCloseTo(semiMajorAxisKm, 10);
    expect(snapshot.osculatingElements.eccentricity).toBeCloseTo(eccentricity, 14);
    expect(snapshot.osculatingElements.trueAnomalyRad).toBeCloseTo(0, 14);
    expect(snapshot.osculatingElements.periapsisRadiusKm).toBeCloseTo(periapsisRadiusKm, 10);
    expect(snapshot.osculatingElements.apoapsisRadiusKm).toBe(Number.POSITIVE_INFINITY);
    expect(snapshot.osculatingElements.periodSec).toBe(Number.POSITIVE_INFINITY);
  });
});
