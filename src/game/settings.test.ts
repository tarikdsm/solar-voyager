import { describe, expect, it } from 'vitest';

import profileV2Fixture from '../../tests/fixtures/settings-profile-v2.json';
import {
  AUDIO_BUSES,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_GAME_SETTINGS,
  DEFAULT_GAMEPAD_SETTINGS,
  DEFAULT_HUD_SETTINGS,
  DEFAULT_RENDER_SETTINGS,
  GAMEPAD_AXES,
  INPUT_ACTIONS,
  isUnboundInputCode,
  LEGACY_SETTINGS_STORAGE_KEY,
  LEGACY_V2_SETTINGS_STORAGE_KEY,
  LEGACY_V3_SETTINGS_STORAGE_KEY,
  LEGACY_V4_SETTINGS_STORAGE_KEY,
  LEGACY_V5_SETTINGS_STORAGE_KEY,
  LEGACY_V6_SETTINGS_STORAGE_KEY,
  mergeGameSettingsPreferences,
  parseGameSettings,
  parseProfileSettings,
  projectGameSettingsV1,
  rebindInput,
  SETTINGS_STORAGE_KEY,
  SettingsRepository,
  updateAudioExteriorMusic,
  updateAudioLevel,
  updateCameraFovWidening,
  updateCameraShake,
  updateGamepadAxisInvert,
  updateGamepadAxisSensitivity,
  updateGamepadCurveExponent,
  updateGamepadDeadzone,
  updateHudBodyLabels,
  updateHudPreset,
  updateRenderExposureMode,
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
      version: 7,
      qualityLock: 'auto',
      inputBindings: parsed.inputBindings,
      tutorial: { status: 'unoffered', stepId: 'focus-target' },
      gamepad: DEFAULT_GAME_SETTINGS.gamepad,
      camera: DEFAULT_GAME_SETTINGS.camera,
      hud: DEFAULT_GAME_SETTINGS.hud,
      render: DEFAULT_GAME_SETTINGS.render,
      audio: DEFAULT_GAME_SETTINGS.audio,
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

    it('migrates a stored v2 profile (no gamepad field) across four generations to the current key', () => {
      const storage = new MemoryStorage();
      storage.values.set(LEGACY_V2_SETTINGS_STORAGE_KEY, JSON.stringify(profileV2Fixture));

      const result = new SettingsRepository(storage).load();

      expect(result).toMatchObject({ ok: true, source: 'migrated' });
      expect(result.settings.version).toBe(7);
      expect(result.settings.qualityLock).toBe('medium');
      expect(result.settings.inputBindings.pitchUp).toBe('KeyI');
      expect(result.settings.inputBindings.pitchDown).toBe('KeyK');
      // Actions the v2 fixture predates (T0106's cruise pair, T0112's HUD pair)
      // are backfilled.
      expect(result.settings.inputBindings.cruiseEngage).toBe('KeyG');
      expect(result.settings.inputBindings.cruiseAbort).toBe('KeyV');
      expect(result.settings.inputBindings.hudPresetCycle).toBe('KeyH');
      expect(result.settings.inputBindings.hudBodyLabelsToggle).toBe('KeyL');
      expect(result.settings.tutorial).toEqual({ status: 'skipped', stepId: 'focus-target' });
      expect(result.settings.gamepad).toEqual(DEFAULT_GAMEPAD_SETTINGS);
      expect(result.settings.camera).toEqual(DEFAULT_CAMERA_SETTINGS);
      // Written forward to the dedicated current key, not back into the v2 one —
      // a downgraded build must never see (and clobber) the migrated result.
      expect(JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual(result.settings);
      expect(storage.values.get(LEGACY_V2_SETTINGS_STORAGE_KEY)).toEqual(
        JSON.stringify(profileV2Fixture),
      );
    });

    it('a wrong-version document at the current key fails closed with a version-specific error', () => {
      const storage = new MemoryStorage();
      storage.values.set(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({ ...DEFAULT_GAME_SETTINGS, version: 99 }),
      );

      const result = new SettingsRepository(storage).load();

      expect(result).toMatchObject({ ok: false, settings: DEFAULT_GAME_SETTINGS });
      if (!result.ok) expect(result.error).toMatch(/profile settings version must be 7/u);
    });

    it('fails closed when writing a migrated legacy profile fails', () => {
      const storage = new MemoryStorage();
      storage.values.set(LEGACY_V2_SETTINGS_STORAGE_KEY, JSON.stringify(profileV2Fixture));
      storage.setError = new Error('quota');

      const result = new SettingsRepository(storage).load();

      expect(result).toMatchObject({ ok: false, settings: DEFAULT_GAME_SETTINGS });
      if (!result.ok) expect(result.error).toMatch(/migrate settings.*quota/iu);
    });

    it('prefers the current key over a stale v2 key present alongside it (downgrade safety)', () => {
      // A player who briefly ran an older, pre-T0106 build would have left a
      // v2 document sitting at the v2 key without ever writing to the current
      // key it doesn't know about. That document must never be consulted, let
      // alone allowed to shadow or overwrite the current one, once an up-to-date
      // build is running again — the entire point of a dedicated key per
      // generation instead of one shared, version-bumped-in-place key.
      const storage = new MemoryStorage();
      const current = updateGamepadDeadzone(DEFAULT_GAME_SETTINGS, 0.25);
      storage.values.set(SETTINGS_STORAGE_KEY, JSON.stringify(current));
      storage.values.set(LEGACY_V2_SETTINGS_STORAGE_KEY, JSON.stringify(profileV2Fixture));

      const result = new SettingsRepository(storage).load();

      expect(result).toEqual({ ok: true, settings: current, source: 'stored' });
      // Untouched: a current-key read must not write anywhere, including stale keys.
      expect(storage.values.get(LEGACY_V2_SETTINGS_STORAGE_KEY)).toBe(
        JSON.stringify(profileV2Fixture),
      );
    });
  });

  describe('camera settings (T0110)', () => {
    function profileV3Document(): Record<string, unknown> {
      return {
        version: 3,
        qualityLock: 'high',
        inputBindings: { ...DEFAULT_GAME_SETTINGS.inputBindings },
        tutorial: { status: 'completed', stepId: 'return-to-play' },
        gamepad: JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_SETTINGS)) as unknown,
      };
    }

    it('defaults both chase effects on, because they are sized to be subtle rather than opt-in', () => {
      expect(DEFAULT_CAMERA_SETTINGS).toEqual({ fovWidening: true, shake: true });
      expect(DEFAULT_GAME_SETTINGS.camera).toBe(DEFAULT_CAMERA_SETTINGS);
    });

    it('toggles each effect independently and keeps the document valid', () => {
      const noFov = updateCameraFovWidening(DEFAULT_GAME_SETTINGS, false);
      expect(noFov.camera).toEqual({ fovWidening: false, shake: true });
      const neither = updateCameraShake(noFov, false);
      expect(neither.camera).toEqual({ fovWidening: false, shake: false });
      expect(() => parseProfileSettings(neither)).not.toThrow();
      expect(Object.isFrozen(neither.camera)).toBe(true);
    });

    it('rejects an incomplete, excess or mistyped camera document', () => {
      expect(() =>
        parseProfileSettings({ ...DEFAULT_GAME_SETTINGS, camera: { fovWidening: true } }),
      ).toThrow(/field is missing: shake/u);
      expect(() =>
        parseProfileSettings({
          ...DEFAULT_GAME_SETTINGS,
          camera: { ...DEFAULT_CAMERA_SETTINGS, extra: true },
        }),
      ).toThrow(/unknown camera settings field/u);
      expect(() =>
        parseProfileSettings({
          ...DEFAULT_GAME_SETTINGS,
          camera: { fovWidening: 'yes', shake: true },
        }),
      ).toThrow(/fovWidening must be a boolean/u);
      expect(() => parseProfileSettings({ ...DEFAULT_GAME_SETTINGS, camera: null })).toThrow(
        /camera settings must be an object/u,
      );
    });

    it('migrates a stored v3 profile across three generations to the current key', () => {
      const storage = new MemoryStorage();
      const document = profileV3Document();
      storage.values.set(LEGACY_V3_SETTINGS_STORAGE_KEY, JSON.stringify(document));

      const result = new SettingsRepository(storage).load();

      expect(result).toMatchObject({ ok: true, source: 'migrated' });
      expect(result.settings.version).toBe(7);
      expect(result.settings.qualityLock).toBe('high');
      expect(result.settings.tutorial).toEqual({
        status: 'completed',
        stepId: 'return-to-play',
      });
      expect(result.settings.gamepad).toEqual(DEFAULT_GAMEPAD_SETTINGS);
      expect(result.settings.camera).toEqual(DEFAULT_CAMERA_SETTINGS);
      expect(JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual(result.settings);
      // The v3 document stays where it is: a rolled-back build reads its own key
      // and never sees, or clobbers, the newer one.
      expect(storage.values.get(LEGACY_V3_SETTINGS_STORAGE_KEY)).toBe(JSON.stringify(document));
    });

    it('prefers the current key over a stale v3 key present alongside it', () => {
      const storage = new MemoryStorage();
      const current = updateCameraShake(DEFAULT_GAME_SETTINGS, false);
      storage.values.set(SETTINGS_STORAGE_KEY, JSON.stringify(current));
      storage.values.set(LEGACY_V3_SETTINGS_STORAGE_KEY, JSON.stringify(profileV3Document()));

      expect(new SettingsRepository(storage).load()).toEqual({
        ok: true,
        settings: current,
        source: 'stored',
      });
    });

    it('preserves camera toggles across a save import, like tutorial and gamepad state', () => {
      const customized = updateCameraShake(DEFAULT_GAME_SETTINGS, false);
      const imported = projectGameSettingsV1(DEFAULT_GAME_SETTINGS);

      expect(mergeGameSettingsPreferences(customized, imported).camera).toEqual({
        fovWidening: true,
        shake: false,
      });
    });

    it('keeps camera toggles out of the save-embedded preferences DTO', () => {
      const projected = projectGameSettingsV1(updateCameraShake(DEFAULT_GAME_SETTINGS, false));
      expect(Object.keys(projected)).toEqual(['version', 'qualityLock', 'inputBindings']);
    });
  });
});

