import { describe, expect, it } from 'vitest';

import type { SimSnapshot } from '../sim/simulationSnapshot.js';
import { DEFAULT_VESSEL } from '../sim/ship/vessel.js';
import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
  createRespawnPersistentState,
} from './createNewGameSimulation.js';
import { RestorePointRing, RESTORE_POINT_CAPACITY } from './restorePoints.js';
import { SAVE_STORAGE_KEY, SaveRepository } from './saveLoad.js';
import { GameSessionController } from './sessionController.js';
import { SettingsRepository, type KeyValueStorage } from './settings.js';

const VESSEL = DEFAULT_VESSEL;
const FRAME_SEC = 1 / 60;

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function createController(simulation = createNewGameSimulation(VESSEL)) {
  const storage = new MemoryStorage();
  return new GameSessionController({
    createNewSimulation: () => createNewGameSimulation(VESSEL),
    createSimulation: (state) => createGameSimulationFromPersistentState(VESSEL, state),
    createRespawnState: createRespawnPersistentState,
    initialSimulation: simulation,
    saveRepository: new SaveRepository(storage, VESSEL),
    settingsRepository: new SettingsRepository(storage),
  });
}

/**
 * Every published scalar and vector a restore is expected to reproduce exactly.
 *
 * `attitudeQuaternion` is deliberately absent and compared separately. A core
 * built from a persisted document evaluates its hold with a zero slew budget,
 * and `writeSlewLimitedQuaternionInto` reaches that through an identity
 * composition followed by a renormalize (ADR-035; `attitude.ts` line 208), so
 * the first published quaternion is the persisted one scaled by ~1 ULP. That is
 * pre-existing T0107 behaviour, not a property of the restore path, and it does
 * not accumulate — see the restore-twice case below.
 */
function fingerprint(snapshot: SimSnapshot) {
  return {
    attitudeMode: snapshot.attitudeMode,
    bodyPositionsKm: [...snapshot.bodyPositionsKm],
    bodyVelocitiesKmS: [...snapshot.bodyVelocitiesKmS],
    effectiveWarp: snapshot.effectiveWarp,
    energySpentJ: snapshot.energySpentJ,
    impactBodyIndex: snapshot.impactBodyIndex,
    impactOccurred: snapshot.impactOccurred,
    kineticEnergyChangeJ: snapshot.kineticEnergyChangeJ,
    properDeltaVMS: snapshot.properDeltaVMS,
    requestedWarp: snapshot.requestedWarp,
    shipProperTimeSec: snapshot.shipProperTimeSec,
    shipState: [...snapshot.shipState],
    simTimeSec: snapshot.simTimeSec,
    targetBodyId: snapshot.targetBodyId,
    throttle: snapshot.throttle,
  };
}

