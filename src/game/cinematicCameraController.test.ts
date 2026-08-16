import { describe, expect, it } from 'vitest';

import {
  CINEMATIC_DRIFT_IDLE_DELAY_SEC,
  CINEMATIC_DRIFT_RATE_RAD_PER_SEC,
  CINEMATIC_MAX_FOV_DEG,
  CINEMATIC_MIN_FOV_DEG,
  CinematicCameraController,
} from './cinematicCameraController.js';
import { OrbitCameraController, type CameraFocusTarget } from './orbitCameraController.js';

const AU_KM = 149_597_870.7;
const SHIP_BOUNDING_RADIUS_KM = 26.12e-3 / 2;
const BASE_FOV_DEG = 75;
const FRAME_SEC = 1 / 60;

interface Harness {
  readonly cinematic: CinematicCameraController;
  readonly orbit: OrbitCameraController;
  step(seconds: number, active?: boolean): void;
}

function createHarness(): Harness {
  const positionsKm = new Float64Array([AU_KM, 0, 0]);
  const targets: readonly CameraFocusTarget[] = [
    { id: 'ship', positionOffset: 0, meanRadiusKm: SHIP_BOUNDING_RADIUS_KM },
  ];
  const orbit = new OrbitCameraController({
    positionsKm,
    targets,
    initialFocusId: 'ship',
    initialCameraPositionKm: { x: AU_KM + 0.05, y: 0.02, z: 0.03 },
  });
  const cinematic = new CinematicCameraController({ orbit, baseFovDeg: BASE_FOV_DEG });
  return {
    cinematic,
    orbit,
    step(seconds: number, active = true): void {
      const frames = Math.max(1, Math.round(seconds / FRAME_SEC));
      for (let frame = 0; frame < frames; frame += 1) {
        orbit.update(FRAME_SEC);
        cinematic.update(FRAME_SEC, active);
      }
    },
  };
}

function dot(
  left: Readonly<{ x: number; y: number; z: number }>,
  right: Readonly<{ x: number; y: number; z: number }>,
): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function length(vector: Readonly<{ x: number; y: number; z: number }>): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

