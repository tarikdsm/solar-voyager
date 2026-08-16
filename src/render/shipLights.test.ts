import { MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { describe, expect, test } from 'vitest';

import {
  BEACON_DOUBLE_GAP_SEC,
  BEACON_FLOOR_MULTIPLIER,
  BEACON_PEAK_MULTIPLIER,
  BEACON_PERIOD_SEC,
  NAV_BREATHE_DEPTH,
  beaconIntensityFactor,
  navIntensityFactor,
  ShipLights,
} from './shipLights.js';

function lightMaterial(name: string, emissiveIntensity: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial();
  material.name = name;
  material.emissiveIntensity = emissiveIntensity;
  return material;
}

/** The authored strengths from `ship_config.py`'s `MaterialSpec` rows. */
function shipMaterials(): MeshStandardMaterial[] {
  return [
    lightMaterial('mat_hull', 1),
    lightMaterial('mat_light_beacon', 1.4),
    lightMaterial('mat_light_nav_l', 1.2),
    lightMaterial('mat_light_nav_r', 1.2),
  ];
}

describe('beacon waveform', () => {
  test('is a double flash: two peaks per period, dark between and after', () => {
    expect(beaconIntensityFactor(0)).toBeCloseTo(BEACON_PEAK_MULTIPLIER, 12);
    expect(beaconIntensityFactor(BEACON_DOUBLE_GAP_SEC)).toBeCloseTo(BEACON_PEAK_MULTIPLIER, 12);
    expect(beaconIntensityFactor(BEACON_DOUBLE_GAP_SEC / 2)).toBeCloseTo(
      BEACON_FLOOR_MULTIPLIER,
      12,
    );
    expect(beaconIntensityFactor(0.8)).toBeCloseTo(BEACON_FLOOR_MULTIPLIER, 12);
  });

  test('repeats on the sim-time period, with no seam at the wrap', () => {
    for (const time of [0, 0.11, 0.22, 0.5, 1.2, 1.59]) {
      expect(beaconIntensityFactor(time + BEACON_PERIOD_SEC)).toBeCloseTo(
        beaconIntensityFactor(time),
        10,
      );
    }
    expect(beaconIntensityFactor(BEACON_PERIOD_SEC - 1e-9)).toBeCloseTo(BEACON_PEAK_MULTIPLIER, 6);
  });

  test('phases correctly for negative simulation times', () => {
    expect(beaconIntensityFactor(-BEACON_PERIOD_SEC)).toBeCloseTo(BEACON_PEAK_MULTIPLIER, 10);
    expect(beaconIntensityFactor(-0.8)).toBeCloseTo(BEACON_FLOOR_MULTIPLIER, 10);
  });

  test('never leaves the floor-to-peak band, and holds the floor on a NaN', () => {
    for (let step = 0; step < 400; step += 1) {
      const value = beaconIntensityFactor((step / 400) * BEACON_PERIOD_SEC);
      expect(value).toBeGreaterThanOrEqual(BEACON_FLOOR_MULTIPLIER - 1e-12);
      expect(value).toBeLessThanOrEqual(BEACON_PEAK_MULTIPLIER + 1e-12);
    }
    expect(beaconIntensityFactor(Number.NaN)).toBe(BEACON_FLOOR_MULTIPLIER);
  });
});

describe('navigation waveform', () => {
  test('breathes shallowly about the authored value', () => {
    expect(navIntensityFactor(0)).toBeCloseTo(1, 12);
    expect(navIntensityFactor(1)).toBeCloseTo(1 + NAV_BREATHE_DEPTH, 12);
    expect(navIntensityFactor(3)).toBeCloseTo(1 - NAV_BREATHE_DEPTH, 12);
    expect(navIntensityFactor(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('ShipLights', () => {
  test('adopts exactly the three authored light materials', () => {
    const lights = new ShipLights();
    expect(lights.bind(shipMaterials())).toBe(3);
    expect(lights.boundCount).toBe(3);
  });

  test('ignores materials that are not standard, without throwing', () => {
    const lights = new ShipLights();
    const basic = new MeshBasicMaterial();
    basic.name = 'mat_light_beacon';
    expect(lights.bind([basic])).toBe(0);
  });

  test('scales the authored emissive strength rather than replacing it', () => {
    const materials = shipMaterials();
    const lights = new ShipLights();
    lights.bind(materials);
    lights.update(0);
    expect(materials[1]?.emissiveIntensity).toBeCloseTo(1.4 * BEACON_PEAK_MULTIPLIER, 12);
    expect(materials[2]?.emissiveIntensity).toBeCloseTo(1.2, 12);
    expect(materials[0]?.emissiveIntensity).toBe(1);
  });

  test('a frozen sim time freezes the blink — this is what pause buys', () => {
    const materials = shipMaterials();
    const lights = new ShipLights();
    lights.bind(materials);
    lights.update(0.05);
    const paused = materials[1]?.emissiveIntensity;
    lights.update(0.05);
    expect(materials[1]?.emissiveIntensity).toBe(paused);
    // 0.22 s is the second pulse of the double flash, so advancing sim time
    // demonstrably moves what a frozen clock was holding.
    lights.update(BEACON_DOUBLE_GAP_SEC);
    expect(materials[1]?.emissiveIntensity).toBeCloseTo(1.4 * BEACON_PEAK_MULTIPLIER, 12);
  });

  test('unbinding restores every authored value', () => {
    const materials = shipMaterials();
    const lights = new ShipLights();
    lights.bind(materials);
    lights.update(0);
    lights.unbind();
    expect(materials[1]?.emissiveIntensity).toBeCloseTo(1.4, 12);
    expect(materials[2]?.emissiveIntensity).toBeCloseTo(1.2, 12);
    expect(lights.boundCount).toBe(0);
  });

  test('update before bind is a no-op that still publishes the waveform', () => {
    const lights = new ShipLights();
    expect(() => {
      lights.update(0.3);
    }).not.toThrow();
    expect(lights.beaconFactor).toBeCloseTo(beaconIntensityFactor(0.3), 12);
    expect(lights.navFactor).toBeCloseTo(navIntensityFactor(0.3), 12);
  });
});
