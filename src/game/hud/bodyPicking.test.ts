import { describe, expect, it } from 'vitest';

import {
  createSimulationSnapshotBuffer,
  type SimulationSnapshotBuffer,
} from '../../sim/simulationSnapshot.js';
import type { CameraPose } from '../cameraDirector.js';
import { MIN_PICK_RADIUS_PX, pickBodyIndexAtPixel } from './bodyPicking.js';

const WIDTH_PX = 1_600;
const HEIGHT_PX = 800;
const CENTER_X = WIDTH_PX / 2;
const CENTER_Y = HEIGHT_PX / 2;
const BODY_IDS = Object.freeze(['jupiter', 'io', 'bennu', 'behind']);

function pose(): CameraPose {
  return {
    positionKm: { x: 0, y: 0, z: 0 },
    lookDirection: { x: 0, y: 0, z: -1 },
    upDirection: { x: 0, y: 1, z: 0 },
    fovDeg: 90,
  };
}

/**
 * Io directly in front of Jupiter on the same ray, a sub-pixel asteroid well off
 * to the side, and one body behind the camera.
 *
 * At 1600x800 with a 90 degree vertical field, `tan(fov/2) = 1`, the aspect is 2
 * and the vertical half-height is 400 px, so the apparent radii are exactly:
 * Jupiter 69911/1e6 x 400 = 27.96 px, Io 1821.6/5e5 x 400 = 1.46 px (floored to
 * 8), Bennu 0.245/1e5 x 400 = 0.00098 px (floored to 8).
 */
function scene(): { snapshot: SimulationSnapshotBuffer; radiiKm: Float64Array } {
  const snapshot = createSimulationSnapshotBuffer(BODY_IDS);
  snapshot.bodyPositionsKm.set([0, 0, -1_000_000], 0);
  snapshot.bodyPositionsKm.set([0, 0, -500_000], 3);
  snapshot.bodyPositionsKm.set([75_000, 0, -100_000], 6);
  snapshot.bodyPositionsKm.set([0, 0, 100_000], 9);
  const radiiKm = Float64Array.from([69_911, 1_821.6, 0.245, 6_371]);
  return { snapshot, radiiKm };
}

/** Horizontal pixel offset of a body at `xKm` across `depthKm`. */
function offsetPx(xKm: number, depthKm: number): number {
  return (xKm / depthKm / (WIDTH_PX / HEIGHT_PX)) * (WIDTH_PX / 2);
}

function pick(x: number, y: number): number {
  const { snapshot, radiiKm } = scene();
  return pickBodyIndexAtPixel(snapshot, pose(), radiiKm, WIDTH_PX, HEIGHT_PX, x, y);
}

describe('angular-disc body picking - T0112', () => {
  /**
   * The rule that makes the feature usable rather than infuriating: both discs
   * contain the pixel, and the near one wins.
   */
  it('selects the nearest body along the ray when discs overlap', () => {
    expect(pick(CENTER_X, CENTER_Y)).toBe(1);
  });

  it('selects the far body once the near one no longer covers the pixel', () => {
    // Outside Io's 8 px floor, comfortably inside Jupiter's 27.96 px disc.
    expect(pick(CENTER_X + 15, CENTER_Y)).toBe(0);
  });

  /**
   * Without the floor, Bennu subtends a few millionths of a pixel and is
   * unclickable in practice — which would make click-to-target useless for
   * exactly the bodies the dropdown is worst at finding.
   */
  it('gives a sub-pixel body a minimum pick radius', () => {
    const { snapshot, radiiKm } = scene();
    const bennuX = CENTER_X + offsetPx(75_000, 100_000);
    expect(
      pickBodyIndexAtPixel(snapshot, pose(), radiiKm, WIDTH_PX, HEIGHT_PX, bennuX, CENTER_Y),
    ).toBe(2);
    // Just inside the floor still hits; well outside it does not.
    expect(
      pickBodyIndexAtPixel(
        snapshot,
        pose(),
        radiiKm,
        WIDTH_PX,
        HEIGHT_PX,
        bennuX + MIN_PICK_RADIUS_PX - 1,
        CENTER_Y,
      ),
    ).toBe(2);
    expect(
      pickBodyIndexAtPixel(
        snapshot,
        pose(),
        radiiKm,
        WIDTH_PX,
        HEIGHT_PX,
        bennuX + MIN_PICK_RADIUS_PX + 6,
        CENTER_Y,
      ),
    ).toBe(-1);
  });

  it('never selects a body behind the camera', () => {
    const snapshot = createSimulationSnapshotBuffer(BODY_IDS);
    // Everything astern, including a very large body straight behind.
    snapshot.bodyPositionsKm.set([0, 0, 100_000], 0);
    snapshot.bodyPositionsKm.set([0, 0, 200_000], 3);
    snapshot.bodyPositionsKm.set([0, 0, 300_000], 6);
    snapshot.bodyPositionsKm.set([0, 0, 400_000], 9);
    const radiiKm = Float64Array.from([69_911, 1_821.6, 0.245, 6_371]);

    expect(
      pickBodyIndexAtPixel(snapshot, pose(), radiiKm, WIDTH_PX, HEIGHT_PX, CENTER_X, CENTER_Y),
    ).toBe(-1);
  });

  it('returns -1 for empty sky rather than guessing', () => {
    expect(pick(20, 20)).toBe(-1);
  });

  it('returns -1 for a degenerate viewport or a non-finite pixel', () => {
    const { snapshot, radiiKm } = scene();
    expect(pickBodyIndexAtPixel(snapshot, pose(), radiiKm, 0, HEIGHT_PX, 1, 1)).toBe(-1);
    expect(
      pickBodyIndexAtPixel(snapshot, pose(), radiiKm, WIDTH_PX, HEIGHT_PX, Number.NaN, CENTER_Y),
    ).toBe(-1);
  });

  /**
   * The ship is excluded because `snapshot.bodyPositionsKm` holds catalog bodies
   * only; these guards make that structural instead of assumed.
   */
  it('rejects mismatched radius and position arrays', () => {
    const { snapshot } = scene();
    expect(() =>
      pickBodyIndexAtPixel(snapshot, pose(), new Float64Array(2), WIDTH_PX, HEIGHT_PX, 1, 1),
    ).toThrow(/one mean radius per catalog body/u);

    const oversized = createSimulationSnapshotBuffer([...BODY_IDS, 'ship']);
    Object.defineProperty(snapshot, 'bodyPositionsKm', { value: oversized.bodyPositionsKm });
    expect(() =>
      pickBodyIndexAtPixel(
        snapshot,
        pose(),
        Float64Array.from([1, 1, 1, 1]),
        WIDTH_PX,
        HEIGHT_PX,
        1,
        1,
      ),
    ).toThrow(/one position triple per catalog body/u);
  });
});
