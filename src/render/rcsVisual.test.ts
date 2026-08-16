import { describe, expect, test } from 'vitest';

import {
  RCS_BELL_COUNT,
  RCS_BELL_POSITIONS_M,
  RCS_BELL_TORQUE_AXES,
  RCS_FULL_RATE_RAD_S,
  RCS_MIN_RATE_RAD_S,
  RcsVisual,
  writeRcsWeightsInto,
} from './rcsVisual.js';
import { createRadialSpriteTexture } from './additivePointSprite.js';
import { SHIP_RCS_POD_ORIGINS_M } from './shipEffectAnchors.js';

/** `pod` is 1-based; `bell` is 0:+X 1:-X 2:+Y 3:-Y, matching the build order. */
function bellIndex(pod: number, bell: number): number {
  return (pod - 1) * 4 + bell;
}

function liveIndices(weights: Float32Array): number[] {
  const live: number[] = [];
  for (let index = 0; index < RCS_BELL_COUNT; index += 1) {
    if ((weights[index] ?? 0) > 0) live.push(index);
  }
  return live;
}

describe('RCS bell table', () => {
  test('is sixteen bells: four pods times four bells', () => {
    expect(RCS_BELL_COUNT).toBe(16);
    expect(RCS_BELL_POSITIONS_M).toHaveLength(48);
    expect(RCS_BELL_TORQUE_AXES).toHaveLength(48);
  });

  test('each bell sits on its pod, offset along its own exhaust axis', () => {
    for (let pod = 0; pod < 4; pod += 1) {
      const origin = SHIP_RCS_POD_ORIGINS_M[pod] as readonly [number, number, number];
      for (let bell = 0; bell < 4; bell += 1) {
        const offset = (pod * 4 + bell) * 3;
        const dx = (RCS_BELL_POSITIONS_M[offset] as number) - origin[0];
        const dy = (RCS_BELL_POSITIONS_M[offset + 1] as number) - origin[1];
        const dz = (RCS_BELL_POSITIONS_M[offset + 2] as number) - origin[2];
        // Axial bells sit further out than tangential ones (0.68 vs 0.48, plus
        // the 0.22 standoff), and no bell may drift off its own axis.
        const distance = Math.hypot(dx, dy, dz);
        expect(distance).toBeCloseTo(bell < 2 ? 0.9 : 0.7, 12);
        expect(Math.abs(dz)).toBeCloseTo(0, 12);
      }
    }
  });

  test('every torque axis is a unit vector', () => {
    for (let index = 0; index < RCS_BELL_COUNT; index += 1) {
      const offset = index * 3;
      expect(
        Math.hypot(
          RCS_BELL_TORQUE_AXES[offset] as number,
          RCS_BELL_TORQUE_AXES[offset + 1] as number,
          RCS_BELL_TORQUE_AXES[offset + 2] as number,
        ),
      ).toBeCloseTo(1, 12);
    }
  });
});

