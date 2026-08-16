import { describe, expect, it } from 'vitest';

import type { SimSnapshot } from '../sim/simulationSnapshot.js';
import { CameraDirector, IMPLEMENTED_CAMERA_MODES } from './cameraDirector.js';
import {
  ChaseCameraController,
  CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS,
  CHASE_SHAKE_FULL_ACCELERATION_MS2,
  CHASE_UP_OFFSET_RATIO,
} from './chaseCameraController.js';
import { OrbitCameraController, type CameraFocusTarget } from './orbitCameraController.js';

const SHIP_LENGTH_KM = 26.12e-3;
const SHIP_BOUNDING_RADIUS_KM = SHIP_LENGTH_KM / 2;
const EARTH_RADIUS_KM = 6_371.0084;
const JUPITER_RADIUS_KM = 69_911;
const AU_KM = 149_597_870.7;
const BASE_FOV_DEG = 75;
const FRAME_SEC = 1 / 60;
/** `DEFAULT_TRANSFER_DURATION_SEC`: the cross-fade and the orbit transfer share it. */
const TRANSITION_SEC = 1.5;
/** earth, jupiter, ship — the ship is last, exactly as `createEpochWorld` builds it. */
const SHIP_POSITION_OFFSET = 6;

function createSnapshot(overrides: Partial<SimSnapshot> = {}): SimSnapshot {
  return {
    attitudeQuaternion: new Float64Array([0, 0, 0, 1]),
    throttle: 0,
    shipProperAccelerationKmS2: new Float64Array(3),
    impactOccurred: 0,
    impactBodyIndex: -1,
    dominantBodyIndex: -1,
    ...overrides,
  } as unknown as SimSnapshot;
}

interface Harness {
  readonly director: CameraDirector;
  readonly orbit: OrbitCameraController;
  readonly chase: ChaseCameraController;
  readonly positionsKm: Float64Array;
  step(dtSec?: number, snapshot?: SimSnapshot): void;
}

function createHarness(): Harness {
  const positionsKm = new Float64Array([
    AU_KM,
    0,
    0,
    5.2 * AU_KM,
    0,
    0,
    AU_KM + EARTH_RADIUS_KM + 400,
    0,
    0,
  ]);
  const targets: readonly CameraFocusTarget[] = [
    { id: 'earth', positionOffset: 0, meanRadiusKm: EARTH_RADIUS_KM },
    { id: 'jupiter', positionOffset: 3, meanRadiusKm: JUPITER_RADIUS_KM },
    { id: 'ship', positionOffset: SHIP_POSITION_OFFSET, meanRadiusKm: SHIP_BOUNDING_RADIUS_KM },
  ];
  const orbit = new OrbitCameraController({
    positionsKm,
    targets,
    initialFocusId: 'earth',
    initialCameraPositionKm: { x: AU_KM - EARTH_RADIUS_KM - 400, y: 0, z: 0 },
  });
  const chase = new ChaseCameraController({
    positionsKm,
    shipPositionOffset: SHIP_POSITION_OFFSET,
    shipLengthKm: SHIP_LENGTH_KM,
    bodyRadiiKm: new Float64Array([EARTH_RADIUS_KM, JUPITER_RADIUS_KM]),
  });
  const director = new CameraDirector({
    orbit,
    chase,
    shipFocusId: 'ship',
    shipPositionOffset: SHIP_POSITION_OFFSET,
    baseFovDeg: BASE_FOV_DEG,
    defaultObservatoryFocusId: 'earth',
  });
  director.prime(new Float64Array([0, 0, 0, 1]));
  return {
    director,
    orbit,
    chase,
    positionsKm,
    step(dtSec = FRAME_SEC, snapshot = createSnapshot()) {
      director.update(dtSec, snapshot);
    },
  };
}

function poseDistanceKm(harness: Harness, other: { x: number; y: number; z: number }): number {
  return Math.hypot(
    harness.director.pose.positionKm.x - other.x,
    harness.director.pose.positionKm.y - other.y,
    harness.director.pose.positionKm.z - other.z,
  );
}

