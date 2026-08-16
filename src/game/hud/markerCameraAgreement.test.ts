import { describe, expect, it } from 'vitest';

import { createSimulationSnapshotBuffer } from '../../sim/simulationSnapshot.js';
import { CameraDirector } from '../cameraDirector.js';
import { ChaseCameraController } from '../chaseCameraController.js';
import { OrbitCameraController, type CameraFocusTarget } from '../orbitCameraController.js';
import { pickBodyIndexAtPixel } from './bodyPicking.js';
import {
  createWorldMarkerBuffer,
  WorldMarkerIndex,
  WORLD_MARKER_COMPONENTS,
  writeWorldMarkersInto,
} from './worldMarkerModel.js';

/**
 * The markers and the picker must agree with the *real* camera, not with a hand-
 * written pose.
 *
 * `markerProjection.test.ts` pins the convention against a synthetic frame, which
 * proves the arithmetic but not the wiring: a sign error in how `CameraPose` is
 * consumed would leave both sides internally consistent and the diamond several
 * hundred pixels off the planet. This drives the production `CameraDirector` and
 * asserts the one property a player can see — the body the camera is pointed at
 * is the body under the middle of the screen.
 */

const EARTH_RADIUS_KM = 6_371.0084;
const JUPITER_RADIUS_KM = 69_911;
const AU_KM = 149_597_870.7;
const BASE_FOV_DEG = 75;
const WIDTH_PX = 1_280;
const HEIGHT_PX = 720;
const SHIP_LENGTH_KM = 26.12e-3;
const SHIP_POSITION_OFFSET = 6;

/**
 * Earth and Jupiter on the +X axis with the ship in a 400 km orbit — the same
 * geometry `createEpochWorld` hands the director, including the ship triple
 * appended after the catalog bodies.
 */
function createHarness() {
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
    { id: 'ship', positionOffset: SHIP_POSITION_OFFSET, meanRadiusKm: SHIP_LENGTH_KM / 2 },
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

  // Catalog bodies only: `SimSnapshot.bodyPositionsKm` never carries the ship.
  const snapshot = createSimulationSnapshotBuffer(Object.freeze(['earth', 'jupiter']));
  snapshot.bodyPositionsKm.set(positionsKm.subarray(0, 6));
  snapshot.shipState.set(positionsKm.subarray(SHIP_POSITION_OFFSET, SHIP_POSITION_OFFSET + 3), 0);
  snapshot.dominantBodyIndex = 0;
  snapshot.targetBodyIndex = 0;
  const radiiKm = Float64Array.from([EARTH_RADIUS_KM, JUPITER_RADIUS_KM]);

  /** Settles the director out of any transition so the pose is the mode's own. */
  const settle = (): void => {
    for (let frame = 0; frame < 90; frame += 1) director.update(1 / 60, snapshot);
  };
  return { director, orbit, radiiKm, settle, snapshot };
}

function targetMarker(buffer: ReturnType<typeof createWorldMarkerBuffer>) {
  const offset = WorldMarkerIndex.TARGET * WORLD_MARKER_COMPONENTS;
  return {
    visible: buffer.markers[offset] === 1,
    xPx: buffer.markers[offset + 1] as number,
    yPx: buffer.markers[offset + 2] as number,
    offscreen: buffer.markers[offset + 4] === 1,
  };
}

describe('markers agree with the production camera - T0112', () => {
  it('puts the observatory focus body under the middle of the screen', () => {
    const { director, settle, snapshot } = createHarness();
    director.focusBody('earth');
    settle();

    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      director.pose,
      WIDTH_PX,
      HEIGHT_PX,
      true,
    );
    const marker = targetMarker(buffer);

    expect(buffer.valid).toBe(true);
    expect(marker.visible).toBe(true);
    expect(marker.offscreen).toBe(false);
    expect(marker.xPx).toBeCloseTo(WIDTH_PX / 2, 6);
    expect(marker.yPx).toBeCloseTo(HEIGHT_PX / 2, 6);
  });

  it('picks the observatory focus body from the centre pixel', () => {
    const { director, radiiKm, settle, snapshot } = createHarness();
    director.focusBody('earth');
    settle();

    expect(
      pickBodyIndexAtPixel(
        snapshot,
        director.pose,
        radiiKm,
        WIDTH_PX,
        HEIGHT_PX,
        WIDTH_PX / 2,
        HEIGHT_PX / 2,
      ),
    ).toBe(0);
  });

  it('follows the focus when it moves to another body', () => {
    const { director, radiiKm, settle, snapshot } = createHarness();
    director.focusBody('jupiter');
    settle();

    expect(
      pickBodyIndexAtPixel(
        snapshot,
        director.pose,
        radiiKm,
        WIDTH_PX,
        HEIGHT_PX,
        WIDTH_PX / 2,
        HEIGHT_PX / 2,
      ),
    ).toBe(1);
  });

  /**
   * The chase camera looks along the ship's nose from behind it, so the body the
   * ship is orbiting is somewhere off-axis rather than centred — but it must
   * still project to a finite pixel, and the target diamond must still be shown.
   */
  it('keeps the target diamond available in chase mode', () => {
    const { director, settle, snapshot } = createHarness();
    director.focusBody('ship');
    settle();

    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      director.pose,
      WIDTH_PX,
      HEIGHT_PX,
      false,
    );
    const marker = targetMarker(buffer);

    expect(buffer.valid).toBe(true);
    expect(marker.visible).toBe(true);
    expect(Number.isFinite(marker.xPx)).toBe(true);
    expect(Number.isFinite(marker.yPx)).toBe(true);
  });

  /**
   * The degenerate case three.js quietly survives and a strict implementation
   * does not: an observatory pose whose look direction is parallel to the `+Y`
   * up hint. `Matrix4.lookAt` nudges the frame and keeps rendering, so the
   * markers have to do the same or they vanish exactly when the camera is
   * looking straight up the ecliptic pole.
   */
  it('survives a look direction parallel to the up hint', () => {
    const { director, radiiKm, settle, snapshot } = createHarness();
    director.focusBody('earth');
    settle();
    // Straight down the +Y axis at Earth: `cross(forward, up)` vanishes.
    snapshot.bodyPositionsKm.set(
      [director.pose.positionKm.x, director.pose.positionKm.y - 40_000, director.pose.positionKm.z],
      0,
    );
    const pose = {
      positionKm: director.pose.positionKm,
      lookDirection: { x: 0, y: -1, z: 0 },
      upDirection: { x: 0, y: 1, z: 0 },
      fovDeg: BASE_FOV_DEG,
    };

    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose,
      WIDTH_PX,
      HEIGHT_PX,
      false,
    );

    expect(buffer.valid).toBe(true);
    expect(targetMarker(buffer).visible).toBe(true);
    expect(
      pickBodyIndexAtPixel(
        snapshot,
        pose,
        radiiKm,
        WIDTH_PX,
        HEIGHT_PX,
        WIDTH_PX / 2,
        HEIGHT_PX / 2,
      ),
    ).toBe(0);
  });
});
