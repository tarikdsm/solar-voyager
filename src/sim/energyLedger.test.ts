import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../core/constants.js';
import { compileRailsCatalog } from './propagation/rails.js';
import { SimulationCore } from './simulation.js';
import { DEFAULT_MAX_PROPER_ACCELERATION_M_S2 } from './ship/thrust.js';

const EARTH_MU_KM3_S2 = 398_600.4418;
const EARTH_RADIUS_KM = 6_378.137;
const GEO_RADIUS_KM = 42_164;
const SHIP_MASS_KG = 10_000;

function earthCatalog() {
  return compileRailsCatalog([
    { id: 'earth', parentId: null, muKm3S2: EARTH_MU_KM3_S2, elements: null },
  ]);
}

function farFieldState(uxKmS = 0, uyKmS = 0): Float64Array {
  return new Float64Array([1e12, 0, 0, uxKmS, uyKmS, 0, 0]);
}

function circularEarthState(radiusKm: number): Float64Array {
  const speedKmS = Math.sqrt(EARTH_MU_KM3_S2 / radiusKm);
  const gamma = 1 / Math.sqrt(1 - (speedKmS / SPEED_OF_LIGHT_KM_S) ** 2);
  return new Float64Array([radiusKm, 0, 0, 0, gamma * speedKmS, 0, 0]);
}

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected));
}

describe('SimulationCore energy ledger — physics-spec.md §5 / §7.7 / §7.10', () => {
  it('prices the analytic impulsive Hohmann LEO-to-GEO proper delta-v within 1%', () => {
    const leoRadiusKm = EARTH_RADIUS_KM + 300;
    const transferSemiMajorKm = (leoRadiusKm + GEO_RADIUS_KM) / 2;
    const leoSpeedKmS = Math.sqrt(EARTH_MU_KM3_S2 / leoRadiusKm);
    const geoSpeedKmS = Math.sqrt(EARTH_MU_KM3_S2 / GEO_RADIUS_KM);
    const transferPerigeeSpeedKmS = Math.sqrt(
      EARTH_MU_KM3_S2 * (2 / leoRadiusKm - 1 / transferSemiMajorKm),
    );
    const transferApogeeSpeedKmS = Math.sqrt(
      EARTH_MU_KM3_S2 * (2 / GEO_RADIUS_KM - 1 / transferSemiMajorKm),
    );
    const firstBurnDeltaVMS = (transferPerigeeSpeedKmS - leoSpeedKmS) * 1_000;
    const secondBurnDeltaVMS = (geoSpeedKmS - transferApogeeSpeedKmS) * 1_000;
    const analyticDeltaVMS = firstBurnDeltaVMS + secondBurnDeltaVMS;
    const impulsiveAccelerationMS2 = 1_000;
    const firstBurnSec = firstBurnDeltaVMS / impulsiveAccelerationMS2;
    const secondBurnSec = secondBurnDeltaVMS / impulsiveAccelerationMS2;
    const transferHalfPeriodSec = Math.PI * Math.sqrt(transferSemiMajorKm ** 3 / EARTH_MU_KM3_S2);
    const core = new SimulationCore({
      catalog: earthCatalog(),
      initialShipState: circularEarthState(leoRadiusKm),
      shipMassKg: SHIP_MASS_KG,
      maxProperAccelerationMS2: impulsiveAccelerationMS2,
    });
    core.commands.setAttitudeMode('prograde');
    core.commands.setThrottle(1);
    core.step(firstBurnSec);
    core.commands.setThrottle(0);
    const coastSnapshot = core.step(transferHalfPeriodSec - firstBurnSec / 2);
    const apogeeRadiusKm = Math.hypot(
      coastSnapshot.shipState[0] as number,
      coastSnapshot.shipState[1] as number,
      coastSnapshot.shipState[2] as number,
    );
    core.commands.setThrottle(1);
    const snapshot = core.step(secondBurnSec);
    core.commands.setThrottle(0);

    expect(relativeError(apogeeRadiusKm, GEO_RADIUS_KM)).toBeLessThan(0.01);
    expect(relativeError(snapshot.properDeltaVMS, analyticDeltaVMS)).toBeLessThan(0.01);
    expect(relativeError(snapshot.properDeltaVMS, 3_900)).toBeLessThan(0.01);
    const expectedEnergyJ = SPEED_OF_LIGHT_KM_S * 1_000 * SHIP_MASS_KG * analyticDeltaVMS;
    expect(relativeError(snapshot.energySpentJ, expectedEnergyJ)).toBeLessThan(0.01);
    expect(core.burnLog.count).toBe(2);
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

    let realtimeSnapshot = realtime.snapshot;
    let warpedSnapshot = warped.snapshot;
    for (let frame = 0; frame < 1_000; frame += 1) realtimeSnapshot = realtime.step(0.01);
    for (let frame = 0; frame < 10; frame += 1) warpedSnapshot = warped.step(0.01);

    expect(realtimeSnapshot.energySpentJ).toBeGreaterThan(0);
    expect(relativeError(warpedSnapshot.energySpentJ, realtimeSnapshot.energySpentJ)).toBeLessThan(
      1e-12,
    );
    expect(
      relativeError(warpedSnapshot.properDeltaVMS, realtimeSnapshot.properDeltaVMS),
    ).toBeLessThan(1e-12);
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
