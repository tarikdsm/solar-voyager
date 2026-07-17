import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GAME_SETTINGS,
  INPUT_ACTIONS,
  parseGameSettings,
  rebindInput,
  SETTINGS_STORAGE_KEY,
  SettingsRepository,
  type KeyValueStorage,
} from './settings.js';

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

function mutableDocument() {
  return JSON.parse(JSON.stringify(DEFAULT_GAME_SETTINGS)) as Record<string, unknown>;
}

describe('game settings', () => {
  it('loads immutable defaults when no stored settings exist', () => {
    const repository = new SettingsRepository(new MemoryStorage());
    const result = repository.load();

    expect(result).toEqual({ ok: true, settings: DEFAULT_GAME_SETTINGS, source: 'default' });
    expect(Object.isFrozen(result.settings)).toBe(true);
    expect(Object.isFrozen(result.settings.inputBindings)).toBe(true);
    expect(Object.keys(result.settings.inputBindings)).toEqual([...INPUT_ACTIONS]);
  });

  it('round-trips a quality lock and rebind through storage', () => {
    const storage = new MemoryStorage();
    const repository = new SettingsRepository(storage);
    const rebound = rebindInput(
      { ...DEFAULT_GAME_SETTINGS, qualityLock: 'low' },
      'pitchUp',
      'KeyI',
    );

    expect(repository.save(rebound)).toEqual({ ok: true });
    expect(repository.load()).toEqual({ ok: true, settings: rebound, source: 'stored' });
    expect(storage.values.has(SETTINGS_STORAGE_KEY)).toBe(true);
  });

  it('reports corrupt stored JSON and returns safe defaults', () => {
    const storage = new MemoryStorage();
    storage.values.set(SETTINGS_STORAGE_KEY, '{bad json');

    const result = new SettingsRepository(storage).load();

    expect(result.ok).toBe(false);
    expect(result.settings).toBe(DEFAULT_GAME_SETTINGS);
    if (!result.ok) expect(result.error).toMatch(/parse settings/u);
  });

  it('reports unavailable storage on load and save', () => {
    const storage = new MemoryStorage();
    storage.getError = new Error('denied');
    const repository = new SettingsRepository(storage);

    expect(repository.load()).toMatchObject({ ok: false, settings: DEFAULT_GAME_SETTINGS });
    storage.getError = null;
    storage.setError = new Error('quota');
    expect(repository.save(DEFAULT_GAME_SETTINGS)).toMatchObject({ ok: false });
  });

  it('rejects duplicate, reserved, missing, and extra bindings', () => {
    const duplicate = mutableDocument();
    const duplicateBindings = duplicate.inputBindings as Record<string, unknown>;
    duplicateBindings.pitchUp = duplicateBindings.pitchDown;
    expect(() => parseGameSettings(duplicate)).toThrow(/already bound/u);

    const reserved = mutableDocument();
    (reserved.inputBindings as Record<string, unknown>).pitchUp = 'F5';
    expect(() => parseGameSettings(reserved)).toThrow(/reserved/u);

    const missing = mutableDocument();
    delete (missing.inputBindings as Record<string, unknown>).rollLeft;
    expect(() => parseGameSettings(missing)).toThrow(/rollLeft/u);

    const extra = mutableDocument();
    (extra.inputBindings as Record<string, unknown>).teleport = 'KeyT';
    expect(() => parseGameSettings(extra)).toThrow(/unknown input action/u);
  });

  it('rejects unsupported versions, quality locks, and unknown top-level fields', () => {
    expect(() => parseGameSettings({ ...mutableDocument(), version: 2 })).toThrow(/version/u);
    expect(() => parseGameSettings({ ...mutableDocument(), qualityLock: 'ultra' })).toThrow(
      /quality/u,
    );
    expect(() => parseGameSettings({ ...mutableDocument(), debug: true })).toThrow(
      /unknown settings field/u,
    );
  });

  it('rebinds immutably and rejects conflicts', () => {
    const rebound = rebindInput(DEFAULT_GAME_SETTINGS, 'pitchUp', 'KeyI');

    expect(rebound).not.toBe(DEFAULT_GAME_SETTINGS);
    expect(rebound.inputBindings).not.toBe(DEFAULT_GAME_SETTINGS.inputBindings);
    expect(rebound.inputBindings.pitchUp).toBe('KeyI');
    expect(DEFAULT_GAME_SETTINGS.inputBindings.pitchUp).toBe('KeyW');
    expect(() => rebindInput(rebound, 'pitchUp', rebound.inputBindings.pitchDown)).toThrow(
      /already bound/u,
    );
    expect(() => rebindInput(rebound, 'pitchUp', 'Escape')).toThrow(/reserved/u);
  });
});