describe('HUD settings (T0112)', () => {
  function profileV4Document(): Record<string, unknown> {
    return {
      version: 4,
      qualityLock: 'low',
      inputBindings: { ...DEFAULT_GAME_SETTINGS.inputBindings },
      tutorial: { status: 'skipped', stepId: 'focus-target' },
      gamepad: JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_SETTINGS)) as unknown,
      camera: { fovWidening: false, shake: true },
    };
  }

  /**
   * The whole point of the task: instrumentation is opt-in now. A fresh profile
   * lands on Clean, and world labels stay on because a label with a distance is
   * navigation rather than instrumentation.
   */
  it('defaults to the Clean preset with world labels on', () => {
    expect(DEFAULT_HUD_SETTINGS).toEqual({ preset: 'clean', bodyLabels: true });
    expect(DEFAULT_GAME_SETTINGS.hud).toBe(DEFAULT_HUD_SETTINGS);
    expect(DEFAULT_GAME_SETTINGS.version).toBe(7);
  });

  it('updates each preference independently and keeps the document valid', () => {
    const engineer = updateHudPreset(DEFAULT_GAME_SETTINGS, 'engineer');
    expect(engineer.hud).toEqual({ preset: 'engineer', bodyLabels: true });
    const quiet = updateHudBodyLabels(engineer, false);
    expect(quiet.hud).toEqual({ preset: 'engineer', bodyLabels: false });
    expect(() => parseProfileSettings(quiet)).not.toThrow();
    expect(Object.isFrozen(quiet.hud)).toBe(true);
  });

  it('rejects an incomplete, excess or mistyped hud document', () => {
    expect(() =>
      parseProfileSettings({ ...DEFAULT_GAME_SETTINGS, hud: { preset: 'clean' } }),
    ).toThrow(/field is missing: bodyLabels/u);
    expect(() =>
      parseProfileSettings({
        ...DEFAULT_GAME_SETTINGS,
        hud: { ...DEFAULT_HUD_SETTINGS, extra: 1 },
      }),
    ).toThrow(/unknown hud settings field/u);
    expect(() =>
      parseProfileSettings({
        ...DEFAULT_GAME_SETTINGS,
        hud: { preset: 'spreadsheet', bodyLabels: true },
      }),
    ).toThrow(/hud preset is not supported/u);
    expect(() =>
      parseProfileSettings({
        ...DEFAULT_GAME_SETTINGS,
        hud: { preset: 'clean', bodyLabels: 'yes' },
      }),
    ).toThrow(/bodyLabels must be a boolean/u);
    expect(() => parseProfileSettings({ ...DEFAULT_GAME_SETTINGS, hud: null })).toThrow(
      /hud settings must be an object/u,
    );
  });

  it('migrates a stored v4 profile forward to the current key', () => {
    const storage = new MemoryStorage();
    const document = profileV4Document();
    storage.values.set(LEGACY_V4_SETTINGS_STORAGE_KEY, JSON.stringify(document));

    const result = new SettingsRepository(storage).load();

    expect(result).toMatchObject({ ok: true, source: 'migrated' });
    expect(result.settings.version).toBe(7);
    expect(result.settings.qualityLock).toBe('low');
    expect(result.settings.camera).toEqual({ fovWidening: false, shake: true });
    expect(result.settings.hud).toEqual(DEFAULT_HUD_SETTINGS);
    expect(JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual(result.settings);
    // A rolled-back build reads its own key and cannot clobber the newer one.
    expect(storage.values.get(LEGACY_V4_SETTINGS_STORAGE_KEY)).toBe(JSON.stringify(document));
  });

  it('prefers the current key over a stale v4 key present alongside it', () => {
    const storage = new MemoryStorage();
    const current = updateHudPreset(DEFAULT_GAME_SETTINGS, 'pilot');
    storage.values.set(SETTINGS_STORAGE_KEY, JSON.stringify(current));
    storage.values.set(LEGACY_V4_SETTINGS_STORAGE_KEY, JSON.stringify(profileV4Document()));

    expect(new SettingsRepository(storage).load()).toEqual({
      ok: true,
      settings: current,
      source: 'stored',
    });
  });

  it('climbs all five migration tiers from the original v1 key', () => {
    const storage = new MemoryStorage();
    storage.values.set(
      LEGACY_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        qualityLock: 'high',
        inputBindings: { ...DEFAULT_GAME_SETTINGS.inputBindings },
      }),
    );

    const result = new SettingsRepository(storage).load();

    expect(result).toMatchObject({ ok: true, source: 'migrated' });
    expect(result.settings.version).toBe(7);
    expect(result.settings.qualityLock).toBe('high');
    expect(result.settings.hud).toEqual(DEFAULT_HUD_SETTINGS);
    expect(result.settings.camera).toEqual(DEFAULT_CAMERA_SETTINGS);
    expect(result.settings.gamepad).toEqual(DEFAULT_GAMEPAD_SETTINGS);
  });

  it('keeps HUD preferences out of an imported save, like tutorial and camera state', () => {
    const customized = updateHudBodyLabels(
      updateHudPreset(DEFAULT_GAME_SETTINGS, 'engineer'),
      false,
    );
    const imported = projectGameSettingsV1(DEFAULT_GAME_SETTINGS);

    const merged = mergeGameSettingsPreferences(customized, imported);

    // Profile state, not mission state: a save someone emails you must not
    // rearrange your HUD.
    expect(merged.hud).toEqual(customized.hud);
  });

  /**
   * `parseGameSettings` runs on every save load, so an action added by a later
   * task must be backfilled rather than rejected — otherwise every existing save
   * becomes unloadable the moment the registry grows. T0112 grew it by two.
   */
  it('keeps a save written before the HUD actions existed loadable', () => {
    const bindings: Record<string, string> = { ...DEFAULT_GAME_SETTINGS.inputBindings };
    delete bindings.hudPresetCycle;
    delete bindings.hudBodyLabelsToggle;

    const parsed = parseGameSettings({ version: 1, qualityLock: 'auto', inputBindings: bindings });

    expect(parsed.inputBindings.hudPresetCycle).toBe('KeyH');
    expect(parsed.inputBindings.hudBodyLabelsToggle).toBe('KeyL');
    expect(() => parseGameSettings(parsed)).not.toThrow();
  });

  it('leaves a HUD action unbound rather than failing when its default is taken', () => {
    const bindings: Record<string, string> = { ...DEFAULT_GAME_SETTINGS.inputBindings };
    delete bindings.hudPresetCycle;
    bindings.rollLeft = 'KeyH';

    const parsed = parseGameSettings({ version: 1, qualityLock: 'auto', inputBindings: bindings });

    expect(parsed.inputBindings.rollLeft).toBe('KeyH');
    expect(isUnboundInputCode(parsed.inputBindings.hudPresetCycle)).toBe(true);
  });
});

