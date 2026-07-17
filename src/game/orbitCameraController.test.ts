import { describe, expect, it } from 'vitest';

import { OrbitCameraController, type CameraFocusTarget } from './orbitCameraController.js';

const EARTH_RADIUS_KM = 6_371.0084;
const JUPITER_RADIUS_KM = 69_911;
const TRANSFER_DURATION_SEC = 1.5;

const targets: readonly CameraFocusTarget[] = [
  { id: 'earth', positionOffset: 0, meanRadiusKm: EARTH_RADIUS_KM },
  { id: 'jupiter', positionOffset: 3, meanRadiusKm: JUPITER_RADIUS_KM },
];

function createFixture() {
  const earthX = 149_597_870.7;
  const earthY = -20_000_000;
  const earthZ = 1_000;
  const positionsKm = new Float64Array([
    earthX,
    earthY,
    earthZ,
    778_500_000,
    100_000_000,
    -5_000_000,
  ]);
  const initialDistanceKm = EARTH_RADIUS_KM + 400;
  const controller = new OrbitCameraController({
    positionsKm,
    targets,
    initialFocusId: 'earth',
    initialCameraPositionKm: {
      x: earthX + initialDistanceKm,
      y: earthY,
      z: earthZ,
    },
    transferDurationSec: TRANSFER_DURATION_SEC,
  });
  return { controller, initialDistanceKm, positionsKm };
}

