import { describe, expect, it } from 'vitest';

import {
  createSimulationSnapshotBuffer,
  type SimulationSnapshotBuffer,
} from '../../sim/simulationSnapshot.js';
import type { CameraPose } from '../cameraDirector.js';
import {
  BODY_LABEL_SLOT_COUNT,
  WORLD_MARKER_COMPONENTS,
  WorldMarkerIndex,
  createWorldMarkerBuffer,
  writeWorldMarkersInto,
} from './worldMarkerModel.js';

const WIDTH_PX = 1_600;
const HEIGHT_PX = 800;
const BODY_IDS = Object.freeze(['sun', 'earth', 'moon', 'mars']);

function pose(overrides: Partial<CameraPose> = {}): CameraPose {
  return {
    positionKm: { x: 0, y: 0, z: 0 },
    lookDirection: { x: 0, y: 0, z: -1 },
    upDirection: { x: 0, y: 1, z: 0 },
    fovDeg: 90,
    ...overrides,
  };
}

function setBody(
  snapshot: SimulationSnapshotBuffer,
  index: number,
  position: readonly [number, number, number],
  velocity: readonly [number, number, number] = [0, 0, 0],
): void {
  snapshot.bodyPositionsKm.set(position, index * 3);
  snapshot.bodyVelocitiesKmS.set(velocity, index * 3);
}

function scene(): SimulationSnapshotBuffer {
  const snapshot = createSimulationSnapshotBuffer(BODY_IDS);
  setBody(snapshot, 0, [0, 0, -1e8]);
  setBody(snapshot, 1, [0, 0, -10_000]);
  // Far enough off-axis that its label clears Earth's (see LABEL_MIN_SEPARATION).
  setBody(snapshot, 2, [6_000, 0, -10_000]);
  setBody(snapshot, 3, [0, 0, 5_000]); // behind the camera
  snapshot.shipState.set([0, 0, 0], 0);
  snapshot.dominantBodyIndex = 1;
  snapshot.targetBodyIndex = 1;
  return snapshot;
}

function marker(buffer: ReturnType<typeof createWorldMarkerBuffer>, index: WorldMarkerIndex) {
  const offset = index * WORLD_MARKER_COMPONENTS;
  return {
    visible: buffer.markers[offset] === 1,
    xPx: buffer.markers[offset + 1] as number,
    yPx: buffer.markers[offset + 2] as number,
    behind: buffer.markers[offset + 3] === 1,
    offscreen: buffer.markers[offset + 4] === 1,
  };
}