describe('render settings (T0127)', () => {
  function profileV5Document(): Record<string, unknown> {
    return {
      version: 5,
      qualityLock: 'medium',
      inputBindings: { ...DEFAULT_GAME_SETTINGS.inputBindings },
      tutorial: { status: 'completed', stepId: 'return-to-play' },
      gamepad: JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_SETTINGS)) as unknown,
      camera: { fovWidening: false, shake: false },
      hud: { preset: 'pilot', bodyLabels: false },
    };
  }

  /**
   * Adaptive exposure is the point of T0127, so it is on out of the box; `fixed`
   * exists because a moving exposure is a real accessibility concern and because
   * the governor pins it on its lowest rungs.
   */
  it('defaults to adaptive exposure', () => {
    expect(DEFAULT_RENDER_SETTINGS).toEqual({ exposureMode: 'auto' });
    expect(DEFAULT_GAME_SETTINGS.render).toBe(DEFAULT_RENDER_SETTINGS);
  });

  it('updates the exposure mode and keeps the document valid', () => {
    const fixed = updateRenderExposureMode(DEFAULT_GAME_SETTINGS, 'fixed');
    expect(fixed.render).toEqual({ exposureMode: 'fixed' });
    expect(Object.isFrozen(fixed.render)).toBe(true);
    expect(() => parseProfileSettings(fixed)).not.toThrow();
    expect(updateRenderExposureMode(fixed, 'auto').render).toEqual({ exposureMode: 'auto' });
  });

  it('rejects an incomplete, excess or mistyped render document', () => {
    expect(() => parseProfileSettings({ ...DEFAULT_GAME_SETTINGS, render: {} })).toThrow(
      /field is missing: exposureMode/u,
    );
    expect(() =>
      parseProfileSettings({
        ...DEFAULT_GAME_SETTINGS,
        render: { exposureMode: 'auto', extra: 1 },
      }),
    ).toThrow(/unknown render settings field/u);
    expect(() =>
      parseProfileSettings({ ...DEFAULT_GAME_SETTINGS, render: { exposureMode: 'cinematic' } }),
    ).toThrow(/render exposure mode is not supported/u);
    expect(() => parseProfileSettings({ ...DEFAULT_GAME_SETTINGS, render: null })).toThrow(
      /render settings must be an object/u,
    );
  });

  it('migrates a stored v5 profile forward to the current key', () => {
    const storage = new MemoryStorage();
    const document = profileV5Document();
    storage.values.set(LEGACY_V5_SETTINGS_STORAGE_KEY, JSON.stringify(document));

    const result = new SettingsRepository(storage).load();

    expect(result).toMatchObject({ ok: true, source: 'migrated' });
    expect(result.settings.version).toBe(7);
    expect(result.settings.qualityLock).toBe('medium');
    expect(result.settings.hud).toEqual({ preset: 'pilot', bodyLabels: false });
    expect(result.settings.camera).toEqual({ fovWidening: false, shake: false });
    expect(result.settings.render).toEqual(DEFAULT_RENDER_SETTINGS);
    // Two generations in one read since T0144: v5 -> v6 attaches the exposure
    // mode, v6 -> v7 attaches the mixer, and both land on their defaults.
    expect(result.settings.audio).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual(result.settings);
    // A rolled-back build reads its own key and cannot clobber the newer one.
    expect(storage.values.get(LEGACY_V5_SETTINGS_STORAGE_KEY)).toBe(JSON.stringify(document));
  });

  it('prefers the current key over a stale v5 key present alongside it', () => {
    const storage = new MemoryStorage();
    const current = updateRenderExposureMode(DEFAULT_GAME_SETTINGS, 'fixed');
    storage.values.set(SETTINGS_STORAGE_KEY, JSON.stringify(current));
    storage.values.set(LEGACY_V5_SETTINGS_STORAGE_KEY, JSON.stringify(profileV5Document()));

    expect(new SettingsRepository(storage).load()).toEqual({
      ok: true,
      settings: current,
      source: 'stored',
    });
  });

  it('keeps the exposure mode out of an imported save, like camera and HUD state', () => {
    const customized = updateRenderExposureMode(DEFAULT_GAME_SETTINGS, 'fixed');
    const imported = projectGameSettingsV1(DEFAULT_GAME_SETTINGS);

    expect(mergeGameSettingsPreferences(customized, imported).render).toEqual({
      exposureMode: 'fixed',
    });
    expect(Object.keys(projectGameSettingsV1(customized))).toEqual([
      'version',
      'qualityLock',
      'inputBindings',
    ]);
  });
});

