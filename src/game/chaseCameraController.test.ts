import { describe, expect, it } from 'vitest';

import {
  ChaseCameraController,
  CHASE_ATTITUDE_LAG_SEC,
  CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS,
  CHASE_FOV_SMOOTHING_SEC,
  CHASE_FOV_WIDEN_MAX_DEG,
  CHASE_MAX_DISTANCE_SHIP_LENGTHS,
  CHASE_MIN_DISTANCE_SHIP_LENGTHS,
  CHASE_SHAKE_FULL_ACCELERATION_MS2,
  CHASE_SHAKE_MAX_DEG,
  CHASE_SPRING_OMEGA_RAD_S,
  CHASE_UP_OFFSET_RATIO,
} from './chaseCameraController.js';

/** `SHIP_LENGTH_M * SHIP_MODEL_SCALE_KM_PER_UNIT`, injected the way the world does. */
const SHIP_LENGTH_KM = 26.12e-3;
const FRAME_SEC = 1 / 60;
const IDENTITY = new Float64Array([0, 0, 0, 1]);
/** One body: index 0, Earth-sized, at the origin. Ship triple is index 1. */
const BODY_RADIUS_KM = 6_371.0084;
const SHIP_OFFSET = 3;

interface Harness {
  readonly controller: ChaseCameraController;
  readonly positionsKm: Float64Array;
  setShip(x: number, y: number, z: number): void;
  step(
    dtSec?: number,
    attitude?: Float64Array,
    throttle?: number,
    accelerationMS2?: number,
    clearanceBodyIndex?: number,
    frozen?: boolean,
  ): void;
  armOffset(): readonly [number, number, number];
}

function createHarness(
  shipXKm = 10_000,
  initialDistanceShipLengths = CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS,
): Harness {
  const positionsKm = new Float64Array([0, 0, 0, shipXKm, 0, 0]);
  const controller = new ChaseCameraController({
    positionsKm,
    shipPositionOffset: SHIP_OFFSET,
    shipLengthKm: SHIP_LENGTH_KM,
    bodyRadiiKm: new Float64Array([BODY_RADIUS_KM]),
    initialDistanceShipLengths,
  });
  return {
    controller,
    positionsKm,
    setShip(x, y, z) {
      positionsKm[SHIP_OFFSET] = x;
      positionsKm[SHIP_OFFSET + 1] = y;
      positionsKm[SHIP_OFFSET + 2] = z;
    },
    step(
      dtSec = FRAME_SEC,
      attitude = IDENTITY,
      throttle = 0,
      accelerationMS2 = 0,
      clearanceBodyIndex = -1,
      frozen = false,
    ) {
      controller.update(dtSec, attitude, throttle, accelerationMS2, clearanceBodyIndex, frozen);
    },
    armOffset() {
      return [
        controller.cameraPositionKm.x - (positionsKm[SHIP_OFFSET] as number),
        controller.cameraPositionKm.y - (positionsKm[SHIP_OFFSET + 1] as number),
        controller.cameraPositionKm.z - (positionsKm[SHIP_OFFSET + 2] as number),
      ];
    },
  };
}

/** Quaternion for a rotation of `angleRad` about a unit axis. */
function axisAngle(axisX: number, axisY: number, axisZ: number, angleRad: number): Float64Array {
  const half = angleRad / 2;
  const sin = Math.sin(half);
  return new Float64Array([axisX * sin, axisY * sin, axisZ * sin, Math.cos(half)]);
}

function angleBetweenDeg(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  const dot = Math.min(1, Math.max(-1, left.x * right.x + left.y * right.y + left.z * right.z));
  return Math.acos(dot) * (180 / Math.PI);
}

