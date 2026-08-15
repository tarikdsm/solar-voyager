import { describe, expect, it } from 'vitest';

import {
  clamp,
  firstOrderLagBlend,
  interpolateLogarithmic,
  slerpQuaternionInto,
  slerpUnitDirectionInto,
  smootherstep,
} from './cameraTransition.js';

function angleBetween(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  const dot = clamp(left[0] * right[0] + left[1] * right[1] + left[2] * right[2], -1, 1);
  return Math.acos(dot);
}

describe('cameraTransition', () => {
  describe('smootherstep', () => {
    it('pins the endpoints and their first two derivatives', () => {
      expect(smootherstep(0)).toBe(0);
      expect(smootherstep(1)).toBe(1);
      expect(smootherstep(0.5)).toBeCloseTo(0.5, 15);
      // C2 continuity is why a focus transfer never visibly starts or stops: the
      // leading term is 10t^3, so the average slope over [0, eps] is 10*eps^2 —
      // it vanishes quadratically rather than linearly at both ends.
      const epsilon = 1e-4;
      const quadraticBound = 11 * epsilon * epsilon;
      expect(smootherstep(epsilon) / epsilon).toBeLessThan(quadraticBound);
      expect((1 - smootherstep(1 - epsilon)) / epsilon).toBeLessThan(quadraticBound);
    });

    it('is monotone across the unit interval', () => {
      let previous = -1;
      for (let step = 0; step <= 100; step += 1) {
        const value = smootherstep(step / 100);
        expect(value).toBeGreaterThan(previous);
        previous = value;
      }
    });
  });

  describe('interpolateLogarithmic', () => {
    it('moves the ratio, not the difference', () => {
      // The whole reason it exists: 157 m to 210,000 km is six orders of
      // magnitude, and the midpoint of a linear blend would be visually
      // indistinguishable from the far end.
      expect(interpolateLogarithmic(0.157, 210_000, 0)).toBeCloseTo(0.157, 12);
      expect(interpolateLogarithmic(0.157, 210_000, 1)).toBeCloseTo(210_000, 6);
      expect(interpolateLogarithmic(1, 100, 0.5)).toBeCloseTo(10, 12);
      expect(interpolateLogarithmic(1, 1_000, 1 / 3)).toBeCloseTo(10, 12);
    });

    it('rejects non-positive or non-finite distances', () => {
      expect(() => interpolateLogarithmic(0, 10, 0.5)).toThrow(/positive finite/u);
      expect(() => interpolateLogarithmic(10, -1, 0.5)).toThrow(/positive finite/u);
      expect(() => interpolateLogarithmic(1, 10, Number.NaN)).toThrow(/blend must be finite/u);
    });
  });

  describe('slerpUnitDirectionInto', () => {
    it('sweeps a constant angle per unit of blend', () => {
      const out = new Float64Array(3);
      const quarter = angleBetween([1, 0, 0], [
        ...(slerpUnitDirectionInto(out, 1, 0, 0, 0, 1, 0, 0.25) as unknown as number[]),
      ] as [number, number, number]);
      const half = angleBetween([1, 0, 0], [
        ...(slerpUnitDirectionInto(out, 1, 0, 0, 0, 1, 0, 0.5) as unknown as number[]),
      ] as [number, number, number]);
      expect(quarter).toBeCloseTo(Math.PI / 8, 12);
      expect(half).toBeCloseTo(Math.PI / 4, 12);
    });

    it('returns unit vectors at both endpoints', () => {
      const out = new Float64Array(3);
      slerpUnitDirectionInto(out, 1, 0, 0, 0, 0, 1, 0);
      expect([...out]).toEqual([1, 0, 0]);
      slerpUnitDirectionInto(out, 1, 0, 0, 0, 0, 1, 1);
      expect(out[0]).toBeCloseTo(0, 12);
      expect(out[2]).toBeCloseTo(1, 12);
    });

    it('keeps the start direction for antipodal inputs instead of picking a random arc', () => {
      const out = new Float64Array(3);
      slerpUnitDirectionInto(out, 0, 0, 1, 0, 0, -1, 0.5);
      // There is no shortest arc between opposite directions; inventing one would
      // make the blend depend on float noise rather than on the inputs.
      expect([...out]).toEqual([0, 0, 1]);
    });

    it('stays unit-length for nearly parallel inputs where sin(theta) underflows', () => {
      const out = new Float64Array(3);
      slerpUnitDirectionInto(out, 1, 0, 0, Math.cos(1e-9), Math.sin(1e-9), 0, 0.5);
      expect(Math.hypot(out[0] as number, out[1] as number, out[2] as number)).toBeCloseTo(1, 15);
    });
  });

  describe('slerpQuaternionInto', () => {
    it('takes the shortest arc even when the target has the opposite sign', () => {
      const out = new Float64Array(4);
      const start = new Float64Array([0, 0, 0, 1]);
      // Same rotation as [0,0,sin(pi/8),cos(pi/8)], written with a negated
      // scalar: a naive lerp would go the long way round, 315 degrees of it.
      const end = new Float64Array([0, 0, -Math.sin(Math.PI / 8), -Math.cos(Math.PI / 8)]);
      slerpQuaternionInto(out, start, end, 1);
      const dot = Math.abs(
        (out[2] as number) * Math.sin(Math.PI / 8) + (out[3] as number) * Math.cos(Math.PI / 8),
      );
      expect(dot).toBeCloseTo(1, 12);
    });

    it('produces a normalized quaternion at every blend', () => {
      const out = new Float64Array(4);
      const start = new Float64Array([0, 0, 0, 1]);
      const end = new Float64Array([Math.sin(Math.PI / 3), 0, 0, Math.cos(Math.PI / 3)]);
      for (let step = 0; step <= 10; step += 1) {
        slerpQuaternionInto(out, start, end, step / 10);
        expect(
          Math.hypot(out[0] as number, out[1] as number, out[2] as number, out[3] as number),
        ).toBeCloseTo(1, 15);
      }
    });

    it('covers exactly the blended fraction of the arc', () => {
      const out = new Float64Array(4);
      const start = new Float64Array([0, 0, 0, 1]);
      const halfAngle = Math.PI / 4; // a 90 degree rotation
      const end = new Float64Array([0, 0, Math.sin(halfAngle), Math.cos(halfAngle)]);
      slerpQuaternionInto(out, start, end, 0.25);
      const covered = 2 * Math.acos(Math.abs(out[3] as number));
      expect(covered).toBeCloseTo(0.25 * (Math.PI / 2), 12);
    });
  });

  describe('firstOrderLagBlend', () => {
    it('removes 1 - 1/e of the error in one time constant', () => {
      expect(firstOrderLagBlend(0.12, 0.12)).toBeCloseTo(1 - Math.exp(-1), 15);
      expect(firstOrderLagBlend(0, 0.12)).toBe(0);
    });

    it('composes across steps exactly as one long step', () => {
      // Why the field-of-view smoothing can be specified as "98 % in 0.5 s" and
      // still be frame-rate independent.
      let remaining = 1;
      for (let step = 0; step < 30; step += 1) remaining *= 1 - firstOrderLagBlend(1 / 60, 0.12783);
      expect(1 - remaining).toBeCloseTo(1 - Math.exp(-0.5 / 0.12783), 12);
    });

    it('rejects a non-positive time constant or a negative delta', () => {
      expect(() => firstOrderLagBlend(-1, 0.12)).toThrow(/finite and nonnegative/u);
      expect(() => firstOrderLagBlend(0.1, 0)).toThrow(/finite and positive/u);
    });
  });
});