describe('OrbitCameraController', () => {
  it('preserves the initial float64 camera and derives a unit look direction', () => {
    const { controller, initialDistanceKm, positionsKm } = createFixture();

    expect(controller.cameraPositionKm).toEqual({
      x: (positionsKm[0] ?? 0) + initialDistanceKm,
      y: positionsKm[1],
      z: positionsKm[2],
    });
    expect(controller.focusId).toBe('earth');
    expect(controller.distanceKm).toBeCloseTo(initialDistanceKm, 7);
    expect(controller.lookDirection.x).toBeCloseTo(-1, 14);
    expect(controller.lookDirection.y).toBeCloseTo(0, 14);
    expect(controller.lookDirection.z).toBeCloseTo(0, 14);
  });

  it('orbits without changing distance and clamps pitch short of the poles', () => {
    const { controller, initialDistanceKm } = createFixture();

    controller.orbitBy(0.5, Math.PI);

    expect(controller.distanceKm).toBeCloseTo(initialDistanceKm, 7);
    expect(
      Math.hypot(
        controller.lookDirection.x,
        controller.lookDirection.y,
        controller.lookDirection.z,
      ),
    ).toBeCloseTo(1, 14);
    expect(Math.abs(controller.lookDirection.z)).toBeLessThan(1);
  });

  it('zooms from a surface-safe clearance to the system-wide far range', () => {
    const { controller } = createFixture();

    controller.zoomByWheel(-1_000_000);
    const minimumDistanceKm = EARTH_RADIUS_KM + EARTH_RADIUS_KM * 1e-6;
    expect(controller.distanceKm).toBeCloseTo(minimumDistanceKm, 9);

    controller.zoomByWheel(1_000_000);
    expect(controller.distanceKm).toBe(1e10);
  });

  it('transfers smoothly from Earth to a live Jupiter endpoint', () => {
    const { controller, positionsKm } = createFixture();
    const startX = controller.cameraPositionKm.x;
    const startY = controller.cameraPositionKm.y;
    const startZ = controller.cameraPositionKm.z;

    expect(controller.focusBody('jupiter')).toBe(true);
    expect(controller.cameraPositionKm).toEqual({ x: startX, y: startY, z: startZ });

    controller.update(1e-6);
    expect(
      Math.hypot(
        controller.cameraPositionKm.x - startX,
        controller.cameraPositionKm.y - startY,
        controller.cameraPositionKm.z - startZ,
      ),
    ).toBeLessThan(1);

    controller.update(TRANSFER_DURATION_SEC / 2 - 1e-6);
    expect(controller.isTransitioning).toBe(true);
    expect(Number.isFinite(controller.cameraPositionKm.x)).toBe(true);
    expect(controller.distanceKm).toBeGreaterThan(JUPITER_RADIUS_KM * 3);

    positionsKm[3] = (positionsKm[3] ?? 0) + 12_345;
    positionsKm[4] = (positionsKm[4] ?? 0) - 6_789;
    controller.update(TRANSFER_DURATION_SEC / 2);

    expect(controller.isTransitioning).toBe(false);
    expect(controller.focusId).toBe('jupiter');
    expect(controller.focusPositionKm).toEqual({
      x: positionsKm[3],
      y: positionsKm[4],
      z: positionsKm[5],
    });
    expect(controller.distanceKm).toBeCloseTo(JUPITER_RADIUS_KM * 3, 7);
  });

  it('starts an interrupted transfer from the current interpolated state', () => {
    const { controller } = createFixture();
    controller.focusBody('jupiter');
    controller.update(0.6);
    const beforeX = controller.cameraPositionKm.x;
    const beforeY = controller.cameraPositionKm.y;
    const beforeZ = controller.cameraPositionKm.z;

    expect(controller.focusBody('earth')).toBe(true);

    expect(controller.cameraPositionKm).toEqual({ x: beforeX, y: beforeY, z: beforeZ });
    controller.update(0);
    expect(controller.cameraPositionKm).toEqual({ x: beforeX, y: beforeY, z: beforeZ });
  });

  it('keeps the arrival continuous when zoom reaches the surface limit mid-transfer', () => {
    const { controller } = createFixture();
    controller.focusBody('jupiter');
    controller.update(TRANSFER_DURATION_SEC / 2);
    controller.zoomByWheel(-1_000);
    controller.update(TRANSFER_DURATION_SEC / 2 - 0.001);
    const beforeX = controller.cameraPositionKm.x;
    const beforeY = controller.cameraPositionKm.y;
    const beforeZ = controller.cameraPositionKm.z;

    controller.update(0.001);

    expect(controller.isTransitioning).toBe(false);
    expect(controller.distanceKm).toBeCloseTo(JUPITER_RADIUS_KM + JUPITER_RADIUS_KM * 1e-6, 7);
    expect(
      Math.hypot(
        controller.cameraPositionKm.x - beforeX,
        controller.cameraPositionKm.y - beforeY,
        controller.cameraPositionKm.z - beforeZ,
      ),
    ).toBeLessThan(5);
  });

  it('cycles focus targets in both directions', () => {
    const { controller } = createFixture();

    expect(controller.cycleFocus(1)).toBe('jupiter');
    controller.update(TRANSFER_DURATION_SEC);
    expect(controller.cycleFocus(1)).toBe('earth');
    expect(controller.cycleFocus(-1)).toBe('jupiter');
  });

  it('has no numerical jitter on repeated surface-skimming frames', () => {
    const { controller, positionsKm } = createFixture();
    controller.zoomByWheel(-1_000_000);
    controller.orbitBy(0.731, 0.419);
    const expectedX = controller.cameraPositionKm.x;
    const expectedY = controller.cameraPositionKm.y;
    const expectedZ = controller.cameraPositionKm.z;

    for (let frame = 0; frame < 2_000; frame += 1) controller.update(1 / 60);

    expect(Object.is(controller.cameraPositionKm.x, expectedX)).toBe(true);
    expect(Object.is(controller.cameraPositionKm.y, expectedY)).toBe(true);
    expect(Object.is(controller.cameraPositionKm.z, expectedZ)).toBe(true);
    expect(
      Math.hypot(
        controller.cameraPositionKm.x - (positionsKm[0] ?? 0),
        controller.cameraPositionKm.y - (positionsKm[1] ?? 0),
        controller.cameraPositionKm.z - (positionsKm[2] ?? 0),
      ),
    ).toBeCloseTo(controller.distanceKm, 7);
  });

  it('rejects malformed targets and unknown focus ids', () => {
    const positionsKm = new Float64Array(3);
    expect(
      () =>
        new OrbitCameraController({
          positionsKm,
          targets: [{ id: 'bad', positionOffset: 1, meanRadiusKm: 1 }],
          initialFocusId: 'bad',
          initialCameraPositionKm: { x: 2, y: 0, z: 0 },
        }),
    ).toThrow(/position offset/u);

    const { controller } = createFixture();
    expect(controller.focusBody('saturn')).toBe(false);
  });

  it('rejects non-finite destination coordinates before and during a transfer', () => {
    const first = createFixture();
    first.positionsKm[3] = Number.NaN;
    expect(() => first.controller.focusBody('jupiter')).toThrow(/finite/u);

    const second = createFixture();
    second.controller.focusBody('jupiter');
    second.positionsKm[4] = Number.POSITIVE_INFINITY;
    expect(() => second.controller.update(0.1)).toThrow(/finite/u);
  });
});
