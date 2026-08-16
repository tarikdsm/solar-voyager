import { describe, expect, it } from 'vitest';

import bodiesDocument from '../../data/bodies.json';
import {
  DEFAULT_MAX_DISTANCE_KM,
  OrbitCameraController,
  minimumCameraDistanceKm,
  type CameraFocusTarget,
} from './orbitCameraController.js';

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
    expect(controller.focusPositionOffset).toBe(0);
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
    // T0129 — far enough out to frame the whole catalog, Eris included.
    expect(controller.distanceKm).toBe(2e10);
    expect(DEFAULT_MAX_DISTANCE_KM).toBe(2e10);
  });

  it('accepts a map-specific maximum distance without changing the space default', () => {
    const positionsKm = new Float64Array([0, 0, 0]);
    const controller = new OrbitCameraController({
      positionsKm,
      targets: [{ id: 'sun', positionOffset: 0, meanRadiusKm: 1 }],
      initialFocusId: 'sun',
      initialCameraPositionKm: { x: 2, y: 0, z: 0 },
      maxDistanceKm: 60_000_000_000,
    });

    controller.zoomByWheel(1_000_000);

    expect(controller.distanceKm).toBe(60_000_000_000);
    expect(createFixture().controller.distanceKm).toBeLessThan(DEFAULT_MAX_DISTANCE_KM);
  });

  it('transfers smoothly from Earth to a live Jupiter endpoint', () => {
    const { controller, positionsKm } = createFixture();
    const startX = controller.cameraPositionKm.x;
    const startY = controller.cameraPositionKm.y;
    const startZ = controller.cameraPositionKm.z;

    expect(controller.focusBody('jupiter')).toBe(true);
    expect(controller.focusPositionOffset).toBe(3);
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

/** Deterministic PRNG; the fuzz sweeps must reproduce byte-for-byte in CI. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Camera targets at real catalog scale.
 *
 * Radii are the catalog's own (696,000 km for the Sun down to sub-kilometre
 * asteroids); positions are each body's apoapsis distance, chained through its
 * parent, thrown onto a deterministic pseudo-random direction. That reproduces
 * what makes the raised range hard — spans from 1,700 km (Phobos framing) to
 * 2.9e10 km (opposite-side Eris), a ratio of 1.7e7 — without pretending to be
 * an ephemeris.
 */
function createCatalogTargets(): {
  readonly positionsKm: Float64Array;
  readonly targets: readonly CameraFocusTarget[];
} {
  const random = mulberry32(0x5f0a29d1);
  const bodyCount = bodiesDocument.bodies.length;
  const positionsKm = new Float64Array(bodyCount * 3);
  const targets: CameraFocusTarget[] = [];
  const apoapsisById = new Map<string, number>();
  for (let index = 0; index < bodyCount; index += 1) {
    const body = bodiesDocument.bodies[index];
    if (body === undefined) throw new Error('Catalog body array is sparse.');
    const elements = body.elements;
    const ownApoapsisKm =
      elements === null ? 0 : elements.semiMajorAxisKm * (1 + elements.eccentricity);
    const parentKm = body.parentId === null ? 0 : apoapsisById.get(body.parentId);
    if (parentKm === undefined) throw new Error(`Catalog parent "${body.parentId}" precedes.`);
    const distanceKm = ownApoapsisKm + parentKm;
    apoapsisById.set(body.id, distanceKm);

    const cosPolar = random() * 2 - 1;
    const azimuth = random() * Math.PI * 2;
    const sinPolar = Math.sqrt(Math.max(0, 1 - cosPolar * cosPolar));
    positionsKm[index * 3] = distanceKm * sinPolar * Math.cos(azimuth);
    positionsKm[index * 3 + 1] = distanceKm * sinPolar * Math.sin(azimuth);
    positionsKm[index * 3 + 2] = distanceKm * cosPolar;
    targets.push({
      id: body.id,
      positionOffset: index * 3,
      meanRadiusKm: body.meanRadiusKm,
    });
  }
  return { positionsKm, targets };
}

/**
 * T0129 — the raised 2e10 km range multiplies every span in the controller by
 * two, and the distance blend is `exp(log(start) + (log(end) - log(start)) * t)`.
 * A single zero or negative intermediate there is `-Infinity` into `exp`, and a
 * NaN camera position is permanent for the session. Earth-to-Jupiter unit tests
 * never reach the geometry that would expose it; every ordered pair in the real
 * catalog does.
 */
describe('OrbitCameraController focus-transition fuzz', () => {
  const { positionsKm, targets } = createCatalogTargets();
  const transferDurationSec = 1.5;

  function createController(focusId: string, distanceKm: number): OrbitCameraController {
    const target = targets.find((candidate) => candidate.id === focusId);
    if (target === undefined) throw new Error(`Unknown fuzz focus "${focusId}".`);
    const offset = target.positionOffset;
    return new OrbitCameraController({
      positionsKm,
      targets,
      initialFocusId: focusId,
      initialCameraPositionKm: {
        x: (positionsKm[offset] as number) + distanceKm,
        y: positionsKm[offset + 1] as number,
        z: positionsKm[offset + 2] as number,
      },
      transferDurationSec,
    });
  }

  function assertFrameIsSane(controller: OrbitCameraController, label: string): void {
    const { cameraPositionKm, focusPositionKm, lookDirection } = controller;
    const values = [
      cameraPositionKm.x,
      cameraPositionKm.y,
      cameraPositionKm.z,
      focusPositionKm.x,
      focusPositionKm.y,
      focusPositionKm.z,
      lookDirection.x,
      lookDirection.y,
      lookDirection.z,
      controller.distanceKm,
    ];
    for (let index = 0; index < values.length; index += 1) {
      if (!Number.isFinite(values[index] as number)) {
        throw new Error(`${label}: component ${index} is ${String(values[index])}`);
      }
    }
    const lookLength = Math.hypot(lookDirection.x, lookDirection.y, lookDirection.z);
    if (Math.abs(lookLength - 1) > 1e-12) {
      throw new Error(`${label}: look direction length ${lookLength}`);
    }
    if (
      controller.distanceKm <= 0 ||
      controller.distanceKm > DEFAULT_MAX_DISTANCE_KM * (1 + 1e-12)
    ) {
      throw new Error(`${label}: distance ${controller.distanceKm} left the allowed range`);
    }
    const measuredKm = Math.hypot(
      cameraPositionKm.x - focusPositionKm.x,
      cameraPositionKm.y - focusPositionKm.y,
      cameraPositionKm.z - focusPositionKm.z,
    );
    // The pose is stored as absolute heliocentric kilometres, so recovering a
    // short arm from it costs the ulp of the *focus*, not of the arm: each
    // component of `focus + unit * distance` rounds at `eps * |focus|`, and the
    // difference carries up to ~4 of those. Framing Mimas from 1.7 km with the
    // focus 1.4e9 km from the Sun is a 1 cm discrepancy on a 1.702 km arm — real
    // cancellation, not controller error, and precisely why every render
    // position goes camera-relative before it reaches float32.
    const focusMagnitudeKm = Math.hypot(focusPositionKm.x, focusPositionKm.y, focusPositionKm.z);
    const toleranceKm = controller.distanceKm * 1e-9 + 16 * Number.EPSILON * focusMagnitudeKm;
    if (Math.abs(measuredKm - controller.distanceKm) > toleranceKm) {
      throw new Error(`${label}: pose distance ${measuredKm} != ${controller.distanceKm}`);
    }
  }

  it('survives every ordered focus pair at maximum range', () => {
    let transferCount = 0;
    let frameCount = 0;
    for (const from of targets) {
      const controller = createController(from.id, DEFAULT_MAX_DISTANCE_KM);
      for (const to of targets) {
        if (to.id === from.id) continue;
        expect(controller.focusBody(to.id)).toBe(true);
        transferCount += 1;
        for (let step = 0; step < 95; step += 1) {
          controller.update(1 / 60);
          frameCount += 1;
          assertFrameIsSane(controller, `${from.id} -> ${to.id} step ${step}`);
        }
        expect(controller.isTransitioning).toBe(false);
        expect(controller.focusId).toBe(to.id);
        expect(controller.focusPositionKm.x).toBe(positionsKm[to.positionOffset]);
        expect(controller.distanceKm).toBeGreaterThanOrEqual(
          minimumCameraDistanceKm(to.meanRadiusKm),
        );
      }
    }
    expect(transferCount).toBe(targets.length * (targets.length - 1));
    expect(frameCount).toBe(transferCount * 95);
  });

  it('survives randomized spans, deltas, interruptions and mid-transfer zoom', () => {
    const random = mulberry32(0x1d3c7b95);
    const minimumKm = minimumCameraDistanceKm(1);
    for (let iteration = 0; iteration < 600; iteration += 1) {
      const from = targets[Math.floor(random() * targets.length)] as CameraFocusTarget;
      const startFloorKm = Math.max(minimumKm, minimumCameraDistanceKm(from.meanRadiusKm));
      const logSpan = Math.log(DEFAULT_MAX_DISTANCE_KM) - Math.log(startFloorKm);
      const startDistanceKm = Math.exp(Math.log(startFloorKm) + random() * logSpan);
      const controller = createController(from.id, startDistanceKm);

      const to = targets[Math.floor(random() * targets.length)] as CameraFocusTarget;
      controller.focusBody(to.id);
      const label = `#${iteration} ${from.id} -> ${to.id} @ ${startDistanceKm.toExponential(3)}`;
      let elapsedSec = 0;
      let interrupted = false;
      while (elapsedSec < transferDurationSec * 2) {
        const deltaSec = random() * 0.5;
        elapsedSec += deltaSec;
        controller.update(deltaSec);
        assertFrameIsSane(controller, label);
        if (random() < 0.25) {
          controller.zoomByWheel(random() * 4_000 - 2_000);
          assertFrameIsSane(controller, `${label} (zoom)`);
        }
        if (!interrupted && random() < 0.3) {
          interrupted = true;
          const third = targets[Math.floor(random() * targets.length)] as CameraFocusTarget;
          controller.focusBody(third.id);
          assertFrameIsSane(controller, `${label} (interrupt ${third.id})`);
        }
        if (random() < 0.2) {
          controller.orbitBy(random() * 6 - 3, random() * 3 - 1.5);
          assertFrameIsSane(controller, `${label} (orbit)`);
        }
      }
      // A late interruption restarts the transfer clock, so drain rather than
      // assume: every transfer must terminate, and it must terminate sane.
      let drainSteps = 0;
      while (controller.isTransitioning && drainSteps < 200) {
        controller.update(transferDurationSec / 10);
        drainSteps += 1;
        assertFrameIsSane(controller, `${label} (drain ${drainSteps})`);
      }
      expect(controller.isTransitioning).toBe(false);
      expect(drainSteps).toBeLessThanOrEqual(11);
      assertFrameIsSane(controller, `${label} (settled)`);
    }
  });
});