describe('restore point ring - plan section 3.4', () => {
  it('captures on the first update and then at the wall-time cadence', () => {
    const ring = new RestorePointRing(10, RESTORE_POINT_CAPACITY);
    const simulation = createNewGameSimulation(VESSEL);

    expect(ring.update(simulation, FRAME_SEC)).not.toBeNull();
    expect(ring.count).toBe(1);

    // 9 s of frames must not take a second point.
    for (let elapsed = 0; elapsed < 9; elapsed += FRAME_SEC) {
      simulation.step(FRAME_SEC);
      ring.update(simulation, FRAME_SEC);
    }
    expect(ring.count).toBe(1);

    for (let elapsed = 0; elapsed < 1.5; elapsed += FRAME_SEC) {
      simulation.step(FRAME_SEC);
      ring.update(simulation, FRAME_SEC);
    }
    expect(ring.count).toBe(2);
  });

  it('retains six slots newest-first and overwrites the oldest', () => {
    const ring = new RestorePointRing(10, RESTORE_POINT_CAPACITY);
    const simulation = createNewGameSimulation(VESSEL);
    const capturedTimes: number[] = [];

    for (let capture = 0; capture < RESTORE_POINT_CAPACITY + 3; capture += 1) {
      simulation.step(1);
      const point = ring.update(simulation, 10);
      expect(point).not.toBeNull();
      capturedTimes.push(point?.simTimeSec as number);
    }

    expect(ring.count).toBe(RESTORE_POINT_CAPACITY);
    const expectedNewestFirst = capturedTimes.slice(-RESTORE_POINT_CAPACITY).reverse();
    for (let index = 0; index < RESTORE_POINT_CAPACITY; index += 1) {
      expect(ring.get(index)?.simTimeSec, `slot ${index}`).toBe(expectedNewestFirst[index]);
    }
    expect(ring.latest?.simTimeSec).toBe(expectedNewestFirst[0]);
    expect(ring.get(RESTORE_POINT_CAPACITY)).toBeNull();
  });

  it('refuses to capture a frozen core, so the last flyable state survives', () => {
    const ring = new RestorePointRing(10, RESTORE_POINT_CAPACITY);
    const simulation = createNewGameSimulation(VESSEL);
    ring.update(simulation, 10);

    // Drive the ship into Earth.
    simulation.commands.setAttitudeMode('radialIn');
    simulation.commands.setThrottle(1);
    for (let frame = 0; frame < 40_000; frame += 1) {
      if (simulation.step(1).impactOccurred === 1) break;
      ring.update(simulation, 10);
    }
    expect(simulation.snapshot.impactOccurred).toBe(1);
    const impactTimeSec = simulation.snapshot.simTimeSec;

    const countBefore = ring.count;
    expect(ring.update(simulation, 10)).toBeNull();
    expect(ring.count).toBe(countBefore);
    // Every retained slot is a state from before the crash, so all six are
    // flyable and none of them re-freezes on the first step after a restore.
    for (let index = 0; index < ring.count; index += 1) {
      expect(ring.get(index)?.simTimeSec, `slot ${index}`).toBeLessThan(impactTimeSec);
    }
  });

  it('clears on reset', () => {
    const ring = new RestorePointRing(10, RESTORE_POINT_CAPACITY);
    ring.update(createNewGameSimulation(VESSEL), 10);
    ring.reset();

    expect(ring.count).toBe(0);
    expect(ring.latest).toBeNull();
  });
});