describe('CinematicCameraController', () => {
  it('publishes the orbit pose with an orthonormal, ecliptic-north up vector', () => {
    const { cinematic, orbit } = createHarness();
    expect(cinematic.cameraPositionKm).toBe(orbit.cameraPositionKm);
    expect(cinematic.lookDirection).toBe(orbit.lookDirection);
    expect(length(cinematic.upDirection)).toBeCloseTo(1, 12);
    expect(dot(cinematic.upDirection, cinematic.lookDirection)).toBeCloseTo(0, 12);
    // Above the ecliptic looking down at the ship, "up" still points north.
    expect(cinematic.upDirection.z).toBeGreaterThan(0);
  });

  it('rolls the up vector about the look axis and stays orthonormal', () => {
    const { cinematic } = createHarness();
    const startX = cinematic.upDirection.x;
    const startY = cinematic.upDirection.y;
    const startZ = cinematic.upDirection.z;

    cinematic.rollBy(Math.PI / 2);
    expect(cinematic.rollRad).toBeCloseTo(Math.PI / 2, 12);
    expect(length(cinematic.upDirection)).toBeCloseTo(1, 12);
    expect(dot(cinematic.upDirection, cinematic.lookDirection)).toBeCloseTo(0, 12);
    // A quarter turn takes it exactly onto look x up.
    const look = cinematic.lookDirection;
    expect(cinematic.upDirection.x).toBeCloseTo(look.y * startZ - look.z * startY, 12);
    expect(cinematic.upDirection.y).toBeCloseTo(look.z * startX - look.x * startZ, 12);
    expect(cinematic.upDirection.z).toBeCloseTo(look.x * startY - look.y * startX, 12);

    // Rolling the rest of the way round comes back to where it started.
    cinematic.rollBy(-Math.PI / 2);
    expect(cinematic.upDirection.x).toBeCloseTo(startX, 12);
    expect(cinematic.upDirection.y).toBeCloseTo(startY, 12);
    expect(cinematic.upDirection.z).toBeCloseTo(startZ, 12);
  });

  it('holds the field of view inside the 20 to 90 degree envelope', () => {
    const { cinematic } = createHarness();
    expect(cinematic.fovDeg).toBe(BASE_FOV_DEG);

    cinematic.adjustFovBy(500);
    expect(cinematic.fovDeg).toBe(CINEMATIC_MAX_FOV_DEG);
    cinematic.adjustFovBy(-500);
    expect(cinematic.fovDeg).toBe(CINEMATIC_MIN_FOV_DEG);
    cinematic.adjustFovBy(15);
    expect(cinematic.fovDeg).toBeCloseTo(CINEMATIC_MIN_FOV_DEG + 15, 12);
  });

  it('starts a slow yaw drift only after the idle delay, and only while active', () => {
    const idle = createHarness();
    const beforeDelayX = idle.orbit.cameraPositionKm.x;
    idle.step(CINEMATIC_DRIFT_IDLE_DELAY_SEC - 0.5);
    expect(idle.cinematic.drifting).toBe(false);
    expect(idle.orbit.cameraPositionKm.x).toBe(beforeDelayX);

    idle.step(2);
    expect(idle.cinematic.drifting).toBe(true);
    expect(idle.orbit.cameraPositionKm.x).not.toBe(beforeDelayX);

    const inactive = createHarness();
    const inactiveX = inactive.orbit.cameraPositionKm.x;
    inactive.step(30, false);
    expect(inactive.cinematic.drifting).toBe(false);
    expect(inactive.orbit.cameraPositionKm.x).toBe(inactiveX);
  });

  it('drifts at the published rate and restarts the idle clock on any input', () => {
    const { cinematic, orbit } = createHarness();
    const startX = orbit.cameraPositionKm.x - AU_KM;
    const startY = orbit.cameraPositionKm.y;
    const startAzimuth = Math.atan2(startY, startX);

    // Reach the drift, then drift for exactly one second of wall time.
    for (
      let frame = 0;
      frame < Math.round(CINEMATIC_DRIFT_IDLE_DELAY_SEC / FRAME_SEC);
      frame += 1
    ) {
      cinematic.update(FRAME_SEC, true);
    }
    const driftStartAzimuth = Math.atan2(
      orbit.cameraPositionKm.y,
      orbit.cameraPositionKm.x - AU_KM,
    );
    for (let frame = 0; frame < 60; frame += 1) cinematic.update(FRAME_SEC, true);
    const driftedAzimuth = Math.atan2(orbit.cameraPositionKm.y, orbit.cameraPositionKm.x - AU_KM);
    expect(driftedAzimuth - driftStartAzimuth).toBeCloseTo(CINEMATIC_DRIFT_RATE_RAD_PER_SEC, 6);
    expect(startAzimuth).not.toBe(driftedAzimuth);

    // Any input parks the drift again for the full delay.
    cinematic.rollBy(0.1);
    expect(cinematic.drifting).toBe(false);
    const parkedAzimuth = Math.atan2(orbit.cameraPositionKm.y, orbit.cameraPositionKm.x - AU_KM);
    for (let frame = 0; frame < Math.round(1 / FRAME_SEC); frame += 1) {
      cinematic.update(FRAME_SEC, true);
    }
    expect(Math.atan2(orbit.cameraPositionKm.y, orbit.cameraPositionKm.x - AU_KM)).toBeCloseTo(
      parkedAzimuth,
      12,
    );
  });

  it('rejects non-finite input and publishes into one preallocated vector', () => {
    const { cinematic } = createHarness();
    const up = cinematic.upDirection;
    expect(() => cinematic.rollBy(Number.NaN)).toThrow(RangeError);
    expect(() => cinematic.adjustFovBy(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => cinematic.update(-1, true)).toThrow(RangeError);
    cinematic.update(FRAME_SEC, true);
    cinematic.rollBy(0.3);
    expect(cinematic.upDirection).toBe(up);
  });
});
