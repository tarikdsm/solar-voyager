import { describe, expect, it } from 'vitest';

import { writeQuaternionFromForwardInto } from '../sim/ship/attitude.js';
import { createSimulationSnapshotBuffer } from '../sim/simulationSnapshot.js';
import {
  createNavballProjectionBuffer,
  NAVBALL_MARKER_COMPONENTS,
  NavballMarkerIndex,
  writeNavballProjectionInto,
} from './navballProjection.js';

function createLeoSnapshot() {
  const snapshot = createSimulationSnapshotBuffer(Object.freeze(['earth']));
  snapshot.dominantBodyIndex = 0;
  snapshot.shipState[0] = 6_778.137;
  snapshot.shipCoordinateVelocityKmS[1] = 7.668_558;
  snapshot.shipProperAccelerationKmS2[0] = 0.009_806_65;
  return snapshot;
}

function expectMarker(
  markers: Float64Array,
  markerIndex: NavballMarkerIndex,
  expectedX: number,
  expectedY: number,
  expectedVisible: number,
): void {
  const offset = markerIndex * NAVBALL_MARKER_COMPONENTS;
  expect(markers[offset]).toBeCloseTo(expectedX, 12);
  expect(markers[offset + 1]).toBeCloseTo(expectedY, 12);
  expect(markers[offset + 2]).toBe(expectedVisible);
}

describe('navball projection — physics-spec §3.0.1 orbital frame', () => {
  it('projects every marker against a known circular equatorial LEO frame', () => {
    const snapshot = createLeoSnapshot();
    const projection = createNavballProjectionBuffer();

    expect(writeNavballProjectionInto(projection, snapshot)).toBe(projection);
    expect(projection.valid).toBe(true);
    expectMarker(projection.markers, NavballMarkerIndex.PROGRADE, 1, 0, 1);
    expectMarker(projection.markers, NavballMarkerIndex.RETROGRADE, -1, 0, 1);
    expectMarker(projection.markers, NavballMarkerIndex.NORMAL, 0, -1, 1);
    expectMarker(projection.markers, NavballMarkerIndex.ANTINORMAL, 0, 1, 1);
    expectMarker(projection.markers, NavballMarkerIndex.RADIAL_OUT, 0, 0, 1);
    expectMarker(projection.markers, NavballMarkerIndex.RADIAL_IN, 0, 0, 0);
    expect(projection.horizonAngleDeg).toBe(0);
    expect(projection.horizonOffset).toBeCloseTo(100, 12);
    expect(projection.horizonScaleY).toBeCloseTo(1, 12);
    expect(projection.thrustX).toBeCloseTo(0, 12);
    expect(projection.thrustY).toBeCloseTo(0, 12);
    expect(projection.thrustVisible).toBe(1);
  });

  it('inverse-rotates inertial directions through the ship attitude quaternion', () => {
    const snapshot = createLeoSnapshot();
    const projection = createNavballProjectionBuffer();
    writeQuaternionFromForwardInto(snapshot.attitudeQuaternion, 0, 1, 0);

    writeNavballProjectionInto(projection, snapshot);

    expectMarker(projection.markers, NavballMarkerIndex.PROGRADE, 0, 0, 1);
    expectMarker(projection.markers, NavballMarkerIndex.RETROGRADE, 0, 0, 0);
    expectMarker(projection.markers, NavballMarkerIndex.RADIAL_OUT, -1, 0, 1);
  });

  it('projects the proper-acceleration thrust cue through the same frame', () => {
    const snapshot = createLeoSnapshot();
    const projection = createNavballProjectionBuffer();
    snapshot.shipProperAccelerationKmS2.fill(0);
    snapshot.shipProperAccelerationKmS2[2] = 0.009_806_65;

    writeNavballProjectionInto(projection, snapshot);

    expect(projection.thrustX).toBeCloseTo(0, 12);
    expect(projection.thrustY).toBeCloseTo(-1, 12);
    expect(projection.thrustVisible).toBe(1);
  });

  it('clears visibility and preserves finite storage for invalid or degenerate frames', () => {
    const snapshot = createLeoSnapshot();
    const projection = createNavballProjectionBuffer();
    snapshot.dominantBodyIndex = -1;

    writeNavballProjectionInto(projection, snapshot);

    expect(projection.valid).toBe(false);
    expect(projection.thrustVisible).toBe(0);
    for (let index = 0; index < projection.markers.length; index += 1) {
      expect(Number.isFinite(projection.markers[index])).toBe(true);
      if (index % NAVBALL_MARKER_COMPONENTS === 2) expect(projection.markers[index]).toBe(0);
    }

    snapshot.dominantBodyIndex = 0;
    snapshot.shipState.fill(0);
    writeNavballProjectionInto(projection, snapshot);
    expect(projection.valid).toBe(false);
  });
});
