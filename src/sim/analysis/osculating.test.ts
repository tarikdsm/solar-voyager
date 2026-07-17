import { describe, expect, it } from 'vitest';

import {
  createCartesianState,
  createOrbitalConversionScratch,
  createOrbitalElements,
  elementsToStateInto,
  type OrbitalElements,
} from '../bodies/orbitalElements.js';
import { createSimulationSnapshotBuffer } from '../simulationSnapshot.js';
import { createOsculatingWorkspace, updateOsculatingElements } from './osculating.js';

const EARTH_MU_KM3_S2 = 398_600.4418;

function snapshotFromElements(elements: OrbitalElements) {
  const state = elementsToStateInto(
    createCartesianState(),
    elements,
    EARTH_MU_KM3_S2,
    createOrbitalConversionScratch(),
  );
  const snapshot = createSimulationSnapshotBuffer(Object.freeze(['earth']));
  snapshot.shipState.set([state.positionKm.x, state.positionKm.y, state.positionKm.z]);
  snapshot.shipCoordinateVelocityKmS.set([
    state.velocityKmS.x,
    state.velocityKmS.y,
    state.velocityKmS.z,
  ]);
  return snapshot;
}

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

  it('reconstructs nonzero true anomaly for an inclined eccentric orbit', () => {
    const eccentricity = 0.4;
    const expectedTrueAnomalyRad = 1.1;
    const eccentricAnomalyRad =
      2 *
      Math.atan2(
        Math.sqrt(1 - eccentricity) * Math.sin(expectedTrueAnomalyRad / 2),
        Math.sqrt(1 + eccentricity) * Math.cos(expectedTrueAnomalyRad / 2),
      );
    const elements = createOrbitalElements();
    elements.semiMajorAxisKm = 18_000;
    elements.eccentricity = eccentricity;
    elements.inclinationRad = 0.7;
    elements.longitudeAscendingNodeRad = 0.4;
    elements.argumentPeriapsisRad = 0.9;
    elements.meanAnomalyRad = eccentricAnomalyRad - eccentricity * Math.sin(eccentricAnomalyRad);
    const snapshot = snapshotFromElements(elements);

    updateOsculatingElements(
      snapshot,
      new Float64Array([EARTH_MU_KM3_S2]),
      createOsculatingWorkspace(),
    );

    expect(snapshot.osculatingElements.valid).toBe(true);
    expect(snapshot.osculatingElements.eccentricity).toBeCloseTo(eccentricity, 14);
    expect(snapshot.osculatingElements.inclinationRad).toBeCloseTo(0.7, 14);
    expect(snapshot.osculatingElements.longitudeAscendingNodeRad).toBeCloseTo(0.4, 14);
    expect(snapshot.osculatingElements.argumentPeriapsisRad).toBeCloseTo(0.9, 14);
    expect(snapshot.osculatingElements.trueAnomalyRad).toBeCloseTo(expectedTrueAnomalyRad, 14);
  });

  it('keeps circular-inclined argument of latitude through the public snapshot', () => {
    const elements = createOrbitalElements();
    elements.semiMajorAxisKm = 12_000;
    elements.eccentricity = 0;
    elements.inclinationRad = 0.5;
    elements.longitudeAscendingNodeRad = 0.3;
    elements.argumentPeriapsisRad = 0;
    elements.meanAnomalyRad = 0.8;
    const snapshot = snapshotFromElements(elements);

    updateOsculatingElements(
      snapshot,
      new Float64Array([EARTH_MU_KM3_S2]),
      createOsculatingWorkspace(),
    );

    expect(snapshot.osculatingElements.valid).toBe(true);
    expect(snapshot.osculatingElements.eccentricity).toBe(0);
    expect(snapshot.osculatingElements.inclinationRad).toBeCloseTo(0.5, 14);
    expect(snapshot.osculatingElements.longitudeAscendingNodeRad).toBeCloseTo(0.3, 14);
    expect(snapshot.osculatingElements.argumentPeriapsisRad).toBe(0);
    expect(snapshot.osculatingElements.trueAnomalyRad).toBeCloseTo(0.8, 14);
  });
});
