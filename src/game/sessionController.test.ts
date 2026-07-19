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
  setError: unknown = null;

  getItem(key: string): string | null {
    if (this.getError !== null) throw this.getError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.setError !== null) throw this.setError;
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
    createNewSimulation: () => createNewGameSimulation(SHIP_MASS_KG),
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

  it('preserves manual rotation through restore and tutorial-only settings publications', () => {
    const storage = new MemoryStorage();
    let mapper: KeyboardCommandMapper | null = null;
    const controller = new GameSessionController({
      createNewSimulation: () => createNewGameSimulation(SHIP_MASS_KG),
      createSimulation: (state) => createGameSimulationFromPersistentState(SHIP_MASS_KG, state),
      initialSimulation: createNewGameSimulation(SHIP_MASS_KG),
      saveRepository: new SaveRepository(storage, SHIP_MASS_KG),
      settingsRepository: new SettingsRepository(storage),
      onSettingsChanged: (settings, origin) => {
        if (origin === 'restore') mapper?.restoreBindings(settings.inputBindings);
        else mapper?.updateBindings(settings.inputBindings);
      },
    });
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
    mapper = new KeyboardCommandMapper(
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

    expect(controller.updateTutorial(() => ({ status: 'active', stepId: 'camera' }))).toMatchObject(
      { ok: true },
    );
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
      createNewSimulation: () => createNewGameSimulation(SHIP_MASS_KG),
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

  it('owns functional tutorial transitions without publishing preferences', () => {
    const storage = new MemoryStorage();
    const published: string[] = [];
    const controller = new GameSessionController({
      createNewSimulation: () => createNewGameSimulation(SHIP_MASS_KG),
      createSimulation: (state) => createGameSimulationFromPersistentState(SHIP_MASS_KG, state),
      initialSimulation: createNewGameSimulation(SHIP_MASS_KG),
      saveRepository: new SaveRepository(storage, SHIP_MASS_KG),
      settingsRepository: new SettingsRepository(storage),
      onSettingsChanged: (settings) => published.push(settings.tutorial.stepId),
    });

    expect(
      controller.updateTutorial((current) => ({ ...current, status: 'active', stepId: 'camera' })),
    ).toEqual({ ok: true, message: 'Tutorial progress updated' });
    expect(controller.settings.tutorial).toEqual({ status: 'active', stepId: 'camera' });
    expect(published).toEqual([]);
    expect(JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY) ?? '').tutorial).toEqual(
      controller.settings.tutorial,
    );
  });

  it('keeps tutorial-only changes out of the preference callback', () => {
    const storage = new MemoryStorage();
    const origins: string[] = [];
    const controller = new GameSessionController({
      createNewSimulation: () => createNewGameSimulation(SHIP_MASS_KG),
      createSimulation: (state) => createGameSimulationFromPersistentState(SHIP_MASS_KG, state),
      initialSimulation: createNewGameSimulation(SHIP_MASS_KG),
      saveRepository: new SaveRepository(storage, SHIP_MASS_KG),
      settingsRepository: new SettingsRepository(storage),
      onSettingsChanged: (_settings, origin) => origins.push(origin),
    });

    expect(controller.updateTutorial(() => ({ status: 'active', stepId: 'camera' }))).toMatchObject(
      { ok: true },
    );
    expect(origins).toEqual([]);
  });

  it('rejects an invalid tutorial transition without changing or publishing settings', () => {
    const storage = new MemoryStorage();
    let publishCount = 0;
    const controller = new GameSessionController({
      createNewSimulation: () => createNewGameSimulation(SHIP_MASS_KG),
      createSimulation: (state) => createGameSimulationFromPersistentState(SHIP_MASS_KG, state),
      initialSimulation: createNewGameSimulation(SHIP_MASS_KG),
      saveRepository: new SaveRepository(storage, SHIP_MASS_KG),
      settingsRepository: new SettingsRepository(storage),
      onSettingsChanged: () => {
        publishCount += 1;
      },
    });
    const before = controller.settings;

    const result = controller.updateTutorial(() => ({
      status: 'active',
      stepId: 'teleport' as never,
    }));

    expect(result).toMatchObject({ ok: false, message: 'Unable to update tutorial progress' });
    expect(controller.settings).toBe(before);
    expect(publishCount).toBe(0);
  });

  it('keeps tutorial progress unchanged when tutorial persistence fails', () => {
    const storage = new MemoryStorage();
    const controller = createController(storage);
    const before = controller.settings;
    storage.setError = new Error('quota');

    expect(controller.updateTutorial(() => ({ status: 'active', stepId: 'camera' }))).toMatchObject(
      { ok: false, message: 'Unable to save settings' },
    );
    expect(controller.settings).toBe(before);
  });

  it('loads save preferences while preserving profile tutorial progress', () => {
    const storage = new MemoryStorage();
    const controller = createController(storage);
    expect(controller.updateQualityLock('low')).toMatchObject({ ok: true });
    expect(controller.saveLocal()).toMatchObject({ ok: true });
    expect(controller.updateTutorial(() => ({ status: 'active', stepId: 'warp' }))).toMatchObject({
      ok: true,
    });
    expect(controller.updateQualityLock('high')).toMatchObject({ ok: true });

    expect(controller.loadLocal()).toMatchObject({ ok: true });

    expect(controller.settings.qualityLock).toBe('low');
    expect(controller.settings.tutorial).toEqual({ status: 'active', stepId: 'warp' });
  });

  it('keeps simulation and profile atomic when merged save preferences cannot persist', () => {
    const storage = new MemoryStorage();
    const controller = createController(storage);
    expect(controller.saveLocal()).toMatchObject({ ok: true });
    controller.simulation.step(12);
    const simulationBefore = controller.simulation;
    const settingsBefore = controller.settings;
    storage.setError = new Error('quota');

    expect(controller.loadLocal()).toMatchObject({
      ok: false,
      message: 'Unable to load session',
      detail: expect.stringMatching(/quota/u),
    });
    expect(controller.simulation).toBe(simulationBefore);
    expect(controller.settings).toBe(settingsBefore);
  });

  it('imports save preferences while preserving profile tutorial progress', () => {
    const sourceStorage = new MemoryStorage();
    const source = createController(sourceStorage);
    expect(source.updateQualityLock('medium')).toMatchObject({ ok: true });
    const exported = source.exportJson();
    if (!exported.ok) throw new Error(exported.message);

    const target = createController(new MemoryStorage());
    expect(target.updateTutorial(() => ({ status: 'active', stepId: 'burn-log' }))).toMatchObject({
      ok: true,
    });

    expect(target.importJson(exported.json)).toMatchObject({ ok: true });
    expect(target.settings.qualityLock).toBe('medium');
    expect(target.settings.tutorial).toEqual({ status: 'active', stepId: 'burn-log' });
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

  it('atomically replaces the live simulation when New Game construction succeeds', () => {
    const storage = new MemoryStorage();
    const live = createNewGameSimulation(SHIP_MASS_KG);
    const replacement = createNewGameSimulation(SHIP_MASS_KG);
    const replacements: SimulationCore[] = [];
    const controller = new GameSessionController({
      createNewSimulation: () => replacement,
      createSimulation: (state) => createGameSimulationFromPersistentState(SHIP_MASS_KG, state),
      initialSimulation: live,
      saveRepository: new SaveRepository(storage, SHIP_MASS_KG),
      settingsRepository: new SettingsRepository(storage),
      onSimulationReplaced: (simulation) => replacements.push(simulation),
    });

    expect(controller.startNewGame()).toEqual({ ok: true, message: 'New game started' });
    expect(controller.simulation).toBe(replacement);
    expect(replacements).toEqual([replacement]);
  });

  it('keeps the live simulation when New Game construction fails', () => {
    const storage = new MemoryStorage();
    const live = createNewGameSimulation(SHIP_MASS_KG);
    const controller = new GameSessionController({
      createNewSimulation: () => {
        throw new Error('factory failed');
      },
      createSimulation: (state) => createGameSimulationFromPersistentState(SHIP_MASS_KG, state),
      initialSimulation: live,
      saveRepository: new SaveRepository(storage, SHIP_MASS_KG),
      settingsRepository: new SettingsRepository(storage),
    });

    expect(controller.startNewGame()).toEqual({
      ok: false,
      message: 'Unable to start new game',
      detail: 'factory failed',
    });
    expect(controller.simulation).toBe(live);
  });

  it('reports Continue availability only for a complete valid local save', () => {
    const storage = new MemoryStorage();
    const controller = createController(storage);

    expect(controller.hasValidLocalSave()).toBe(false);
    storage.values.set(SAVE_STORAGE_KEY, '{bad');
    expect(controller.hasValidLocalSave()).toBe(false);
    storage.values.delete(SAVE_STORAGE_KEY);
    expect(controller.saveLocal()).toMatchObject({ ok: true });
    expect(controller.hasValidLocalSave()).toBe(true);
    storage.getError = new Error('denied');
    expect(controller.hasValidLocalSave()).toBe(false);
  });

  it('fails closed when Continue availability cannot be inspected', () => {
    const storage = new MemoryStorage();
    const saveRepository = new SaveRepository(storage, SHIP_MASS_KG);
    saveRepository.load = () => {
      throw new Error('unexpected repository failure');
    };
    const controller = new GameSessionController({
      createNewSimulation: () => createNewGameSimulation(SHIP_MASS_KG),
      createSimulation: (state) => createGameSimulationFromPersistentState(SHIP_MASS_KG, state),
      initialSimulation: createNewGameSimulation(SHIP_MASS_KG),
      saveRepository,
      settingsRepository: new SettingsRepository(storage),
    });

    expect(controller.hasValidLocalSave()).toBe(false);
  });

  it('exposes an initialization warning when stored settings cannot be read', () => {
    const storage = new MemoryStorage();
    storage.getError = new Error('denied');

    const controller = createController(storage);

    expect(controller.settings).toBe(DEFAULT_GAME_SETTINGS);
    expect(controller.initializationWarning).toMatch(/unable to read settings.*denied/iu);
  });
});
