import { describe, expect, it } from 'vitest';

import type { SimulationCore } from '../sim/simulation.js';
import type { Commands } from '../sim/simulationSnapshot.js';
import {
  createGameSimulationFromPersistentState,
  createNewGameSimulation,
} from './createNewGameSimulation.js';
import { KeyboardCommandMapper, type KeyboardInputTarget } from './inputMapping.js';
import { SAVE_STORAGE_KEY, SaveRepository } from './saveLoad.js';
import { GameSessionController } from './sessionController.js';
import {
  DEFAULT_GAME_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SettingsRepository,
  type KeyValueStorage,
} from './settings.js';

const SHIP_MASS_KG = 10_000;

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  getError: unknown = null;

  getItem(key: string): string | null {
    if (this.getError !== null) throw this.getError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function copySessionState(simulation: SimulationCore) {
  const snapshot = simulation.snapshot;
  return {
    attitudeMode: snapshot.attitudeMode,
    attitudeQuaternion: [...snapshot.attitudeQuaternion],
    bodyPositionsKm: [...snapshot.bodyPositionsKm],
    bodyVelocitiesKmS: [...snapshot.bodyVelocitiesKmS],
    effectiveWarp: snapshot.effectiveWarp,
    energySpentJ: snapshot.energySpentJ,
    requestedWarp: snapshot.requestedWarp,
    shipState: [...snapshot.shipState],
    simTimeSec: snapshot.simTimeSec,
    targetBodyId: snapshot.targetBodyId,
    throttle: snapshot.throttle,
  };
}

function createController(
  storage: MemoryStorage,
  simulation = createNewGameSimulation(SHIP_MASS_KG),
) {
  return new GameSessionController({
    createSimulation: (state) => createGameSimulationFromPersistentState(SHIP_MASS_KG, state),
    initialSimulation: simulation,
    saveRepository: new SaveRepository(storage, SHIP_MASS_KG),
    settingsRepository: new SettingsRepository(storage),
  });
}

describe('GameSessionController', () => {
  it('save then reload restores identical ship and time-derived body state', () => {
    const storage = new MemoryStorage();
    const controller = createController(storage);
    controller.simulation.commands.setTarget('mars');
    controller.simulation.commands.setAttitudeMode('prograde');
    controller.simulation.commands.setThrottle(0.15);
    controller.simulation.step(2);
    const before = copySessionState(controller.simulation);

    expect(controller.saveLocal()).toEqual({ ok: true, message: 'Session saved' });
    controller.simulation.commands.setThrottle(0);
    controller.simulation.step(60);
    expect(copySessionState(controller.simulation)).not.toEqual(before);
    expect(controller.loadLocal()).toEqual({ ok: true, message: 'Session loaded' });

    expect(copySessionState(controller.simulation)).toEqual(before);
  });

  it('preserves restored manual rotation through the production input-frame order', () => {
    const storage = new MemoryStorage();
    const controller = createController(storage);
    const sessionCommands: Commands = {
      rotate: (pitch, yaw, roll) => controller.simulation.commands.rotate(pitch, yaw, roll),
      setAttitudeMode: (mode) => controller.simulation.commands.setAttitudeMode(mode),
      setTarget: (bodyId) => controller.simulation.commands.setTarget(bodyId),
      setThrottle: (fraction) => controller.simulation.commands.setThrottle(fraction),
      setWarp: (warp) => controller.simulation.commands.setWarp(warp),
    };
    const keyboardTarget: KeyboardInputTarget = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const mapper = new KeyboardCommandMapper(
      keyboardTarget,
      sessionCommands,
      () => controller.simulation.snapshot,
      controller.settings.inputBindings,
    );
    controller.simulation.commands.rotate(0.1, 0.2, 0.3);
    expect(controller.saveLocal()).toMatchObject({ ok: true });
    controller.simulation.commands.rotate(0, 0, 0);

    expect(controller.loadLocal()).toMatchObject({ ok: true });
    mapper.update();
    controller.simulation.step(1 / 60);

    expect([...controller.simulation.exportPersistentState().rotationRatesRadS]).toEqual([
      0.1, 0.2, 0.3,
    ]);
    mapper.dispose();
  });

  it('keeps the live session and settings unchanged if replacement construction fails', () => {
    const storage = new MemoryStorage();
    const source = createController(storage);
    source.saveLocal();
    const live = createNewGameSimulation(SHIP_MASS_KG);
    const controller = new GameSessionController({
      createSimulation: () => {
        throw new Error('factory failed');
      },
      initialSimulation: live,
      saveRepository: new SaveRepository(storage, SHIP_MASS_KG),
      settingsRepository: new SettingsRepository(storage),
    });
    const settingsBefore = controller.settings;

    expect(controller.loadLocal()).toMatchObject({ ok: false, message: 'Unable to load session' });
    expect(controller.simulation).toBe(live);
    expect(controller.settings).toBe(settingsBefore);
  });

  it('exports and imports JSON without overwriting the canonical save slot', () => {
    const storage = new MemoryStorage();
    const controller = createController(storage);
    controller.saveLocal();
    const storedBefore = storage.values.get(SAVE_STORAGE_KEY);
    controller.simulation.step(12);
    const exported = controller.exportJson();
    if (!exported.ok) throw new Error(exported.message);
    const exportedState = copySessionState(controller.simulation);
    controller.simulation.step(12);

    expect(controller.importJson(exported.json)).toEqual({ ok: true, message: 'Session imported' });
    expect(copySessionState(controller.simulation)).toEqual(exportedState);
    expect(storage.values.get(SAVE_STORAGE_KEY)).toBe(storedBefore);
  });

  it('persists quality and rebind updates only after validation succeeds', () => {
    const storage = new MemoryStorage();
    const controller = createController(storage);

    expect(controller.updateQualityLock('high')).toMatchObject({ ok: true });
    expect(controller.rebind('pitchUp', 'KeyI')).toMatchObject({ ok: true });
    expect(controller.settings.qualityLock).toBe('high');
    expect(controller.settings.inputBindings.pitchUp).toBe('KeyI');
    expect(storage.values.has(SETTINGS_STORAGE_KEY)).toBe(true);

    const before = controller.settings;
    expect(
      controller.rebind('pitchUp', DEFAULT_GAME_SETTINGS.inputBindings.pitchDown),
    ).toMatchObject({
      ok: false,
    });
    expect(controller.settings).toBe(before);
  });

  it('returns actionable messages for a missing or invalid local slot', () => {
    const storage = new MemoryStorage();
    const controller = createController(storage);

    expect(controller.loadLocal()).toEqual({ ok: false, message: 'No local save found' });
    storage.values.set(SAVE_STORAGE_KEY, '{bad');
    expect(controller.loadLocal()).toMatchObject({
      ok: false,
      message: 'Saved session is invalid',
    });
  });

  it('exposes an initialization warning when stored settings cannot be read', () => {
    const storage = new MemoryStorage();
    storage.getError = new Error('denied');

    const controller = createController(storage);

    expect(controller.settings).toBe(DEFAULT_GAME_SETTINGS);
    expect(controller.initializationWarning).toMatch(/unable to read settings.*denied/iu);
  });
});