/**
 * T0144 — profile generation v7: the mixer.
 *
 * Design: `docs/superpowers/specs/2026-08-16-audio-engine-design.md` section 6.
 * ADR-041 records the "ships audible, not muted" decision these defaults encode.
 * The generation is v7 rather than v6 because T0127 took v6 for `render` first;
 * the two stay separate migration tiers so the chain says what was added when.
 */
describe('audio settings (T0144)', () => {
  function profileV6Document(): Record<string, unknown> {
    return {
      version: 6,
      qualityLock: 'medium',
      inputBindings: { ...DEFAULT_GAME_SETTINGS.inputBindings },
      tutorial: { status: 'completed', stepId: 'return-to-play' },
      gamepad: JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_SETTINGS)) as unknown,
      camera: { fovWidening: false, shake: false },
      hud: { preset: 'pilot', bodyLabels: false },
      render: { exposureMode: 'fixed' },
    };
  }

  it('ships audible at modest levels rather than muted', () => {
    // The decision the task brief demanded be closed: a fresh profile makes
    // sound. Silence before the first gesture is the AudioContext lifecycle's
    // job, not the mixer's.
    expect(DEFAULT_AUDIO_SETTINGS).toEqual({
      master: 0.7,
      music: 0.5,
      sfx: 0.7,
      ui: 0.5,
      exteriorMusic: true,
    });
    for (const bus of AUDIO_BUSES) {
      expect(DEFAULT_AUDIO_SETTINGS[bus]).toBeGreaterThan(0);
      expect(DEFAULT_AUDIO_SETTINGS[bus]).toBeLessThan(1);
    }
    expect(DEFAULT_GAME_SETTINGS.audio).toBe(DEFAULT_AUDIO_SETTINGS);
    expect(DEFAULT_GAME_SETTINGS.version).toBe(7);
  });

  it('updates each bus independently and keeps the document valid', () => {
    let settings = DEFAULT_GAME_SETTINGS;
    for (const bus of AUDIO_BUSES) settings = updateAudioLevel(settings, bus, 0.25);
    expect(settings.audio).toEqual({
      master: 0.25,
      music: 0.25,
      sfx: 0.25,
      ui: 0.25,
      exteriorMusic: true,
    });
    const vacuum = updateAudioExteriorMusic(settings, false);
    expect(vacuum.audio.exteriorMusic).toBe(false);
    expect(vacuum.audio.master).toBe(0.25);
    expect(() => parseProfileSettings(vacuum)).not.toThrow();
    expect(Object.isFrozen(vacuum.audio)).toBe(true);
  });

  it('accepts both ends of the slider', () => {
    expect(updateAudioLevel(DEFAULT_GAME_SETTINGS, 'master', 0).audio.master).toBe(0);
    expect(updateAudioLevel(DEFAULT_GAME_SETTINGS, 'master', 1).audio.master).toBe(1);
  });

  it('rejects an incomplete, excess or out-of-range audio document', () => {
    expect(() =>
      parseProfileSettings({
        ...DEFAULT_GAME_SETTINGS,
        audio: { master: 1, music: 1, sfx: 1, exteriorMusic: true },
      }),
    ).toThrow(/field is missing: ui/u);
    expect(() =>
      parseProfileSettings({
        ...DEFAULT_GAME_SETTINGS,
        audio: { ...DEFAULT_AUDIO_SETTINGS, extra: 1 },
      }),
    ).toThrow(/unknown audio settings field/u);
    expect(() => updateAudioLevel(DEFAULT_GAME_SETTINGS, 'music', 1.5)).toThrow(
      /audio music level must be a number in \[0, 1\]/u,
    );
    expect(() => updateAudioLevel(DEFAULT_GAME_SETTINGS, 'sfx', Number.NaN)).toThrow(
      /audio sfx level must be a number/u,
    );
    expect(() =>
      parseProfileSettings({
        ...DEFAULT_GAME_SETTINGS,
        audio: { ...DEFAULT_AUDIO_SETTINGS, exteriorMusic: 'yes' },
      }),
    ).toThrow(/exteriorMusic must be a boolean/u);
    expect(() => parseProfileSettings({ ...DEFAULT_GAME_SETTINGS, audio: null })).toThrow(
      /audio settings must be an object/u,
    );
  });

  it('migrates a stored v6 profile to v7 and writes it forward to the current key', () => {
    const storage = new MemoryStorage();
    const document = profileV6Document();
    storage.values.set(LEGACY_V6_SETTINGS_STORAGE_KEY, JSON.stringify(document));

    const result = new SettingsRepository(storage).load();

    expect(result).toMatchObject({ ok: true, source: 'migrated' });
    expect(result.settings.version).toBe(7);
    expect(result.settings.qualityLock).toBe('medium');
    expect(result.settings.hud).toEqual({ preset: 'pilot', bodyLabels: false });
    // T0127's field survives the tier that follows it — the point of keeping the
    // two generations separate rather than folding audio into v6.
    expect(result.settings.render).toEqual({ exposureMode: 'fixed' });
    // A returning player lands on the shipped defaults, audible — the same
    // posture a new profile gets.
    expect(result.settings.audio).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual(result.settings);
    // A rolled-back build reads its own key and cannot clobber the newer one.
    expect(storage.values.get(LEGACY_V6_SETTINGS_STORAGE_KEY)).toBe(JSON.stringify(document));
  });

  it('prefers the current key over a stale v6 key present alongside it', () => {
    const storage = new MemoryStorage();
    const current = updateAudioLevel(DEFAULT_GAME_SETTINGS, 'music', 0.15);
    storage.values.set(SETTINGS_STORAGE_KEY, JSON.stringify(current));
    storage.values.set(LEGACY_V6_SETTINGS_STORAGE_KEY, JSON.stringify(profileV6Document()));

    expect(new SettingsRepository(storage).load()).toEqual({
      ok: true,
      settings: current,
      source: 'stored',
    });
  });

  it('keeps mixer levels out of an imported save, like tutorial and HUD state', () => {
    const customized = updateAudioExteriorMusic(
      updateAudioLevel(DEFAULT_GAME_SETTINGS, 'master', 0.1),
      false,
    );
    const imported = projectGameSettingsV1(DEFAULT_GAME_SETTINGS);

    const merged = mergeGameSettingsPreferences(customized, imported);

    // Profile state, not mission state: a save someone emails you must not turn
    // your speakers up.
    expect(merged.audio).toEqual(customized.audio);
  });
});