describe('impact recovery - ADR-036 section 5', () => {
  it('restores a captured point to a bit-identical published snapshot', () => {
    const simulation = createNewGameSimulation(VESSEL);
    const controller = createController(simulation);
    const ring = new RestorePointRing(10, RESTORE_POINT_CAPACITY);

    simulation.commands.setAttitudeMode('prograde');
    for (let frame = 0; frame < 600; frame += 1) simulation.step(FRAME_SEC);
    const point = ring.capture(simulation);
    expect(point).not.toBeNull();
    const expected = fingerprint(simulation.snapshot);
    const expectedQuaternion = [...simulation.snapshot.attitudeQuaternion];

    // Fly on, so the restore has something to undo.
    for (let frame = 0; frame < 600; frame += 1) simulation.step(FRAME_SEC);
    expect(fingerprint(simulation.snapshot)).not.toEqual(expected);

    const result = controller.restoreFromState(point?.state as never);

    expect(result.ok).toBe(true);
    expect(fingerprint(controller.simulation.snapshot)).toEqual(expected);
    const restoredQuaternion = controller.simulation.snapshot.attitudeQuaternion;
    for (let index = 0; index < expectedQuaternion.length; index += 1) {
      expect(restoredQuaternion[index], `q[${index}]`).toBeCloseTo(
        expectedQuaternion[index] as number,
        15,
      );
    }
  });

  it('restores deterministically, attitude included, and the ULP does not accumulate', () => {
    const simulation = createNewGameSimulation(VESSEL);
    const controller = createController(simulation);
    const ring = new RestorePointRing(10, RESTORE_POINT_CAPACITY);
    simulation.commands.setAttitudeMode('prograde');
    for (let frame = 0; frame < 300; frame += 1) simulation.step(FRAME_SEC);
    const point = ring.capture(simulation);

    controller.restoreFromState(point?.state as never);
    const first = fingerprint(controller.simulation.snapshot);
    const firstQuaternion = [...controller.simulation.snapshot.attitudeQuaternion];
    for (let frame = 0; frame < 120; frame += 1) controller.simulation.step(FRAME_SEC);
    controller.restoreFromState(point?.state as never);

    // Bit-exact this time, quaternion included: restoring the same document
    // twice must land on the same state, or nothing built on restore is
    // reproducible.
    expect(fingerprint(controller.simulation.snapshot)).toEqual(first);
    expect([...controller.simulation.snapshot.attitudeQuaternion]).toEqual(firstQuaternion);
  });

  it('respawns into a circular orbit at two body radii with e < 1e-3', () => {
    const simulation = createNewGameSimulation(VESSEL);
    const controller = createController(simulation);
    const earthIndex = simulation.snapshot.bodyIds.indexOf('earth');

    simulation.commands.setAttitudeMode('radialIn');
    simulation.commands.setThrottle(1);
    for (let frame = 0; frame < 40_000; frame += 1) {
      if (simulation.step(1).impactOccurred === 1) break;
    }
    expect(simulation.snapshot.impactOccurred).toBe(1);
    expect(simulation.snapshot.impactBodyIndex).toBe(earthIndex);
    const missionTimeSec = simulation.snapshot.simTimeSec;
    const properTimeSec = simulation.snapshot.shipProperTimeSec;
    const energySpentJ = simulation.snapshot.energySpentJ;

    const result = controller.respawnInOrbit();

    expect(result.ok).toBe(true);
    const respawned = controller.simulation.snapshot;
    expect(respawned.impactOccurred).toBe(0);
    expect(respawned.throttle).toBe(0);
    expect(respawned.effectiveWarp).toBe(1);
    expect(respawned.dominantBodyIndex).toBe(earthIndex);

    const elements = respawned.osculatingElements;
    expect(elements.valid).toBe(true);
    expect(elements.eccentricity).toBeLessThan(1e-3);

    // Two Earth radii above the centre, and the mission carried forward.
    const offset = earthIndex * 3;
    const altitudeKm = Math.hypot(
      (respawned.shipState[0] as number) - (respawned.bodyPositionsKm[offset] as number),
      (respawned.shipState[1] as number) - (respawned.bodyPositionsKm[offset + 1] as number),
      (respawned.shipState[2] as number) - (respawned.bodyPositionsKm[offset + 2] as number),
    );
    expect(altitudeKm).toBeCloseTo(2 * 6_371.0084, 3);
    expect(respawned.simTimeSec).toBe(missionTimeSec);
    expect(respawned.shipProperTimeSec).toBe(properTimeSec);
    expect(respawned.energySpentJ).toBe(energySpentJ);

    // And it flies: the freeze is genuinely gone.
    expect(controller.simulation.step(FRAME_SEC).simTimeSec).toBeGreaterThan(missionTimeSec);
  });

  it('stays frozen when a recovery document fails validation', () => {
    const simulation = createNewGameSimulation(VESSEL);
    const controller = createController(simulation);
    const valid = simulation.exportPersistentState();
    const corrupted = { ...valid, state: new Float64Array(3) };

    const result = controller.restoreFromState(corrupted);

    expect(result.ok).toBe(false);
    expect(controller.simulation).toBe(simulation);
  });

  it('reports a clear failure when no respawn builder is configured', () => {
    const storage = new MemoryStorage();
    const simulation = createNewGameSimulation(VESSEL);
    const controller = new GameSessionController({
      createNewSimulation: () => createNewGameSimulation(VESSEL),
      createSimulation: (state) => createGameSimulationFromPersistentState(VESSEL, state),
      initialSimulation: simulation,
      saveRepository: new SaveRepository(storage, VESSEL),
      settingsRepository: new SettingsRepository(storage),
    });

    const result = controller.respawnInOrbit();

    expect(result.ok).toBe(false);
    expect(storage.values.get(SAVE_STORAGE_KEY)).toBeUndefined();
  });
});