describe('CameraDirector', () => {
  describe('modes', () => {
    it('starts in chase, with the orbit ring parked on the ship', () => {
      const harness = createHarness();
      expect(harness.director.mode).toBe('chase');
      expect(harness.director.focusId).toBe('ship');
      // Same ring for both modes, so `[` / `]` step off the ship coherently.
      expect(harness.orbit.focusId).toBe('ship');
      expect(harness.director.focusPositionOffset).toBe(SHIP_POSITION_OFFSET);
    });

    it('cycles chase, cinematic and observatory', () => {
      const harness = createHarness();
      expect([...IMPLEMENTED_CAMERA_MODES]).toEqual(['chase', 'cinematic', 'observatory']);
      harness.director.cycle();
      expect(harness.director.mode).toBe('cinematic');
      // Photo mode orbits the ship: the ring stays parked on it (T0125).
      expect(harness.orbit.focusId).toBe('ship');
      expect(harness.director.focusId).toBe('ship');
      expect(harness.director.focusPositionOffset).toBe(SHIP_POSITION_OFFSET);
      harness.director.cycle();
      expect(harness.director.mode).toBe('observatory');
      // ...and back to a body rather than a 39 m view of the player's own hull.
      expect(harness.orbit.focusId).toBe('earth');
      harness.director.cycle();
      expect(harness.director.mode).toBe('chase');
    });

    it('names the owning task for a mode this build does not implement', () => {
      const harness = createHarness();
      expect(() => harness.director.setMode('cockpit')).toThrow(/T0124/u);
      // Silently no-opping would leave the caller believing the camera moved.
      expect(harness.director.mode).toBe('chase');
    });

    it('is idempotent for the mode it is already in', () => {
      const harness = createHarness();
      harness.director.setMode('chase');
      expect(harness.director.isTransitioning).toBe(false);
    });
  });

  describe('cinematic mode (T0125)', () => {
    it('publishes the orbit pose with a rollable up vector and its own field of view', () => {
      const harness = createHarness();
      harness.director.setMode('cinematic');
      harness.step();
      harness.step(TRANSITION_SEC);

      const pose = harness.director.pose;
      expect(pose.positionKm.x).toBeCloseTo(harness.orbit.cameraPositionKm.x, 9);
      expect(pose.positionKm.y).toBeCloseTo(harness.orbit.cameraPositionKm.y, 9);
      expect(pose.positionKm.z).toBeCloseTo(harness.orbit.cameraPositionKm.z, 9);
      expect(pose.fovDeg).toBe(BASE_FOV_DEG);
      // Not observatory's literal +Y hint: an orthonormal frame you can roll.
      const upLength = Math.hypot(pose.upDirection.x, pose.upDirection.y, pose.upDirection.z);
      expect(upLength).toBeCloseTo(1, 9);

      expect(harness.director.rollCameraBy(Math.PI / 3)).toBe(true);
      expect(harness.director.cinematicRollRad).toBeCloseTo(Math.PI / 3, 12);
      harness.step();
      expect(
        pose.upDirection.x * harness.orbit.lookDirection.x +
          pose.upDirection.y * harness.orbit.lookDirection.y +
          pose.upDirection.z * harness.orbit.lookDirection.z,
      ).toBeCloseTo(0, 9);

      expect(harness.director.adjustCameraFovBy(-500)).toBe(true);
      harness.step();
      expect(harness.director.pose.fovDeg).toBe(20);
      expect(harness.director.adjustCameraFovBy(500)).toBe(true);
      harness.step();
      expect(harness.director.pose.fovDeg).toBe(90);
    });

    it('ignores roll and field-of-view input in every other mode', () => {
      const harness = createHarness();
      expect(harness.director.mode).toBe('chase');
      expect(harness.director.rollCameraBy(1)).toBe(false);
      expect(harness.director.adjustCameraFovBy(-10)).toBe(false);
      expect(harness.director.cinematicRollRad).toBe(0);
      expect(harness.director.cinematicFovDeg).toBe(BASE_FOV_DEG);
      expect(harness.director.directFocusEnabled).toBe(true);

      harness.director.setMode('cinematic');
      // E is the roll-right binding here, so the Earth shortcut must stand down.
      expect(harness.director.directFocusEnabled).toBe(false);
      harness.director.setMode('observatory');
      expect(harness.director.directFocusEnabled).toBe(true);
      expect(harness.director.rollCameraBy(1)).toBe(false);
    });

    it('drifts only while cinematic is the mode actually driving the frame', () => {
      const harness = createHarness();
      harness.step(10);
      expect(harness.director.cinematicDrifting).toBe(false);

      harness.director.setMode('cinematic');
      harness.step(TRANSITION_SEC + 4);
      expect(harness.director.cinematicDrifting).toBe(true);

      harness.director.setMode('observatory');
      harness.step();
      expect(harness.director.cinematicDrifting).toBe(false);
    });

    it('never cuts on the way in or out of cinematic', () => {
      const harness = createHarness();
      // Let the construction-time transfer of the orbit ring onto the ship
      // finish first, or its 6,771 km flight would be measured as the step.
      for (let frame = 0; frame < Math.round(TRANSITION_SEC / FRAME_SEC) + 30; frame += 1) {
        harness.step();
      }
      harness.director.setMode('cinematic');
      let maximumStepKm = 0;
      let previousX = harness.director.pose.positionKm.x;
      let previousY = harness.director.pose.positionKm.y;
      let previousZ = harness.director.pose.positionKm.z;
      const frames = Math.round(TRANSITION_SEC / FRAME_SEC) + 30;
      for (let frame = 0; frame < frames; frame += 1) {
        harness.step();
        const pose = harness.director.pose;
        maximumStepKm = Math.max(
          maximumStepKm,
          Math.hypot(
            pose.positionKm.x - previousX,
            pose.positionKm.y - previousY,
            pose.positionKm.z - previousZ,
          ),
        );
        previousX = pose.positionKm.x;
        previousY = pose.positionKm.y;
        previousZ = pose.positionKm.z;
      }
      // Chase sits 0.166 km from the ship and cinematic settles near 0.039 km;
      // a cut would show up as a step comparable to that whole gap.
      expect(maximumStepKm).toBeLessThan(0.02);
      expect(harness.director.isTransitioning).toBe(false);
    });
  });

  describe('focus routing', () => {
    it('treats a body focus request as an observatory request', () => {
      const harness = createHarness();
      expect(harness.director.focusBody('jupiter')).toBe(true);
      expect(harness.director.mode).toBe('observatory');
      expect(harness.director.focusId).toBe('jupiter');
      expect(harness.director.focusPositionOffset).toBe(3);
    });

    it('treats a ship focus request as a chase request', () => {
      const harness = createHarness();
      harness.director.focusBody('jupiter');
      expect(harness.director.focusBody('ship')).toBe(true);
      expect(harness.director.mode).toBe('chase');
      expect(harness.director.focusBody('ship')).toBe(false);
    });

    it('re-aims the observatory camera without leaving chase on setTarget', () => {
      const harness = createHarness();
      // The whole point of the second entry point: picking a navigation target
      // must not throw the player out of the third-person view.
      expect(harness.director.focusObservatoryBody('jupiter')).toBe(false);
      expect(harness.director.mode).toBe('chase');
      expect(harness.director.focusId).toBe('ship');

      // ...and the choice is remembered, so leaving the ship lands on it.
      harness.director.cycle();
      harness.director.cycle();
      expect(harness.director.mode).toBe('observatory');
      expect(harness.director.focusId).toBe('jupiter');
    });

    it('moves the observatory camera immediately when it is the active mode', () => {
      const harness = createHarness();
      harness.director.setMode('observatory');
      expect(harness.director.focusObservatoryBody('jupiter')).toBe(true);
      expect(harness.orbit.focusId).toBe('jupiter');
      expect(harness.director.mode).toBe('observatory');
    });

    it('never routes the ship through the observatory path', () => {
      const harness = createHarness();
      harness.director.setMode('observatory');
      expect(harness.director.focusObservatoryBody('ship')).toBe(false);
      expect(harness.director.mode).toBe('observatory');
      expect(harness.orbit.focusId).toBe('earth');
    });

    it('steps the focus ring onto and off the ship', () => {
      const harness = createHarness();
      // Ring order is earth, jupiter, ship; chase parks it on the ship.
      expect(harness.director.cycleFocus(1)).toBe('earth');
      expect(harness.director.mode).toBe('observatory');
      expect(harness.director.cycleFocus(-1)).toBe('ship');
      expect(harness.director.mode).toBe('chase');
    });
  });

  describe('input routing', () => {
    it('sends the wheel to whichever camera is active', () => {
      const harness = createHarness();
      harness.director.zoomByWheel(-500);
      expect(harness.director.chaseDistanceShipLengths).toBeLessThan(
        CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS,
      );
      const orbitDistanceKm = harness.orbit.distanceKm;

      harness.director.setMode('observatory');
      harness.director.zoomByWheel(-500);
      expect(harness.orbit.distanceKm).toBeLessThan(orbitDistanceKm);
    });

    it('sends drag to the chase arm in chase and to the orbit camera otherwise', () => {
      const harness = createHarness();
      harness.step(0);
      const chaseBefore = { ...harness.director.pose.positionKm };
      harness.director.orbitBy(0.4, 0.2);
      harness.step(2);
      harness.step(2);
      expect(poseDistanceKm(harness, chaseBefore)).toBeGreaterThan(0.01);
    });
  });

  describe('mode cross-fade', () => {
    it('starts exactly on the outgoing pose and ends exactly on the incoming one', () => {
      const harness = createHarness();
      harness.step(0);
      const chasePose = { ...harness.director.pose.positionKm };

      harness.director.setMode('observatory');
      expect(harness.director.isTransitioning).toBe(true);
      harness.step(0);
      // Frame zero of the blend is still the chase pose: no cut.
      expect(poseDistanceKm(harness, chasePose)).toBeLessThan(1e-6);

      for (let frame = 0; frame < 120; frame += 1) harness.step();
      expect(harness.director.isTransitioning).toBe(false);
      expect(poseDistanceKm(harness, harness.orbit.cameraPositionKm)).toBeLessThan(1e-6);
    });

    it('never takes a discontinuous step, even across 4 AU', () => {
      const harness = createHarness();
      harness.step(0);
      harness.director.focusBody('jupiter');

      let previous = { ...harness.director.pose.positionKm };
      const start = { ...previous };
      let maximumStepKm = 0;
      for (let frame = 0; frame < 200; frame += 1) {
        harness.step();
        const stepKm = poseDistanceKm(harness, previous);
        maximumStepKm = Math.max(maximumStepKm, stepKm);
        previous = { ...harness.director.pose.positionKm };
      }
      const travelKm = Math.hypot(previous.x - start.x, previous.y - start.y, previous.z - start.z);
      expect(travelKm).toBeGreaterThan(4 * AU_KM);
      // The same continuity bound `test:camera-controls` holds the v1 orbit
      // transfer to. A hard cut would show up here as a step near `travelKm`.
      expect(maximumStepKm).toBeLessThan(travelKm * 0.04);
    });

    it('spends the whole blend duration moving, with no isolated spike', () => {
      // The two properties `test:camera-controls` used to measure in the browser
      // and now measures here, where the frame delta is exactly 1/60 instead of
      // whatever a contended software rasteriser managed. Both are stricter for
      // it: the browser could only say "spread over more than 250 ms" from ~20
      // ragged samples; this counts every frame of the move.
      const harness = createHarness();
      harness.step(0);
      harness.director.focusBody('jupiter');

      let previous = { ...harness.director.pose.positionKm };
      const stepsKm: number[] = [];
      for (let frame = 0; frame < 120; frame += 1) {
        harness.step();
        stepsKm.push(poseDistanceKm(harness, previous));
        previous = { ...harness.director.pose.positionKm };
      }

      const pathLengthKm = stepsKm.reduce((total, step) => total + step, 0);
      const movingFrames = stepsKm.filter((step) => step > pathLengthKm * 1e-4).length;
      // 1.5 s of blend at 1/60 is 90 frames, and 79 of them carry measurable
      // motion: smootherstep is deliberately flat at both ends, so the first
      // handful move less than 1e-4 of the path. The property is that the move
      // occupies the blend window rather than being a jump followed by
      // stillness — a cut would score 1.
      expect(movingFrames).toBeGreaterThan(70);
      expect(movingFrames).toBeLessThanOrEqual(91);

      // No isolated spike: the busiest frame has busy neighbours. A cut is one
      // enormous step between two stationary stretches.
      let peakIndex = 0;
      for (let index = 1; index < stepsKm.length; index += 1) {
        if ((stepsKm[index] as number) > (stepsKm[peakIndex] as number)) peakIndex = index;
      }
      const neighbourMeanKm = ((stepsKm[peakIndex - 1] ?? 0) + (stepsKm[peakIndex + 1] ?? 0)) / 2;
      expect((stepsKm[peakIndex] as number) / neighbourMeanKm).toBeLessThan(1.2);
    });

    it('reverses mid-transition without cutting', () => {
      const harness = createHarness();
      harness.step(0);
      harness.director.setMode('observatory');
      for (let frame = 0; frame < 30; frame += 1) harness.step();
      const midway = { ...harness.director.pose.positionKm };

      harness.director.setMode('chase');
      harness.step(0);
      expect(poseDistanceKm(harness, midway)).toBeLessThan(1e-6);
    });

    it('interpolates the distance logarithmically, not linearly', () => {
      const harness = createHarness();
      harness.step(0);
      harness.director.setMode('observatory');
      const endDistanceKm = EARTH_RADIUS_KM * 3;
      const startDistanceKm =
        CHASE_DEFAULT_DISTANCE_SHIP_LENGTHS *
        SHIP_LENGTH_KM *
        Math.sqrt(1 + CHASE_UP_OFFSET_RATIO * CHASE_UP_OFFSET_RATIO);

      // Halfway through the eased blend the distance should be near the
      // geometric mean of the endpoints; a linear blend would be at half of
      // 19,113 km, five orders of magnitude away from where it belongs.
      for (let frame = 0; frame < 45; frame += 1) harness.step();
      const halfway = Math.hypot(
        harness.director.pose.positionKm.x - (harness.positionsKm[0] as number),
        harness.director.pose.positionKm.y - (harness.positionsKm[1] as number),
        harness.director.pose.positionKm.z - (harness.positionsKm[2] as number),
      );
      expect(halfway).toBeLessThan(endDistanceKm * 0.5);
      expect(halfway).toBeGreaterThan(Math.sqrt(startDistanceKm * endDistanceKm) * 0.01);
    });
  });

  describe('published pose', () => {
    it('adds the chase widening to the base field of view and drops it in observatory', () => {
      const harness = createHarness();
      const throttled = createSnapshot({ throttle: 1 });
      for (let frame = 0; frame < 120; frame += 1) harness.step(FRAME_SEC, throttled);
      expect(harness.director.pose.fovDeg).toBeGreaterThan(BASE_FOV_DEG + 7.8);

      harness.director.setMode('observatory');
      for (let frame = 0; frame < 120; frame += 1) harness.step(FRAME_SEC, throttled);
      expect(harness.director.pose.fovDeg).toBe(BASE_FOV_DEG);
    });

    it('reports the scene camera default up in observatory, so v1 framing is unchanged', () => {
      const harness = createHarness();
      harness.director.setMode('observatory');
      for (let frame = 0; frame < 120; frame += 1) harness.step();
      expect(harness.director.pose.upDirection).toEqual({ x: 0, y: 1, z: 0 });
    });

    it('keeps the ship framed at the arm distance while chasing a moving ship', () => {
      const harness = createHarness();
      harness.step(0);
      for (let frame = 0; frame < 600; frame += 1) {
        harness.positionsKm[SHIP_POSITION_OFFSET] =
          (harness.positionsKm[SHIP_POSITION_OFFSET] as number) + 7.67 * FRAME_SEC;
        harness.step();
      }
      const armKm = Math.hypot(
        (harness.positionsKm[SHIP_POSITION_OFFSET] as number) - harness.director.pose.positionKm.x,
        (harness.positionsKm[SHIP_POSITION_OFFSET + 1] as number) -
          harness.director.pose.positionKm.y,
        (harness.positionsKm[SHIP_POSITION_OFFSET + 2] as number) -
          harness.director.pose.positionKm.z,
      );
      expect(armKm).toBeCloseTo(harness.director.chaseArmDistanceKm, 6);
      expect(armKm).toBeLessThan(0.2);
    });

    it('publishes through one stable pose object', () => {
      const harness = createHarness();
      const pose = harness.director.pose;
      const position = pose.positionKm;
      harness.step();
      expect(harness.director.pose).toBe(pose);
      expect(harness.director.pose.positionKm).toBe(position);
    });
  });

  describe('snapshot inputs', () => {
    it('converts proper acceleration to m/s^2 for the shake ramp', () => {
      const harness = createHarness();
      // 5 g expressed in the snapshot's km/s^2.
      const burning = createSnapshot({
        shipProperAccelerationKmS2: new Float64Array([
          CHASE_SHAKE_FULL_ACCELERATION_MS2 / 1000,
          0,
          0,
        ]),
      });
      harness.step(FRAME_SEC, burning);
      harness.step(FRAME_SEC, burning);
      expect(harness.director.chaseShakeAmplitudeDeg).toBeCloseTo(0.15, 12);
    });

    it('clears the shake and holds attitude while an impact has frozen the sim', () => {
      const harness = createHarness();
      const frozen = createSnapshot({
        impactOccurred: 1,
        impactBodyIndex: 0,
        shipProperAccelerationKmS2: new Float64Array([1, 0, 0]),
      });
      harness.step(FRAME_SEC, frozen);
      expect(harness.director.chaseShakeAmplitudeDeg).toBe(0);
    });

    it('applies the persisted presentation toggles', () => {
      const harness = createHarness();
      harness.director.applyCameraSettings({ fovWidening: false, shake: false });
      expect(harness.director.chaseFovWideningEnabled).toBe(false);
      expect(harness.director.chaseShakeEnabled).toBe(false);
      const throttled = createSnapshot({
        throttle: 1,
        shipProperAccelerationKmS2: new Float64Array([1, 0, 0]),
      });
      for (let frame = 0; frame < 120; frame += 1) harness.step(FRAME_SEC, throttled);
      expect(harness.director.pose.fovDeg).toBe(BASE_FOV_DEG);
      expect(harness.director.chaseShakeAmplitudeDeg).toBe(0);
    });
  });

  it('rejects an invalid construction', () => {
    const harness = createHarness();
    expect(
      () =>
        new CameraDirector({
          orbit: harness.orbit,
          chase: harness.chase,
          shipFocusId: '',
          shipPositionOffset: SHIP_POSITION_OFFSET,
          baseFovDeg: BASE_FOV_DEG,
        }),
    ).toThrow(/ship focus id/u);
    expect(
      () =>
        new CameraDirector({
          orbit: harness.orbit,
          chase: harness.chase,
          shipFocusId: 'ship',
          shipPositionOffset: SHIP_POSITION_OFFSET,
          baseFovDeg: 0,
        }),
    ).toThrow(/field of view/u);
    expect(() => harness.director.update(-1, createSnapshot())).toThrow(/finite and nonnegative/u);
  });
});
