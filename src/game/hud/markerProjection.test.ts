import { describe, expect, it } from 'vitest';

import type { CameraPose } from '../cameraDirector.js';
import {
  CAMERA_BASIS_COMPONENTS,
  PROJECTED_POINT_COMPONENTS,
  apparentRadiusPx,
  clampToViewportEdge,
  projectPointInto,
  writeCameraBasisInto,
} from './markerProjection.js';

const WIDTH_PX = 1_600;
const HEIGHT_PX = 800;

/** Looking down -Z with +Y up: the three.js default the observatory camera reports. */
function pose(overrides: Partial<CameraPose> = {}): CameraPose {
  return {
    positionKm: { x: 0, y: 0, z: 0 },
    lookDirection: { x: 0, y: 0, z: -1 },
    upDirection: { x: 0, y: 1, z: 0 },
    fovDeg: 90,
    ...overrides,
  };
}

function project(point: readonly [number, number, number], from = pose()): Float64Array {
  const basis = new Float64Array(CAMERA_BASIS_COMPONENTS);
  expect(writeCameraBasisInto(basis, from)).toBe(true);
  const out = new Float64Array(PROJECTED_POINT_COMPONENTS);
  projectPointInto(
    out,
    basis,
    from.positionKm.x,
    from.positionKm.y,
    from.positionKm.z,
    point[0],
    point[1],
    point[2],
    WIDTH_PX,
    HEIGHT_PX,
  );
  return out;
}

describe('marker camera basis - T0112', () => {
  /**
   * The convention has to match `render/cameraRig.ts`, which hands the direction
   * to `PerspectiveCamera.lookAt` with the camera at the render origin. If this
   * drifts the diamond stops sitting on the planet, and nothing else would catch
   * it: the renderer and the overlay would each be internally consistent.
   */
  it('reproduces the three.js lookAt frame: right = f x up, up = r x f', () => {
    const basis = new Float64Array(CAMERA_BASIS_COMPONENTS);
    expect(writeCameraBasisInto(basis, pose())).toBe(true);
    // Component-wise, because a cross product legitimately produces signed zero
    // and `toEqual` distinguishes -0 from 0.
    for (const [index, expected] of [
      [0, 0],
      [1, 0],
      [2, -1],
      [3, 1],
      [4, 0],
      [5, 0],
      [6, 0],
      [7, 1],
      [8, 0],
      [9, 1],
    ] as const) {
      expect(basis[index]).toBeCloseTo(expected, 12);
    }
  });

  it('normalizes a non-unit look direction and a non-orthogonal up hint', () => {
    const basis = new Float64Array(CAMERA_BASIS_COMPONENTS);
    // `upDirection` is documented as a *hint*: 45 degrees off, and still valid.
    expect(
      writeCameraBasisInto(
        basis,
        pose({ lookDirection: { x: 0, y: 0, z: -7 }, upDirection: { x: 0, y: 1, z: -1 } }),
      ),
    ).toBe(true);
    expect(Math.hypot(basis[0] as number, basis[1] as number, basis[2] as number)).toBeCloseTo(1);
    expect(Math.hypot(basis[3] as number, basis[4] as number, basis[5] as number)).toBeCloseTo(1);
    expect(Math.hypot(basis[6] as number, basis[7] as number, basis[8] as number)).toBeCloseTo(1);
    // Orthogonality is recovered, not assumed.
    const dot =
      (basis[0] as number) * (basis[6] as number) +
      (basis[1] as number) * (basis[7] as number) +
      (basis[2] as number) * (basis[8] as number);
    expect(dot).toBeCloseTo(0, 12);
  });

  it('refuses a degenerate pose instead of producing a garbage frame', () => {
    const basis = new Float64Array(CAMERA_BASIS_COMPONENTS);
    expect(writeCameraBasisInto(basis, pose({ lookDirection: { x: 0, y: 0, z: 0 } }))).toBe(false);
    // An up hint parallel to the look direction is *not* a failure: three.js
    // nudges its frame and keeps rendering, and so does this.
    expect(writeCameraBasisInto(basis, pose({ upDirection: { x: 0, y: 0, z: -1 } }))).toBe(true);
    expect(Math.hypot(basis[3] as number, basis[4] as number, basis[5] as number)).toBeCloseTo(
      1,
      9,
    );
    expect(Math.hypot(basis[6] as number, basis[7] as number, basis[8] as number)).toBeCloseTo(
      1,
      9,
    );
    // The nudged forward axis is still, to a ten-thousandth, the one asked for.
    expect(basis[2]).toBeCloseTo(-1, 6);
    expect(writeCameraBasisInto(basis, pose({ fovDeg: 0 }))).toBe(false);
    expect(writeCameraBasisInto(basis, pose({ fovDeg: 180 }))).toBe(false);
  });

  it('throws rather than truncating an undersized output buffer', () => {
    expect(() => writeCameraBasisInto(new Float64Array(4), pose())).toThrow(/camera basis/u);
  });
});

