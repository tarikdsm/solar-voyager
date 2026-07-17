import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import { compileRailsCatalog } from './propagation/rails.js';
import { SimulationCore } from './simulation.js';
import { DEFAULT_MAX_PROPER_ACCELERATION_M_S2 } from './ship/thrust.js';

const EARTH_MU_KM3_S2 = 398_600.4418;
const SHIP_MASS_KG = 10_000;

function earthCatalog() {
  return compileRailsCatalog([
    { id: 'earth', parentId: null, muKm3S2: EARTH_MU_KM3_S2, elements: null },
  ]);
}

function farFieldState(uxKmS = 0, uyKmS = 0): Float64Array {
  return new Float64Array([1e12, 0, 0, uxKmS, uyKmS, 0, 0]);
}

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected));
}

describe('SimulationCore energy ledger — physics-spec.md §5 / §7.7 / §7.10', () => {
  it('prices the analytic impulsive Hohmann LEO-to-GEO proper delta-v within 1%', () => {
    const canonicalHohmannDeltaVMS = 3_900;
    const burnCoordinateSec = canonicalHohmannDeltaVMS / DEFAULT_MAX_PROPER_ACCELERATION_M_S2;
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(),
      shipMassKg: SHIP_MASS_KG,
    });
    core.commands.setThrottle(1);

    const snapshot = core.step(burnCoordinateSec);

    expect(relativeError(snapshot.properDeltaVMS, canonicalHohmannDeltaVMS)).toBeLessThan(0.01);
    const expectedEnergyJ = SPEED_OF_LIGHT_KM_S * 1_000 * SHIP_MASS_KG * canonicalHohmannDeltaVMS;
    expect(relativeError(snapshot.energySpentJ, expectedEnergyJ)).toBeLessThan(0.01);
  });

  it('prices a continuous 90-degree turn above the impulsive momentum lower bound', () => {
    const celerityKmS = 30;
    const accelerationKmS2 = DEFAULT_MAX_PROPER_ACCELERATION_M_S2 / 1_000;
    const turnRateRadS = accelerationKmS2 / celerityKmS;
    const durationSec = Math.PI / (2 * turnRateRadS);
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(0, celerityKmS),
      shipMassKg: SHIP_MASS_KG,
    });
    core.commands.rotate(0, -turnRateRadS, 0);
    core.commands.setThrottle(1);

    const snapshot = core.step(durationSec);
    core.commands.setThrottle(0);

    const forceN = SHIP_MASS_KG * DEFAULT_MAX_PROPER_ACCELERATION_M_S2;
    const analyticProfileEnergyJ = forceN * SPEED_OF_LIGHT_KM_S * 1_000 * durationSec;
    expect(relativeError(snapshot.energySpentJ, analyticProfileEnergyJ)).toBeLessThan(0.02);
    const momentumChangeKgMS = SHIP_MASS_KG * celerityKmS * 1_000 * Math.sqrt(2);
    const impulsiveLowerBoundJ = SPEED_OF_LIGHT_KM_S * 1_000 * momentumChangeKgMS;
    expect(snapshot.energySpentJ).toBeGreaterThan(impulsiveLowerBoundJ);

    const burn = core.burnLog.get(0);
    expect(burn?.properDeltaVMS).toBeCloseTo(celerityKmS * 1_000 * (Math.PI / 2), 3);
    expect(burn?.radialDeltaVMS).toBeCloseTo(celerityKmS * 1_000, 1);
    expect(burn?.progradeDeltaVMS).toBeCloseTo(-celerityKmS * 1_000, 1);
    expect(Math.abs(burn?.normalDeltaVMS ?? Number.NaN)).toBeLessThan(1e-6);
  });

  it('produces the same nonzero ledger for equal 1x and 100x burn horizons', () => {
    const realtime = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(),
      shipMassKg: SHIP_MASS_KG,
    });
    const warped = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(),
      shipMassKg: SHIP_MASS_KG,
    });
    realtime.commands.setThrottle(0.4);
    warped.commands.setThrottle(0.4);
    warped.commands.setWarp(100);

    const realtimeSnapshot = realtime.step(10);
    const warpedSnapshot = warped.step(0.1);

    expect(realtimeSnapshot.energySpentJ).toBeGreaterThan(0);
    expect(warpedSnapshot.energySpentJ).toBeCloseTo(realtimeSnapshot.energySpentJ, 6);
    expect(warpedSnapshot.properDeltaVMS).toBeCloseTo(realtimeSnapshot.properDeltaVMS, 9);
  });

  it('does not publish ledger progress when propagation fails', () => {
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: farFieldState(),
      shipMassKg: SHIP_MASS_KG,
      integrationTolerance: {
        absolute: new Float64Array([1e-6, 1e-6, 1e-6, 1e-9, 1e-9, 1e-9, 1e-6]),
        relative: 1e-9,
        initialStepSec: 1,
        maxAcceptedSteps: 0,
      },
    });
    core.commands.setThrottle(1);

    expect(() => core.step(1)).toThrow(/integration budget/u);
    expect(core.snapshot.energySpentJ).toBe(0);
    expect(core.snapshot.properDeltaVMS).toBe(0);
    expect(core.burnLog.activeBurn?.energySpentJ).toBe(0);
  });
});