describe('bell allocation', () => {
  const weights = new Float32Array(RCS_BELL_COUNT);

  test('a pure yaw fires the four fore/aft bells that make the couple', () => {
    // Body +Z (yaw, up) maps to model +Y. Both port pods push the ship aft and
    // both starboard pods push it forward: nose to port.
    const live = writeRcsWeightsInto(weights, 0, RCS_FULL_RATE_RAD_S, 0, RCS_BELL_COUNT);
    expect(live).toBe(4);
    expect(liveIndices(weights)).toEqual([
      bellIndex(1, 0),
      bellIndex(2, 1),
      bellIndex(3, 0),
      bellIndex(4, 1),
    ]);
    // Those four are exactly aligned with the command, so they burn at full.
    expect(weights[bellIndex(1, 0)]).toBeCloseTo(1, 6);
  });

  test('reversing the yaw fires the complementary four', () => {
    writeRcsWeightsInto(weights, 0, -RCS_FULL_RATE_RAD_S, 0, RCS_BELL_COUNT);
    expect(liveIndices(weights)).toEqual([
      bellIndex(1, 1),
      bellIndex(2, 0),
      bellIndex(3, 1),
      bellIndex(4, 0),
    ]);
  });

  test('a pure pitch fires the tangential bells, not the fore/aft ones', () => {
    // Body +Y (pitch) maps to model -Z.
    const live = writeRcsWeightsInto(weights, 0, 0, -RCS_FULL_RATE_RAD_S, RCS_BELL_COUNT);
    expect(live).toBe(4);
    expect(liveIndices(weights)).toEqual([
      bellIndex(1, 2),
      bellIndex(2, 2),
      bellIndex(3, 3),
      bellIndex(4, 3),
    ]);
  });

  test('a pure roll fires the other tangential set', () => {
    const live = writeRcsWeightsInto(weights, RCS_FULL_RATE_RAD_S, 0, 0, RCS_BELL_COUNT);
    expect(live).toBe(4);
    expect(liveIndices(weights)).toEqual([
      bellIndex(1, 3),
      bellIndex(2, 2),
      bellIndex(3, 3),
      bellIndex(4, 2),
    ]);
    // A roll couple has a shorter lever arm than a yaw couple on this hull, so
    // it is deliberately dimmer rather than clamped up to parity.
    expect(weights[bellIndex(1, 3)] as number).toBeGreaterThan(0.3);
    expect(weights[bellIndex(1, 3)] as number).toBeLessThan(0.4);
  });

  test('never lights more than the pool, whatever the command', () => {
    const live = writeRcsWeightsInto(weights, 0.4, -0.3, 0.2, RCS_BELL_COUNT);
    expect(live).toBeLessThanOrEqual(RCS_BELL_COUNT);
    expect(live).toBeGreaterThan(0);
  });

  test('drift below the command threshold fires nothing', () => {
    expect(writeRcsWeightsInto(weights, 0, RCS_MIN_RATE_RAD_S * 0.5, 0, RCS_BELL_COUNT)).toBe(0);
    expect(liveIndices(weights)).toEqual([]);
  });

  test('brightness saturates at the full rate instead of growing without bound', () => {
    writeRcsWeightsInto(weights, 0, RCS_FULL_RATE_RAD_S * 10, 0, RCS_BELL_COUNT);
    expect(weights[bellIndex(1, 0)]).toBeCloseTo(1, 6);
    writeRcsWeightsInto(weights, 0, RCS_FULL_RATE_RAD_S * 0.5, 0, RCS_BELL_COUNT);
    expect(weights[bellIndex(1, 0)]).toBeCloseTo(0.5, 6);
  });

  test('the governor cap truncates the live set and zero silences it', () => {
    expect(writeRcsWeightsInto(weights, 0.2, 0.2, 0.2, 2)).toBe(2);
    expect(writeRcsWeightsInto(weights, 0.2, 0.2, 0.2, 0)).toBe(0);
    expect(liveIndices(weights)).toEqual([]);
  });

  test('a non-finite rate is treated as no command, not as an error', () => {
    expect(writeRcsWeightsInto(weights, Number.NaN, 0, 0, RCS_BELL_COUNT)).toBe(0);
  });

  test('rejects a buffer that cannot hold the pool', () => {
    expect(() => writeRcsWeightsInto(new Float32Array(4), 0, 1, 0, 16)).toThrow(RangeError);
  });
});

describe('RcsVisual', () => {
  test('is one hidden, blanked draw object before anything fires', () => {
    const visual = new RcsVisual(createRadialSpriteTexture());
    try {
      expect(visual.points.visible).toBe(false);
      expect(visual.points.renderOrder).toBe(2);
      expect(visual.points.material.depthWrite).toBe(false);
      expect(visual.points.material.depthTest).toBe(true);
      expect(visual.points.geometry.getAttribute('position').count).toBe(RCS_BELL_COUNT);
      const sizes = visual.points.geometry.getAttribute('aPuffSize').array as Float32Array;
      expect(Array.from(sizes).every((value) => value === 0)).toBe(true);
    } finally {
      visual.dispose();
    }
  });

  test('shows on a rotation command and hides again when it stops', () => {
    const visual = new RcsVisual(createRadialSpriteTexture());
    try {
      visual.setRateModel(0, RCS_FULL_RATE_RAD_S, 0);
      expect(visual.firing).toBe(true);
      expect(visual.livePuffCount).toBe(4);
      visual.setRateModel(0, 0, 0);
      expect(visual.firing).toBe(false);
      expect(visual.livePuffCount).toBe(0);
    } finally {
      visual.dispose();
    }
  });

  test('the governor cap is clamped to the pool and rejects nonsense', () => {
    const visual = new RcsVisual(createRadialSpriteTexture());
    try {
      visual.setLiveCap(64);
      expect(visual.liveCapacity).toBe(RCS_BELL_COUNT);
      visual.setLiveCap(8);
      expect(visual.liveCapacity).toBe(8);
      expect(() => visual.setLiveCap(-1)).toThrow(RangeError);
    } finally {
      visual.dispose();
    }
  });
});