describe('marker point projection - T0112', () => {
  it('puts a point on the view axis at the viewport centre', () => {
    const out = project([0, 0, -1_000]);
    expect(out[0]).toBeCloseTo(WIDTH_PX / 2, 9);
    expect(out[1]).toBeCloseTo(HEIGHT_PX / 2, 9);
    expect(out[2]).toBeCloseTo(1_000, 9);
  });

  /**
   * Known pose, known answer. At a 90 degree vertical field the half-height of
   * the frustum equals the depth, so a point one depth above centre lands exactly
   * on the top edge, and the horizontal case is that scaled by the aspect ratio.
   */
  it('places frustum-edge points on the viewport edges', () => {
    const top = project([0, 1_000, -1_000]);
    expect(top[1]).toBeCloseTo(0, 6);
    const right = project([2_000, 0, -1_000]);
    expect(right[0]).toBeCloseTo(WIDTH_PX, 6);
    const bottomLeft = project([-2_000, -1_000, -1_000]);
    expect(bottomLeft[0]).toBeCloseTo(0, 6);
    expect(bottomLeft[1]).toBeCloseTo(HEIGHT_PX, 6);
  });

  it('keeps float64 precision at interplanetary range', () => {
    // 1e9 km out, offset by one Earth radius: a f32 pipeline would quantise this
    // offset away entirely.
    const out = project([6_371.0084, 0, -1e9]);
    expect(out[2]).toBeCloseTo(1e9, 3);
    const offsetPx = (out[0] as number) - WIDTH_PX / 2;
    expect(offsetPx).toBeGreaterThan(0);
    // ndcX = cx / (cz * tan(fov/2) * aspect); aspect is 2 at 1600x800.
    const aspect = WIDTH_PX / HEIGHT_PX;
    expect(offsetPx).toBeCloseTo((6_371.0084 / 1e9 / aspect) * (WIDTH_PX / 2), 12);
  });

  it('reports a negative depth behind the camera and keeps the bearing honest', () => {
    const behind = project([500, 0, 1_000]);
    expect(behind[2]).toBeLessThan(0);
    // Dividing by |depth| rather than depth: a target directly astern and to the
    // right must not be drawn to the left of centre before the mirror step.
    expect(behind[0]).toBeGreaterThan(WIDTH_PX / 2);
  });

  it('writes NaN rather than infinity for a point at the camera', () => {
    const out = project([0, 0, 0]);
    expect(Number.isNaN(out[0] as number)).toBe(true);
    expect(Number.isNaN(out[2] as number)).toBe(true);
  });

  it('tracks a moved camera', () => {
    const moved = project([1_000, 0, -1_000], pose({ positionKm: { x: 1_000, y: 0, z: 0 } }));
    expect(moved[0]).toBeCloseTo(WIDTH_PX / 2, 9);
  });
});

describe('apparent radius and edge clamping - T0112', () => {
  it('scales the apparent radius inversely with distance', () => {
    const near = apparentRadiusPx(6_371, 100_000, 1, HEIGHT_PX);
    const far = apparentRadiusPx(6_371, 200_000, 1, HEIGHT_PX);
    expect(near).toBeCloseTo(far * 2, 9);
    expect(apparentRadiusPx(6_371, -1, 1, HEIGHT_PX)).toBe(0);
    expect(apparentRadiusPx(0, 1_000, 1, HEIGHT_PX)).toBe(0);
  });

  it('leaves an on-screen point alone and reports it as on-screen', () => {
    const out = Float64Array.from([800, 400, 1]);
    expect(clampToViewportEdge(out, WIDTH_PX, HEIGHT_PX, 28, false)).toBe(false);
    expect([out[0], out[1]]).toEqual([800, 400]);
  });

  it('pins an off-screen point to the border along its bearing', () => {
    const out = Float64Array.from([5_000, 400, 1]);
    expect(clampToViewportEdge(out, WIDTH_PX, HEIGHT_PX, 28, false)).toBe(true);
    expect(out[0]).toBeCloseTo(WIDTH_PX - 28, 9);
    expect(out[1]).toBeCloseTo(HEIGHT_PX / 2, 9);
  });

  it('mirrors a behind-camera point and always pins it, even mid-screen', () => {
    // Astern and to the right: the arrow belongs on the *right* edge, and it must
    // be pinned rather than drawn floating in the middle of the view.
    const out = Float64Array.from([WIDTH_PX / 2 - 100, HEIGHT_PX / 2, 1]);
    expect(clampToViewportEdge(out, WIDTH_PX, HEIGHT_PX, 28, true)).toBe(true);
    expect(out[0]).toBeCloseTo(WIDTH_PX - 28, 9);
  });
});