describe('ChaseCameraController', () => {
  describe('arm geometry', () => {
    it('reproduces position = ship - forward*d + up*0.35d exactly at rest', () => {
      // Ship at the origin on purpose: at a realistic 1e4 km the float64 grid is
      // 1.8e-12 km wide, so subtracting the ship position back out would measure
      // the cancellation rather than the formula.
      const harness = createHarness(0);
      harness.step(0);

      // Identity attitude: body +X (forward) is world +X, body +Z (up) is world +Z.
      const distanceKm = CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS * SHIP_LENGTH_KM;
      const [x, y, z] = harness.armOffset();
      expect(x).toBe(-distanceKm);
      expect(y).toBe(0);
      expect(z).toBe(distanceKm * CHASE_UP_OFFSET_RATIO);
    });

    it('rides a rotated ship, keeping the offset in the body frame', () => {
      const harness = createHarness();
      // 90 degrees about +Z: body +X maps onto world +Y, body +Z is unchanged.
      const yawed = axisAngle(0, 0, 1, Math.PI / 2);
      harness.step(0, yawed);

      const distanceKm = CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS * SHIP_LENGTH_KM;
      const [x, y, z] = harness.armOffset();
      expect(x).toBeCloseTo(0, 12);
      expect(y).toBeCloseTo(-distanceKm, 12);
      expect(z).toBeCloseTo(distanceKm * CHASE_UP_OFFSET_RATIO, 12);
    });

    it('points at the ship and carries the ship roll into camera up', () => {
      const level = createHarness();
      level.step(0);
      expect(level.controller.upDirection.z).toBeGreaterThan(0.9);

      const rolled = createHarness();
      // 90 degrees of roll about the nose: body up rotates onto world -Y, and the
      // camera up follows it — rolling the ship must roll the world.
      rolled.step(0, axisAngle(1, 0, 0, Math.PI / 2));
      expect(rolled.controller.upDirection.y).toBeLessThan(-0.9);

      const { lookDirection: look, upDirection: up } = rolled.controller;
      expect(Math.hypot(look.x, look.y, look.z)).toBeCloseTo(1, 15);
      expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 15);
      // Orthogonal by construction, and pointing from the camera back at the ship.
      expect(look.x * up.x + look.y * up.y + look.z * up.z).toBeCloseTo(0, 15);
      expect(look.x).toBeGreaterThan(0);
    });

    it('follows ship translation rigidly, with no tracking lag at orbital speed', () => {
      // The reason the spring runs on the arm offset and not on the world
      // position: a critically damped world-space tracker would sit 2v/w behind,
      // which is 1.9 km at LEO speed against a 157 m arm.
      const harness = createHarness();
      harness.step(0);
      const reference = harness.armOffset();
      let shipXKm = 10_000;
      for (let frame = 0; frame < 600; frame += 1) {
        shipXKm += 7.67 * FRAME_SEC;
        harness.setShip(shipXKm, 0, 0);
        harness.step();
      }
      const [x, y, z] = harness.armOffset();
      expect(x).toBeCloseTo(reference[0], 12);
      expect(y).toBeCloseTo(reference[1], 12);
      expect(z).toBeCloseTo(reference[2], 12);
    });
  });

  describe('critically damped spring', () => {
    it('never overshoots a step taken from rest', () => {
      const harness = createHarness();
      harness.step(0);
      const startXKm = harness.armOffset()[0];
      harness.controller.setDistanceShipLengths(24);
      const targetXKm = -24 * SHIP_LENGTH_KM;

      let previousXKm = startXKm;
      for (let frame = 0; frame < 240; frame += 1) {
        harness.step();
        const currentXKm = harness.armOffset()[0];
        // Monotone approach: never past the target, never back the way it came.
        expect(currentXKm).toBeGreaterThanOrEqual(targetXKm);
        expect(currentXKm).toBeLessThanOrEqual(previousXKm + 1e-15);
        previousXKm = currentXKm;
      }
      expect(previousXKm).toBeCloseTo(targetXKm, 9);
    });

    it('settles a step to within 2 % in under 0.8 s', () => {
      const harness = createHarness();
      harness.step(0);
      const startKm = harness.armOffset();
      harness.controller.setDistanceShipLengths(24);
      const targetKm: readonly [number, number, number] = [
        -24 * SHIP_LENGTH_KM,
        0,
        24 * SHIP_LENGTH_KM * CHASE_UP_OFFSET_RATIO,
      ];
      const stepKm = Math.hypot(
        targetKm[0] - startKm[0],
        targetKm[1] - startKm[1],
        targetKm[2] - startKm[2],
      );

      let settledSec: number | null = null;
      for (let frame = 1; frame <= 120; frame += 1) {
        harness.step();
        const offsetKm = harness.armOffset();
        const errorKm = Math.hypot(
          offsetKm[0] - targetKm[0],
          offsetKm[1] - targetKm[1],
          offsetKm[2] - targetKm[2],
        );
        if (settledSec === null && errorKm <= stepKm * 0.02) settledSec = frame * FRAME_SEC;
      }
      expect(settledSec).not.toBeNull();
      expect(settledSec as number).toBeLessThan(0.8);
      // The analytic figure the constant was chosen from: (1 + wt)e^-wt = 0.02
      // at wt = 5.834, so 5.834 / 8 = 0.729 s.
      expect(settledSec as number).toBeCloseTo(5.834 / CHASE_SPRING_OMEGA_RAD_S, 1);
    });

    it('is frame-rate independent, because the step is the exact solution', () => {
      const coarse = createHarness();
      const fine = createHarness();
      coarse.step(0);
      fine.step(0);
      coarse.controller.setDistanceShipLengths(24);
      fine.controller.setDistanceShipLengths(24);
      for (let frame = 0; frame < 15; frame += 1) coarse.step(0.02);
      for (let frame = 0; frame < 60; frame += 1) fine.step(0.005);
      expect(coarse.armOffset()[0]).toBeCloseTo(fine.armOffset()[0], 12);
    });
  });

  describe('attitude follow', () => {
    it('lags a constant turn rate by the 120 ms time constant', () => {
      const harness = createHarness();
      harness.step(0);
      const rateRadS = 0.6; // ROTATION_RATE_RAD_S
      let angleRad = 0;
      for (let frame = 0; frame < 600; frame += 1) {
        angleRad += rateRadS * FRAME_SEC;
        harness.step(FRAME_SEC, axisAngle(0, 0, 1, angleRad));
      }
      // Exact discrete steady state for a first-order lag sampled at FRAME_SEC.
      const blend = 1 - Math.exp(-FRAME_SEC / CHASE_ATTITUDE_LAG_SEC);
      const discreteLagRad = (rateRadS * FRAME_SEC * (1 - blend)) / blend;
      expect(harness.controller.attitudeLagRad).toBeCloseTo(discreteLagRad, 6);
      // ...and that discrete value is within 10 % of the continuous `rate * tau`
      // the acceptance criterion states.
      expect(harness.controller.attitudeLagRad).toBeGreaterThan(
        rateRadS * CHASE_ATTITUDE_LAG_SEC * 0.9,
      );
      expect(harness.controller.attitudeLagRad).toBeLessThan(
        rateRadS * CHASE_ATTITUDE_LAG_SEC * 1.1,
      );
    });

    it('covers 1 - 1/e of a step in exactly one time constant', () => {
      const harness = createHarness();
      harness.step(0);
      const quarterTurn = axisAngle(0, 0, 1, Math.PI / 2);
      harness.step(CHASE_ATTITUDE_LAG_SEC, quarterTurn);
      const covered = Math.PI / 2 - harness.controller.attitudeLagRad;
      expect(covered).toBeCloseTo((1 - Math.exp(-1)) * (Math.PI / 2), 9);
    });

    it('snaps instead of easing on the first update after a reset', () => {
      const harness = createHarness();
      harness.step(0);
      harness.step(FRAME_SEC, axisAngle(0, 0, 1, Math.PI / 2));
      expect(harness.controller.attitudeLagRad).toBeGreaterThan(0.1);

      harness.controller.reset();
      harness.step(FRAME_SEC, axisAngle(0, 0, 1, Math.PI / 2));
      expect(harness.controller.attitudeLagRad).toBeCloseTo(0, 12);
      expect(harness.armOffset()[1]).toBeCloseTo(
        -CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS * SHIP_LENGTH_KM,
        12,
      );
    });

    it('stops chasing attitude while the simulation is frozen', () => {
      const harness = createHarness();
      harness.step(0);
      const turned = axisAngle(0, 0, 1, Math.PI / 2);
      for (let frame = 0; frame < 120; frame += 1) harness.step(FRAME_SEC, turned, 0, 0, -1, true);
      // A dead ship's attitude is not going anywhere; easing toward it forever
      // would just replay float noise.
      expect(harness.controller.attitudeLagRad).toBeCloseTo(Math.PI / 2, 9);
    });
  });

  describe('distance', () => {
    it('clamps the wheel to 2..50 ship lengths', () => {
      const harness = createHarness();
      harness.controller.zoomByWheel(-100_000);
      expect(harness.controller.distanceShipLengths).toBe(CHASE_MIN_DISTANCE_SHIP_LENGTHS);
      harness.controller.zoomByWheel(100_000);
      expect(harness.controller.distanceShipLengths).toBe(CHASE_MAX_DISTANCE_SHIP_LENGTHS);
    });

    it('zooms exponentially, so each wheel notch is the same felt step', () => {
      const harness = createHarness(10_000, 10);
      harness.controller.zoomByWheel(100);
      const once = harness.controller.distanceShipLengths;
      harness.controller.zoomByWheel(100);
      expect(harness.controller.distanceShipLengths / once).toBeCloseTo(once / 10, 12);
    });

    it('reports the settled arm distance including the up offset', () => {
      const harness = createHarness();
      harness.step(0);
      expect(harness.controller.armDistanceKm).toBeCloseTo(
        CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS *
          SHIP_LENGTH_KM *
          Math.sqrt(1 + CHASE_UP_OFFSET_RATIO * CHASE_UP_OFFSET_RATIO),
        12,
      );
    });
  });

  describe('field of view widening', () => {
    it('reaches 98 % of +8 degrees in 0.5 s at full throttle', () => {
      const harness = createHarness();
      harness.step(0);
      for (let frame = 0; frame < Math.round(0.1 / FRAME_SEC); frame += 1) {
        harness.step(FRAME_SEC, IDENTITY, 1);
      }
      // Smoothed, not instant: a tenth of the way in it is only about half open.
      expect(harness.controller.fovOffsetDeg).toBeLessThan(CHASE_FOV_WIDEN_MAX_DEG * 0.6);

      const remainingFrames = Math.round((CHASE_FOV_SMOOTHING_SEC - 0.1) / FRAME_SEC);
      for (let frame = 0; frame < remainingFrames; frame += 1) harness.step(FRAME_SEC, IDENTITY, 1);
      expect(harness.controller.fovOffsetDeg / CHASE_FOV_WIDEN_MAX_DEG).toBeGreaterThan(
        0.98 - 1e-12,
      );
      expect(harness.controller.fovOffsetDeg).toBeLessThanOrEqual(CHASE_FOV_WIDEN_MAX_DEG);
    });

    it('scales with the throttle lever rather than switching on', () => {
      const harness = createHarness();
      harness.step(0);
      for (let frame = 0; frame < 300; frame += 1) harness.step(FRAME_SEC, IDENTITY, 0.5);
      expect(harness.controller.fovOffsetDeg).toBeCloseTo(CHASE_FOV_WIDEN_MAX_DEG * 0.5, 6);
    });

    it('stays at zero and collapses back when the setting is off', () => {
      const harness = createHarness();
      harness.step(0);
      for (let frame = 0; frame < 300; frame += 1) harness.step(FRAME_SEC, IDENTITY, 1);
      expect(harness.controller.fovOffsetDeg).toBeGreaterThan(7);

      harness.controller.setFovWideningEnabled(false);
      for (let frame = 0; frame < 300; frame += 1) harness.step(FRAME_SEC, IDENTITY, 1);
      expect(harness.controller.fovOffsetDeg).toBeCloseTo(0, 6);
      expect(harness.controller.fovWideningEnabled).toBe(false);
    });
  });

  describe('shake', () => {
    /** Same inputs, shake on and off, so the deviation is measured not asserted. */
    function measurePeakDeviationDeg(accelerationMS2: number, frames = 600): number {
      const shaken = createHarness();
      const still = createHarness();
      still.controller.setShakeEnabled(false);
      shaken.step(0);
      still.step(0);
      let peakDeg = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        shaken.step(FRAME_SEC, IDENTITY, 1, accelerationMS2);
        still.step(FRAME_SEC, IDENTITY, 1, accelerationMS2);
        peakDeg = Math.max(
          peakDeg,
          angleBetweenDeg(shaken.controller.lookDirection, still.controller.lookDirection),
        );
      }
      return peakDeg;
    }

    it('stays within 0.15 degrees at and above 5 g', () => {
      const atThreshold = measurePeakDeviationDeg(CHASE_SHAKE_FULL_ACCELERATION_MS2);
      const wellAbove = measurePeakDeviationDeg(CHASE_SHAKE_FULL_ACCELERATION_MS2 * 4);
      expect(atThreshold).toBeLessThanOrEqual(CHASE_SHAKE_MAX_DEG + 1e-9);
      expect(wellAbove).toBeLessThanOrEqual(CHASE_SHAKE_MAX_DEG + 1e-9);
      // It saturates rather than being clipped: both reach essentially the cap.
      expect(atThreshold).toBeGreaterThan(CHASE_SHAKE_MAX_DEG * 0.95);
      expect(wellAbove).toBeGreaterThan(CHASE_SHAKE_MAX_DEG * 0.95);
    });

    it('ramps linearly below the threshold and vanishes at zero acceleration', () => {
      expect(measurePeakDeviationDeg(CHASE_SHAKE_FULL_ACCELERATION_MS2 / 2)).toBeLessThanOrEqual(
        CHASE_SHAKE_MAX_DEG / 2 + 1e-9,
      );
      expect(measurePeakDeviationDeg(0)).toBe(0);
    });

    it('produces no deviation at all when the setting is off', () => {
      const off = createHarness();
      const on = createHarness();
      off.controller.setShakeEnabled(false);
      off.step(0);
      on.step(0);
      let peakDeg = 0;
      for (let frame = 0; frame < 120; frame += 1) {
        off.step(FRAME_SEC, IDENTITY, 1, CHASE_SHAKE_FULL_ACCELERATION_MS2);
        on.step(FRAME_SEC, IDENTITY, 1, CHASE_SHAKE_FULL_ACCELERATION_MS2);
        expect(off.controller.shakeAmplitudeDeg).toBe(0);
        // Peak across the window, not the last frame: the 8.5 Hz envelope passes
        // through zero regularly, so a single sample can legitimately read 0.
        peakDeg = Math.max(
          peakDeg,
          angleBetweenDeg(off.controller.lookDirection, on.controller.lookDirection),
        );
      }
      expect(on.controller.shakeAmplitudeDeg).toBeCloseTo(CHASE_SHAKE_MAX_DEG, 12);
      expect(peakDeg).toBeGreaterThan(0);
    });

    it('keeps the camera frame orthonormal while shaking', () => {
      const harness = createHarness();
      harness.step(0);
      for (let frame = 0; frame < 120; frame += 1) {
        harness.step(FRAME_SEC, IDENTITY, 1, CHASE_SHAKE_FULL_ACCELERATION_MS2);
        const { lookDirection: look, upDirection: up } = harness.controller;
        expect(Math.hypot(look.x, look.y, look.z)).toBeCloseTo(1, 12);
        expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 12);
        expect(look.x * up.x + look.y * up.y + look.z * up.z).toBeCloseTo(0, 12);
      }
    });

    it('goes still while the simulation is frozen', () => {
      const harness = createHarness();
      harness.step(0);
      harness.step(FRAME_SEC, IDENTITY, 1, CHASE_SHAKE_FULL_ACCELERATION_MS2, -1, true);
      expect(harness.controller.shakeAmplitudeDeg).toBe(0);
    });
  });

  describe('surface clearance', () => {
    it('lifts the camera out of a body it would otherwise sit inside', () => {
      // Nose-down contact: the ship is on the surface and the arm hangs behind
      // and below it, which without a clamp is a camera underground.
      const harness = createHarness(BODY_RADIUS_KM);
      harness.setShip(BODY_RADIUS_KM, 0, 0);
      // Nose radially outward (identity attitude for a ship on the +X surface),
      // so the arm trails straight down into the crust.
      for (let frame = 0; frame < 240; frame += 1) harness.step(FRAME_SEC, IDENTITY, 0, 0, 0, true);

      const separationKm = Math.hypot(
        harness.controller.cameraPositionKm.x,
        harness.controller.cameraPositionKm.y,
        harness.controller.cameraPositionKm.z,
      );
      const minimumKm = BODY_RADIUS_KM + Math.max(0.002, BODY_RADIUS_KM * 1e-6);
      expect(separationKm).toBeGreaterThanOrEqual(minimumKm - 1e-9);
      expect(separationKm).toBeCloseTo(minimumKm, 9);

      // And it still frames the ship: the look direction is measured from the
      // clamped position, not from where the arm wanted to be.
      const toShipXKm =
        (harness.positionsKm[SHIP_OFFSET] as number) - harness.controller.cameraPositionKm.x;
      const toShipYKm =
        (harness.positionsKm[SHIP_OFFSET + 1] as number) - harness.controller.cameraPositionKm.y;
      const toShipZKm =
        (harness.positionsKm[SHIP_OFFSET + 2] as number) - harness.controller.cameraPositionKm.z;
      const toShipKm = Math.hypot(toShipXKm, toShipYKm, toShipZKm);
      const alignment =
        (harness.controller.lookDirection.x * toShipXKm +
          harness.controller.lookDirection.y * toShipYKm +
          harness.controller.lookDirection.z * toShipZKm) /
        toShipKm;
      expect(alignment).toBeCloseTo(1, 12);
    });

    it('leaves the arm alone in open space', () => {
      const harness = createHarness(10_000);
      harness.step(0);
      const before = harness.armOffset();
      harness.step(FRAME_SEC, IDENTITY, 0, 0, 0);
      expect(harness.armOffset()[0]).toBeCloseTo(before[0], 12);
    });
  });

  describe('player arm offsets', () => {
    it('swings the arm around the ship without changing its length', () => {
      const harness = createHarness();
      harness.step(0);
      const lengthKm = harness.controller.armDistanceKm;
      harness.controller.orbitBy(Math.PI / 2, 0);
      for (let step = 0; step < 10; step += 1) harness.step(0.5);
      expect(harness.controller.armDistanceKm).toBeCloseTo(lengthKm, 12);
      // A quarter turn about the ship's up puts the camera off its beam.
      expect(Math.abs(harness.armOffset()[1])).toBeGreaterThan(lengthKm * 0.9);
    });

    it('clamps elevation short of the poles and resets on request', () => {
      const harness = createHarness();
      harness.step(0);
      const lengthKm = harness.controller.armDistanceKm;
      harness.controller.orbitBy(0, 100);
      for (let step = 0; step < 10; step += 1) harness.step(0.5);
      const highKm = harness.armOffset();
      // Clamped short of straight overhead: 85 deg leaves a horizontal component.
      expect(highKm[2] / lengthKm).toBeCloseTo(Math.sin(1.483_529_864_195_004_5), 9);
      expect(Math.hypot(highKm[0], highKm[1])).toBeGreaterThan(lengthKm * 0.08);

      harness.controller.resetArmOffsets();
      for (let step = 0; step < 10; step += 1) harness.step(0.5);
      expect(harness.armOffset()[0]).toBeCloseTo(
        -CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS * SHIP_LENGTH_KM,
        9,
      );
    });

    it('rejects non-finite input', () => {
      const harness = createHarness();
      expect(() => harness.controller.orbitBy(Number.NaN, 0)).toThrow(/finite/u);
      expect(() => harness.controller.zoomByWheel(Number.POSITIVE_INFINITY)).toThrow(/finite/u);
      expect(() => harness.step(-1)).toThrow(/finite and nonnegative/u);
    });
  });

  it('publishes through stable output objects, so the frame path allocates nothing', () => {
    const harness = createHarness();
    harness.step(0);
    const position = harness.controller.cameraPositionKm;
    const look = harness.controller.lookDirection;
    const up = harness.controller.upDirection;
    const subject = harness.controller.subjectPositionKm;
    harness.step(FRAME_SEC, axisAngle(0, 1, 0, 0.4), 1, 20);
    expect(harness.controller.cameraPositionKm).toBe(position);
    expect(harness.controller.lookDirection).toBe(look);
    expect(harness.controller.upDirection).toBe(up);
    expect(harness.controller.subjectPositionKm).toBe(subject);
  });

  it('rejects a ship offset that does not address a packed triple', () => {
    expect(
      () =>
        new ChaseCameraController({
          positionsKm: new Float64Array(6),
          shipPositionOffset: 4,
          shipLengthKm: SHIP_LENGTH_KM,
          bodyRadiiKm: new Float64Array(1),
        }),
    ).toThrow(/packed xyz triple/u);
    expect(
      () =>
        new ChaseCameraController({
          positionsKm: new Float64Array(6),
          shipPositionOffset: 3,
          shipLengthKm: 0,
          bodyRadiiKm: new Float64Array(1),
        }),
    ).toThrow(/ship length/u);
  });
});
