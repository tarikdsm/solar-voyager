import { describe, expect, it } from 'vitest';

import profileV2Fixture from '../../tests/fixtures/settings-profile-v2.json';
import {
  DEFAULT_GAME_SETTINGS,
  DEFAULT_GAMEPAD_SETTINGS,
  GAMEPAD_AXES,
  INPUT_ACTIONS,
  isUnboundInputCode,
  LEGACY_SETTINGS_STORAGE_KEY,
  LEGACY_V2_SETTINGS_STORAGE_KEY,
  mergeGameSettingsPreferences,
  parseGameSettings,
  parseProfileSettings,
  projectGameSettingsV1,
  rebindInput,
  SETTINGS_STORAGE_KEY,
  SettingsRepository,
  updateGamepadAxisInvert,
  updateGamepadAxisSensitivity,
  updateGamepadCurveExponent,
  updateGamepadDeadzone,
  updateTutorialSettings,
  type GamepadAxisId,
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
  return JSON.parse(JSON.stringify(projectGameSettingsV1(DEFAULT_GAME_SETTINGS))) as Record<
    string,
    unknown
  >;
}

describe('game settings', () => {
  it('loads immutable defaults when no stored settings exist', () => {
    const repository = new SettingsRepository(new MemoryStorage());
    const result = repository.load();

    expect(result).toEqual({ ok: true, settings: DEFAULT_GAME_SETTINGS, source: 'default' });
    expect(Object.isFrozen(result.settings)).toBe(true);
    expect(Object.isFrozen(result.settings.inputBindings)).toBe(true);
    expect(Object.isFrozen(result.settings.tutorial)).toBe(true);
    expect(result.settings.tutorial).toEqual({ status: 'unoffered', stepId: 'focus-target' });
    expect(Object.keys(result.settings.inputBindings)).toEqual([...INPUT_ACTIONS]);
  });

  it('strictly parses and deeply freezes a v2 profile', () => {
    const parsed = parseProfileSettings({
      ...DEFAULT_GAME_SETTINGS,
      tutorial: { status: 'active', stepId: 'camera' },
    });

    expect(parsed.tutorial).toEqual({ status: 'active', stepId: 'camera' });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.inputBindings)).toBe(true);
    expect(Object.isFrozen(parsed.tutorial)).toBe(true);
    expect(() =>
      parseProfileSettings({ ...parsed, tutorial: { status: 'paused', stepId: 'camera' } }),
    ).toThrow(/tutorial status/u);
    expect(() =>
      parseProfileSettings({ ...parsed, tutorial: { status: 'active', stepId: 'teleport' } }),
    ).toThrow(/tutorial step/u);
    expect(() => parseProfileSettings({ ...parsed, debug: true })).toThrow(
      /unknown profile settings field/u,
    );
  });

  it('rejects inconsistent terminal and not-yet-offered tutorial steps', () => {
    expect(() =>
      parseProfileSettings({
        ...DEFAULT_GAME_SETTINGS,
        tutorial: { status: 'unoffered', stepId: 'camera' },
      }),
    ).toThrow(/unoffered.*focus-target/u);
    expect(() =>
      parseProfileSettings({
        ...DEFAULT_GAME_SETTINGS,
        tutorial: { status: 'completed', stepId: 'save' },
      }),
    ).toThrow(/completed.*return-to-play/u);
  });

  it('migrates a stored v1 profile to skipped v2 and writes it immediately', () => {
    const storage = new MemoryStorage();
    const legacy = { ...projectGameSettingsV1(DEFAULT_GAME_SETTINGS), qualityLock: 'medium' };
    storage.values.set(LEGACY_SETTINGS_STORAGE_KEY, JSON.stringify(legacy));

    const result = new SettingsRepository(storage).load();

    expect(result).toMatchObject({ ok: true, source: 'migrated' });
    expect(result.settings).toEqual({
      ...DEFAULT_GAME_SETTINGS,
      qualityLock: 'medium',
      tutorial: { status: 'skipped', stepId: 'focus-target' },
    });
    expect(JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual(result.settings);
  });

  it('fails closed when writing a migrated v1 profile fails', () => {
    const storage = new MemoryStorage();
    storage.values.set(
      LEGACY_SETTINGS_STORAGE_KEY,
      JSON.stringify(projectGameSettingsV1(DEFAULT_GAME_SETTINGS)),
    );
    storage.setError = new Error('quota');

    const result = new SettingsRepository(storage).load();

    expect(result).toMatchObject({ ok: false, settings: DEFAULT_GAME_SETTINGS });
    if (!result.ok) expect(result.error).toMatch(/migrate settings.*quota/iu);
    expect(storage.values.has(SETTINGS_STORAGE_KEY)).toBe(false);
  });

  it('does not fall back to the v2 or v1 keys when a present v3 profile is invalid', () => {
    const storage = new MemoryStorage();
    storage.values.set(SETTINGS_STORAGE_KEY, '{bad json');
    // Both lower tiers hold perfectly valid, loadable documents. If the
    // current-key failure cascaded past either of them, this would come back
    // ok:true — it must not.
    storage.values.set(
      LEGACY_V2_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        qualityLock: 'high',
        inputBindings: DEFAULT_GAME_SETTINGS.inputBindings,
        tutorial: DEFAULT_GAME_SETTINGS.tutorial,
      }),
    );
    storage.values.set(
      LEGACY_SETTINGS_STORAGE_KEY,
      JSON.stringify(projectGameSettingsV1(DEFAULT_GAME_SETTINGS)),
    );

    const result = new SettingsRepository(storage).load();

    expect(result).toMatchObject({ ok: false, settings: DEFAULT_GAME_SETTINGS });
    if (!result.ok) expect(result.error).toMatch(/parse settings/u);
  });

  it('does not fall back to v1 when a present v2 profile is invalid', () => {
    const storage = new MemoryStorage();
    storage.values.set(LEGACY_V2_SETTINGS_STORAGE_KEY, '{bad json');
    storage.values.set(
      LEGACY_SETTINGS_STORAGE_KEY,
      JSON.stringify(projectGameSettingsV1(DEFAULT_GAME_SETTINGS)),
    );

    const result = new SettingsRepository(storage).load();

    expect(result).toMatchObject({ ok: false, settings: DEFAULT_GAME_SETTINGS });
    if (!result.ok) expect(result.error).toMatch(/parse settings/u);
  });

  it('projects save preferences and merges them without changing tutorial progress', () => {
    const active = updateTutorialSettings(DEFAULT_GAME_SETTINGS, {
      status: 'active',
      stepId: 'warp',
    });
    const imported = {
      ...projectGameSettingsV1(DEFAULT_GAME_SETTINGS),
      qualityLock: 'high' as const,
      inputBindings: {
        ...DEFAULT_GAME_SETTINGS.inputBindings,
        pitchUp: 'KeyI',
        pitchDown: 'KeyK',
      },
    };

    const merged = mergeGameSettingsPreferences(active, imported);

    expect(projectGameSettingsV1(merged)).toEqual(imported);
    expect(merged.tutorial).toEqual(active.tutorial);
  });

  it('validates profile inputs before projecting or merging preferences', () => {
    const invalid = Object.freeze({
      ...DEFAULT_GAME_SETTINGS,
      tutorial: Object.freeze({ status: 'active', stepId: 'teleport' }),
    });

    expect(() => projectGameSettingsV1(invalid as never)).toThrow(/tutorial step/u);
    expect(() =>
      mergeGameSettingsPreferences(invalid as never, projectGameSettingsV1(DEFAULT_GAME_SETTINGS)),
    ).toThrow(/tutorial step/u);
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

  it('rejects duplicate, reserved, and extra bindings', () => {
    const duplicate = mutableDocument();
    const duplicateBindings = duplicate.inputBindings as Record<string, unknown>;
    duplicateBindings.pitchUp = duplicateBindings.pitchDown;
    expect(() => parseGameSettings(duplicate)).toThrow(/already bound/u);

    const reserved = mutableDocument();
    (reserved.inputBindings as Record<string, unknown>).pitchUp = 'F3';
    expect(() => parseGameSettings(reserved)).toThrow(/reserved/u);

    const extra = mutableDocument();
    (extra.inputBindings as Record<string, unknown>).teleport = 'F8';
    expect(() => parseGameSettings(extra)).toThrow(/unknown input action/u);
  });

  it('backfills actions a document predates instead of rejecting the document', () => {
    // `parseGameSettings` runs on every save load, so an appended action must not
    // be able to make an older document — or an older save — unloadable.
    const missing = mutableDocument();
    const bindings = missing.inputBindings as Record<string, unknown>;
    delete bindings.rollLeft;
    delete bindings.killRotation;

    const parsed = parseGameSettings(missing);

    expect(parsed.inputBindings.rollLeft).toBe(DEFAULT_GAME_SETTINGS.inputBindings.rollLeft);
    expect(parsed.inputBindings.killRotation).toBe(
      DEFAULT_GAME_SETTINGS.inputBindings.killRotation,
    );
    expect(parsed.inputBindings.pitchUp).toBe('KeyW');
    expect(Object.keys(parsed.inputBindings)).toEqual([...INPUT_ACTIONS]);
  });

  it('leaves a backfilled action unbound when its default key is already taken', () => {
    const missing = mutableDocument();
    const bindings = missing.inputBindings as Record<string, unknown>;
    delete bindings.killRotation;
    // A player who bound something else to the new action's default: the document
    // is legal and must survive, so the new action arrives unbound instead.
    bindings.rollLeft = DEFAULT_GAME_SETTINGS.inputBindings.killRotation;

    const parsed = parseGameSettings(missing);

    expect(parsed.inputBindings.rollLeft).toBe('KeyX');
    expect(isUnboundInputCode(parsed.inputBindings.killRotation)).toBe(true);
    expect(isUnboundInputCode(parsed.inputBindings.rollLeft)).toBe(false);
    // Still a valid document: it round-trips and rebinds normally.
    expect(() => parseGameSettings(parsed)).not.toThrow();
    const profile = parseProfileSettings({
      version: 3,
      qualityLock: 'auto',
      inputBindings: parsed.inputBindings,
      tutorial: { status: 'unoffered', stepId: 'focus-target' },
      gamepad: DEFAULT_GAME_SETTINGS.gamepad,
    });
    expect(rebindInput(profile, 'killRotation', 'KeyB').inputBindings.killRotation).toBe('KeyB');
  });

  it('never emits a placeholder that another action already holds', () => {
    // A placeholder is a legal explicit binding, because a document written by an
    // earlier backfill has to round-trip. An untrusted document can therefore
    // carry one on some *other* action, and emitting the bare placeholder anyway
    // would produce two actions sharing a code: accepted now, rejected on the
    // next load — precisely the unloadable profile the backfill exists to avoid.
    const hostile = mutableDocument();
    const bindings = hostile.inputBindings as Record<string, unknown>;
    delete bindings.killRotation;
    bindings.rollLeft = DEFAULT_GAME_SETTINGS.inputBindings.killRotation;
    bindings.rollRight = 'unbound.killRotation';

    const parsed = parseGameSettings(hostile);
    const codes = Object.values(parsed.inputBindings);

    expect(parsed.inputBindings.rollRight).toBe('unbound.killRotation');
    expect(isUnboundInputCode(parsed.inputBindings.killRotation)).toBe(true);
    expect(parsed.inputBindings.killRotation).not.toBe(parsed.inputBindings.rollRight);
    expect(new Set(codes).size).toBe(codes.length);
    // The decisive property: the output loads again.
    expect(() => parseGameSettings(parsed)).not.toThrow();
  });

  it('still fails closed on malformed codes in a document that also needs backfill', () => {
    for (const malformed of [17, null, '', '   ', 'Key W', 'K'.repeat(65)]) {
      const document = mutableDocument();
      const bindings = document.inputBindings as Record<string, unknown>;
      delete bindings.killRotation;
      bindings.pitchUp = malformed;
      expect(() => parseGameSettings(document)).toThrow(/pitchUp/u);
    }

    const notAnObject = mutableDocument();
    notAnObject.inputBindings = ['KeyW'];
    expect(() => parseGameSettings(notAnObject)).toThrow(/inputBindings must be an object/u);
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

  describe('gamepad settings (T0106)', () => {
    it('ships the brief defaults and includes cruise actions in the registry', () => {
      expect(DEFAULT_GAME_SETTINGS.gamepad).toEqual(DEFAULT_GAMEPAD_SETTINGS);
      expect(DEFAULT_GAME_SETTINGS.gamepad.deadzone).toBe(0.08);
      expect(DEFAULT_GAME_SETTINGS.gamepad.curveExponent).toBe(1.6);
      expect(INPUT_ACTIONS).toContain('cruiseEngage');
      expect(INPUT_ACTIONS).toContain('cruiseAbort');
      expect(DEFAULT_GAME_SETTINGS.inputBindings.cruiseEngage).toBe('KeyG');
      expect(DEFAULT_GAME_SETTINGS.inputBindings.cruiseAbort).toBe('KeyV');
    });

    it('rejects an out-of-range deadzone, curve exponent, or sensitivity', () => {
      expect(() => updateGamepadDeadzone(DEFAULT_GAME_SETTINGS, -0.01)).toThrow(/deadzone/u);
      expect(() => updateGamepadDeadzone(DEFAULT_GAME_SETTINGS, 0.51)).toThrow(/deadzone/u);
      expect(() => updateGamepadDeadzone(DEFAULT_GAME_SETTINGS, Number.NaN)).toThrow(/deadzone/u);
      expect(() => updateGamepadCurveExponent(DEFAULT_GAME_SETTINGS, 0.1)).toThrow(
        /curve exponent/u,
      );
      expect(() => updateGamepadCurveExponent(DEFAULT_GAME_SETTINGS, 10)).toThrow(
        /curve exponent/u,
      );
      expect(() => updateGamepadAxisSensitivity(DEFAULT_GAME_SETTINGS, 'pitch', 0)).toThrow(
        /sensitivity/u,
      );
      expect(() => updateGamepadAxisSensitivity(DEFAULT_GAME_SETTINGS, 'pitch', 5)).toThrow(
        /sensitivity/u,
      );
    });

    it('rejects an incomplete or excess gamepad document', () => {
      expect(() =>
        parseProfileSettings({
          ...DEFAULT_GAME_SETTINGS,
          gamepad: { deadzone: 0.08, curveExponent: 1.6 },
        }),
      ).toThrow(/field is missing: axes/u);
      expect(() =>
        parseProfileSettings({
          ...DEFAULT_GAME_SETTINGS,
          gamepad: { ...DEFAULT_GAME_SETTINGS.gamepad, extra: true },
        }),
      ).toThrow(/unknown gamepad settings field/u);
      expect(() =>
        parseProfileSettings({
          ...DEFAULT_GAME_SETTINGS,
          gamepad: {
            ...DEFAULT_GAME_SETTINGS.gamepad,
            axes: { pitch: { invert: false, sensitivity: 1 } },
          },
        }),
      ).toThrow(/field is missing: yaw/u);
    });

    it('updates deadzone and curve exponent immutably and validates the whole document', () => {
      const next = updateGamepadCurveExponent(
        updateGamepadDeadzone(DEFAULT_GAME_SETTINGS, 0.15),
        2,
      );

      expect(next).not.toBe(DEFAULT_GAME_SETTINGS);
      expect(next.gamepad.deadzone).toBe(0.15);
      expect(next.gamepad.curveExponent).toBe(2);
      expect(DEFAULT_GAME_SETTINGS.gamepad.deadzone).toBe(0.08); // original untouched
      expect(Object.isFrozen(next.gamepad)).toBe(true);
      expect(Object.isFrozen(next.gamepad.axes)).toBe(true);
    });

    it('updates one axis without disturbing the other three', () => {
      const inverted = updateGamepadAxisInvert(DEFAULT_GAME_SETTINGS, 'roll', true);
      const sensitized = updateGamepadAxisSensitivity(inverted, 'roll', 2.5);

      expect(sensitized.gamepad.axes.roll).toEqual({ invert: true, sensitivity: 2.5 });
      for (const axis of GAMEPAD_AXES) {
        if (axis === 'roll') continue;
        expect(sensitized.gamepad.axes[axis as GamepadAxisId]).toEqual({
          invert: false,
          sensitivity: 1,
        });
      }
    });

    it('preserves gamepad calibration across a save import, like tutorial progress', () => {
      const customized = updateGamepadAxisSensitivity(
        updateGamepadAxisInvert(DEFAULT_GAME_SETTINGS, 'pitch', true),
        'throttle',
        1.75,
      );
      const imported = projectGameSettingsV1(DEFAULT_GAME_SETTINGS); // a save carries no gamepad data

      const merged = mergeGameSettingsPreferences(customized, imported);

      expect(merged.gamepad).toEqual(customized.gamepad);
    });

    it('migrates a stored v2 profile (no gamepad field) to v3 and writes it forward to the v3 key', () => {
      const storage = new MemoryStorage();
      storage.values.set(LEGACY_V2_SETTINGS_STORAGE_KEY, JSON.stringify(profileV2Fixture));

      const result = new SettingsRepository(storage).load();

      expect(result).toMatchObject({ ok: true, source: 'migrated' });
      expect(result.settings.version).toBe(3);
      expect(result.settings.qualityLock).toBe('medium');
      expect(result.settings.inputBindings.pitchUp).toBe('KeyI');
      expect(result.settings.inputBindings.pitchDown).toBe('KeyK');
      // Actions the v2 fixture predates (T0106's cruise pair) are backfilled.
      expect(result.settings.inputBindings.cruiseEngage).toBe('KeyG');
      expect(result.settings.inputBindings.cruiseAbort).toBe('KeyV');
      expect(result.settings.tutorial).toEqual({ status: 'skipped', stepId: 'focus-target' });
      expect(result.settings.gamepad).toEqual(DEFAULT_GAMEPAD_SETTINGS);
      // Written forward to the dedicated v3 key, not back into the v2 one —
      // a downgraded build must never see (and clobber) the migrated result.
      expect(JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual(result.settings);
      expect(storage.values.get(LEGACY_V2_SETTINGS_STORAGE_KEY)).toEqual(
        JSON.stringify(profileV2Fixture),
      );
    });

    it('a wrong-version document at the v3 key fails closed with a v3-specific error', () => {
      const storage = new MemoryStorage();
      storage.values.set(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({ ...DEFAULT_GAME_SETTINGS, version: 99 }),
      );

      const result = new SettingsRepository(storage).load();

      expect(result).toMatchObject({ ok: false, settings: DEFAULT_GAME_SETTINGS });
      if (!result.ok) expect(result.error).toMatch(/profile settings version must be 3/u);
    });

    it('fails closed when writing a migrated v2->v3 profile fails', () => {
      const storage = new MemoryStorage();
      storage.values.set(LEGACY_V2_SETTINGS_STORAGE_KEY, JSON.stringify(profileV2Fixture));
      storage.setError = new Error('quota');

      const result = new SettingsRepository(storage).load();

      expect(result).toMatchObject({ ok: false, settings: DEFAULT_GAME_SETTINGS });
      if (!result.ok) expect(result.error).toMatch(/migrate settings.*quota/iu);
    });

    it('prefers the current v3 key over a stale v2 key present alongside it (downgrade safety)', () => {
      // A player who briefly ran an older, pre-T0106 build would have left a
      // v2 document sitting at the v2 key without ever writing to the v3 key
      // it doesn't know about. That document must never be consulted, let
      // alone allowed to shadow or overwrite the current one, once a v3-aware
      // build is running again — the entire point of a dedicated key per
      // generation instead of one shared, version-bumped-in-place key.
      const storage = new MemoryStorage();
      const current = updateGamepadDeadzone(DEFAULT_GAME_SETTINGS, 0.25);
      storage.values.set(SETTINGS_STORAGE_KEY, JSON.stringify(current));
      storage.values.set(LEGACY_V2_SETTINGS_STORAGE_KEY, JSON.stringify(profileV2Fixture));

      const result = new SettingsRepository(storage).load();

      expect(result).toEqual({ ok: true, settings: current, source: 'stored' });
      // Untouched: a v3-key read must not write anywhere, including the stale key.
      expect(storage.values.get(LEGACY_V2_SETTINGS_STORAGE_KEY)).toBe(
        JSON.stringify(profileV2Fixture),
      );
    });
  });
});