describe('world marker model - T0112', () => {
  it('projects the target diamond and reports its distance from the ship', () => {
    const snapshot = scene();
    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      false,
    );

    expect(buffer.valid).toBe(true);
    expect(buffer.targetBodyIndex).toBe(1);
    expect(buffer.targetDistanceKm).toBeCloseTo(10_000, 6);
    const target = marker(buffer, WorldMarkerIndex.TARGET);
    expect(target.visible).toBe(true);
    expect(target.behind).toBe(false);
    expect(target.offscreen).toBe(false);
    expect(target.xPx).toBeCloseTo(WIDTH_PX / 2, 6);
    expect(target.yPx).toBeCloseTo(HEIGHT_PX / 2, 6);
  });

  /**
   * Losing the marker is losing the only in-world cue for where you are going, so
   * the target is the one marker that stays pinned rather than disappearing.
   */
  it('pins a behind-camera target to the edge instead of hiding it', () => {
    const snapshot = scene();
    snapshot.targetBodyIndex = 3;
    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      false,
    );

    const target = marker(buffer, WorldMarkerIndex.TARGET);
    expect(target.visible).toBe(true);
    expect(target.behind).toBe(true);
    expect(target.offscreen).toBe(true);
    expect(target.xPx).toBeGreaterThanOrEqual(0);
    expect(target.xPx).toBeLessThanOrEqual(WIDTH_PX);
  });

  /**
   * The bearing a behind-camera arrow points at, through the real composition.
   * A double mirror here would send the player the wrong way *and* flip the
   * arrow across the screen as they turned toward it, so it never converged.
   */
  it('pins an astern target on the side the player must turn towards', () => {
    const snapshot = scene();
    // Astern (+z, camera looks down -z) and to the camera's right (+x).
    setBody(snapshot, 3, [5_000, 0, 10_000]);
    snapshot.targetBodyIndex = 3;
    const right = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      false,
    );
    const rightMarker = marker(right, WorldMarkerIndex.TARGET);
    expect(rightMarker.behind).toBe(true);
    expect(rightMarker.offscreen).toBe(true);
    expect(rightMarker.xPx).toBeGreaterThan(WIDTH_PX / 2);

    setBody(snapshot, 3, [-5_000, 0, 10_000]);
    const left = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      false,
    );
    expect(marker(left, WorldMarkerIndex.TARGET).xPx).toBeLessThan(WIDTH_PX / 2);
  });

  it('hides every marker when no target is selected', () => {
    const snapshot = scene();
    snapshot.targetBodyIndex = -1;
    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      false,
    );

    expect(marker(buffer, WorldMarkerIndex.TARGET).visible).toBe(false);
    expect(buffer.targetBodyIndex).toBe(-1);
    expect(Number.isNaN(buffer.targetDistanceKm)).toBe(true);
  });

  /**
   * Same frame as `navballProjection.ts`: velocity relative to the dominant body.
   * Two prograde markers that disagreed about which velocity they meant would be
   * worse than having one.
   */
  it('places prograde and retrograde opposite each other about the view centre', () => {
    const snapshot = scene();
    // Ship moving +X relative to Earth, which is itself stationary here.
    snapshot.shipCoordinateVelocityKmS.set([3, 0, -3], 0);
    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      false,
    );

    const prograde = marker(buffer, WorldMarkerIndex.PROGRADE);
    const retrograde = marker(buffer, WorldMarkerIndex.RETROGRADE);
    expect(prograde.visible).toBe(true);
    expect(prograde.xPx).toBeGreaterThan(WIDTH_PX / 2);
    // Retrograde is astern here, so it is off-screen and therefore not drawn:
    // direction markers are suppressed rather than pinned.
    expect(retrograde.visible).toBe(false);
  });

  it('carries the dominant body velocity, not the heliocentric one', () => {
    const snapshot = scene();
    // Ship and Earth share a 30 km/s heliocentric velocity: relative speed zero,
    // so there is no prograde direction to draw.
    snapshot.shipCoordinateVelocityKmS.set([30, 0, 0], 0);
    setBody(snapshot, 1, [0, 0, -10_000], [30, 0, 0]);
    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      false,
    );

    expect(marker(buffer, WorldMarkerIndex.PROGRADE).visible).toBe(false);
  });

  it('labels only the bodies inside the frustum, nearest to the ship first', () => {
    const snapshot = scene();
    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      true,
    );

    // Mars is behind the camera and drops out; Earth and the Sun are both on the
    // view axis, so the Sun's label would overprint Earth's and the nearer one
    // wins. The Moon is off to the side and survives.
    expect(buffer.labelCount).toBe(2);
    expect([...buffer.labelBodyIndices.slice(0, 2)]).toEqual([1, 2]);
    expect(buffer.labelDistancesKm[0]).toBeCloseTo(10_000, 6);
  });

  it('does no label work at all when the toggle is off', () => {
    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      scene(),
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      false,
    );

    expect(buffer.labelCount).toBe(0);
  });

  it('keeps the nearest slots when more bodies are visible than there are slots', () => {
    const manyIds = Object.freeze(
      Array.from({ length: BODY_LABEL_SLOT_COUNT + 4 }, (_unused, index) => `b${String(index)}`),
    );
    const snapshot = createSimulationSnapshotBuffer(manyIds);
    snapshot.dominantBodyIndex = -1;
    snapshot.targetBodyIndex = -1;
    // Farthest first, so a naive "first N wins" would keep exactly the wrong set.
    for (let index = 0; index < manyIds.length; index += 1) {
      setBody(snapshot, index, [0, 0, -(manyIds.length - index) * 1_000]);
    }
    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      true,
    );

    // Every candidate is on the view axis, so all but the nearest overprint it
    // and are dropped: the slot budget is filled before de-collision, and one
    // legible label beats eight stacked on the same pixel.
    expect(buffer.labelCount).toBe(1);
    expect(buffer.labelBodyIndices[0]).toBe(manyIds.length - 1);
  });

  it('keeps labels that are far enough apart to read', () => {
    const ids = Object.freeze(['a', 'b', 'c']);
    const snapshot = createSimulationSnapshotBuffer(ids);
    snapshot.dominantBodyIndex = -1;
    snapshot.targetBodyIndex = -1;
    // Spread across the frame: at 1600x800 with a 90 degree field these land
    // hundreds of pixels apart.
    setBody(snapshot, 0, [0, 0, -10_000]);
    setBody(snapshot, 1, [4_000, 2_000, -10_000]);
    setBody(snapshot, 2, [-4_000, -2_000, -10_000]);

    const buffer = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      WIDTH_PX,
      HEIGHT_PX,
      true,
    );

    expect(buffer.labelCount).toBe(3);
  });

  it('reuses one buffer and clears stale markers between samples', () => {
    const buffer = createWorldMarkerBuffer();
    const snapshot = scene();
    writeWorldMarkersInto(buffer, snapshot, pose(), WIDTH_PX, HEIGHT_PX, true);
    expect(marker(buffer, WorldMarkerIndex.TARGET).visible).toBe(true);
    expect(buffer.labelCount).toBeGreaterThan(0);

    snapshot.targetBodyIndex = -1;
    const same = writeWorldMarkersInto(buffer, snapshot, pose(), WIDTH_PX, HEIGHT_PX, false);

    expect(same).toBe(buffer);
    expect(marker(buffer, WorldMarkerIndex.TARGET).visible).toBe(false);
    expect(buffer.labelCount).toBe(0);
  });

  it('hides everything for a degenerate pose or a zero-sized viewport', () => {
    const snapshot = scene();
    const degenerate = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose({ lookDirection: { x: 0, y: 0, z: 0 } }),
      WIDTH_PX,
      HEIGHT_PX,
      true,
    );
    expect(degenerate.valid).toBe(false);
    expect(marker(degenerate, WorldMarkerIndex.TARGET).visible).toBe(false);

    const collapsed = writeWorldMarkersInto(
      createWorldMarkerBuffer(),
      snapshot,
      pose(),
      0,
      HEIGHT_PX,
      true,
    );
    expect(collapsed.valid).toBe(false);
  });

  /**
   * The ship is excluded structurally rather than by a filter. If a later task
   * appends the ship triple to the snapshot the way `EpochWorld.positionsKm`
   * does, this fails loudly instead of drawing a label on the player's own hull.
   */
  it('rejects a positions array that does not match the body count', () => {
    const snapshot = scene();
    const oversized = createSimulationSnapshotBuffer([...BODY_IDS, 'ship']);
    Object.defineProperty(snapshot, 'bodyPositionsKm', { value: oversized.bodyPositionsKm });

    expect(() =>
      writeWorldMarkersInto(createWorldMarkerBuffer(), snapshot, pose(), WIDTH_PX, HEIGHT_PX, true),
    ).toThrow(/one position triple per catalog body/u);
  });
});
