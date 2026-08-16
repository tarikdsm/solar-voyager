import { describe, expect, it, vi } from 'vitest';

import { SceneManager } from '../game/sceneManager.js';
import type { SessionActionResult, SessionExportResult } from '../game/sessionController.js';
import {
  DEFAULT_GAME_SETTINGS,
  parseProfileSettings,
  rebindInput,
  updateCameraFovWidening,
  updateCameraShake,
  updateGamepadAxisInvert,
  updateGamepadAxisSensitivity,
  updateGamepadCurveExponent,
  updateGamepadDeadzone,
  updateHudBodyLabels,
  updateHudPreset,
  updateSkyConstellations,
  updateSkyPanorama,
  updateSkyZodiacalLight,
  type GamepadAxisId,
  type GameSettingsV6,
  type HudPreset,
  type InputAction,
  type QualityLock,
} from '../game/settings.js';
import {
  createSessionSettingsModel,
  type SessionFilePort,
  type SessionSettingsPort,
} from './SessionSettingsPanel.js';

class FakeSession implements SessionSettingsPort {
  initializationWarning: string | null = null;
  settings: GameSettingsV6 = DEFAULT_GAME_SETTINGS;
  importedJson = '';
  importCalls = 0;
  loadCalls = 0;
  loadResult: SessionActionResult = { ok: true, message: 'Session loaded' };
  saveResult: SessionActionResult = { ok: true, message: 'Session saved' };
  exportResult: SessionExportResult = { ok: true, json: '{"version":2}' };

  exportJson(): SessionExportResult {
    return this.exportResult;
  }

  importJson(json: string): SessionActionResult {
    this.importCalls += 1;
    this.importedJson = json;
    return { ok: true, message: 'Session imported' };
  }

  loadLocal(): SessionActionResult {
    this.loadCalls += 1;
    return this.loadResult;
  }

  rebind(action: InputAction, code: string): SessionActionResult {
    try {
      this.settings = rebindInput(this.settings, action, code);
      return { ok: true, message: 'Input binding updated' };
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update input binding',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  saveLocal(): SessionActionResult {
    return this.saveResult;
  }

  setCameraFovWidening(fovWidening: boolean): SessionActionResult {
    this.settings = updateCameraFovWidening(this.settings, fovWidening);
    return { ok: true, message: 'Camera field of view updated' };
  }

  setCameraShake(shake: boolean): SessionActionResult {
    this.settings = updateCameraShake(this.settings, shake);
    return { ok: true, message: 'Camera shake updated' };
  }

  setSkyPanorama(enabled: boolean): SessionActionResult {
    this.settings = updateSkyPanorama(this.settings, enabled);
    return { ok: true, message: 'Milky Way panorama updated' };
  }

  setSkyZodiacalLight(enabled: boolean): SessionActionResult {
    this.settings = updateSkyZodiacalLight(this.settings, enabled);
    return { ok: true, message: 'Zodiacal light updated' };
  }

  setSkyConstellations(enabled: boolean): SessionActionResult {
    this.settings = updateSkyConstellations(this.settings, enabled);
    return { ok: true, message: 'Constellation lines updated' };
  }

  setHudPreset(preset: HudPreset): SessionActionResult {
    this.settings = updateHudPreset(this.settings, preset);
    return { ok: true, message: 'HUD preset updated' };
  }

  setHudBodyLabels(bodyLabels: boolean): SessionActionResult {
    this.settings = updateHudBodyLabels(this.settings, bodyLabels);
    return { ok: true, message: 'Body labels updated' };
  }

  updateQualityLock(qualityLock: QualityLock): SessionActionResult {
    this.settings = parseProfileSettings({ ...this.settings, qualityLock });
    return { ok: true, message: 'Quality setting updated' };
  }

  setGamepadDeadzone(deadzone: number): SessionActionResult {
    try {
      this.settings = updateGamepadDeadzone(this.settings, deadzone);
      return { ok: true, message: 'Gamepad deadzone updated' };
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update gamepad deadzone',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  setGamepadCurveExponent(curveExponent: number): SessionActionResult {
    try {
      this.settings = updateGamepadCurveExponent(this.settings, curveExponent);
      return { ok: true, message: 'Gamepad response curve updated' };
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update gamepad response curve',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  setGamepadAxisInvert(axis: GamepadAxisId, invert: boolean): SessionActionResult {
    this.settings = updateGamepadAxisInvert(this.settings, axis, invert);
    return { ok: true, message: 'Gamepad axis invert updated' };
  }

  setGamepadAxisSensitivity(axis: GamepadAxisId, sensitivity: number): SessionActionResult {
    try {
      this.settings = updateGamepadAxisSensitivity(this.settings, axis, sensitivity);
      return { ok: true, message: 'Gamepad axis sensitivity updated' };
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update gamepad axis sensitivity',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function createSceneManager(session: FakeSession): SceneManager {
  return new SceneManager({
    hasValidLocalSave: () => true,
    startNewGame: () => ({ ok: true, message: 'New game started' }),
    loadLocal: () => session.loadLocal(),
  });
}

class FakeFiles implements SessionFilePort {
  downloaded: { readonly filename: string; readonly json: string } | null = null;
  readValue = '{"version":1}';
  saveError: unknown = null;

  async readText(): Promise<string> {
    return this.readValue;
  }

  saveJson(filename: string, json: string): void {
    if (this.saveError !== null) throw this.saveError;
    this.downloaded = { filename, json };
  }
}

class DeferredFiles extends FakeFiles {
  private resolveRead: ((value: string) => void) | null = null;

  override readText(): Promise<string> {
    return new Promise((resolve) => {
      this.resolveRead = resolve;
    });
  }

  finishRead(value = this.readValue): void {
    if (this.resolveRead === null) throw new Error('No file read is pending');
    this.resolveRead(value);
    this.resolveRead = null;
  }
}

describe('session settings panel model', () => {
  it('does not import after another menu action enters space during the file read', async () => {
    const session = new FakeSession();
    const files = new DeferredFiles();
    const scenes = createSceneManager(session);
    const model = createSessionSettingsModel(session, files, null, (action) =>
      scenes.activateSession(action),
    );

    const pendingImport = model.importFile({} as File);
    expect(scenes.startNewGame()).toMatchObject({ ok: true });
    files.finishRead();

    expect(await pendingImport).toEqual({
      ok: false,
      message: 'Space phase is already active',
    });
    expect(session.importCalls).toBe(0);
    expect(session.importedJson).toBe('');
  });

  it('does not load again after the first guarded load activates space', () => {
    const session = new FakeSession();
    const scenes = createSceneManager(session);
    const model = createSessionSettingsModel(session, new FakeFiles(), null, (action) =>
      scenes.activateSession(action),
    );

    expect(model.load()).toEqual({ ok: true, message: 'Session loaded' });
    expect(model.load()).toEqual({ ok: false, message: 'Space phase is already active' });
    expect(model.load()).toEqual({ ok: false, message: 'Space phase is already active' });
    expect(session.loadCalls).toBe(1);
  });

  it('announces only successful load and import actions as playable sessions', async () => {
    const session = new FakeSession();
    const files = new FakeFiles();
    const activations: SessionActionResult[] = [];
    const model = createSessionSettingsModel(session, files, (result) => activations.push(result));

    model.save();
    model.selectQuality('low');
    model.captureBinding('pitchUp', 'KeyI');
    model.exportFile();
    expect(activations).toEqual([]);

    session.loadResult = { ok: false, message: 'No local save found' };
    model.load();
    expect(activations).toEqual([]);

    session.loadResult = { ok: true, message: 'Session loaded' };
    model.load();
    expect(activations).toEqual([{ ok: true, message: 'Session loaded' }]);

    session.importJson = () => ({ ok: false, message: 'Imported session is invalid' });
    await model.importFile({} as File);
    expect(activations).toHaveLength(1);

    session.importJson = () => ({ ok: true, message: 'Session imported' });
    await model.importFile({} as File);
    expect(activations).toEqual([
      { ok: true, message: 'Session loaded' },
      { ok: true, message: 'Session imported' },
    ]);
  });

  it('forwards save/load and keeps their actionable messages', () => {
    const session = new FakeSession();
    const model = createSessionSettingsModel(session, new FakeFiles());

    expect(model.save()).toEqual({ ok: true, message: 'Session saved' });
    expect(model.load()).toEqual({ ok: true, message: 'Session loaded' });
    session.loadResult = { ok: false, message: 'No local save found' };
    expect(model.load()).toEqual({ ok: false, message: 'No local save found' });
  });

  it('reports only successful saves through the optional tutorial seam', () => {
    const session = new FakeSession();
    const onSaveSucceeded = vi.fn();
    const model = createSessionSettingsModel(session, new FakeFiles(), null, null, onSaveSucceeded);

    expect(model.save()).toMatchObject({ ok: true });
    expect(onSaveSucceeded).toHaveBeenCalledOnce();
    session.saveResult = { ok: false, message: 'Storage unavailable' };
    expect(model.save()).toMatchObject({ ok: false });
    expect(onSaveSucceeded).toHaveBeenCalledOnce();
  });

  it('exports through the injected file port and reports file failures', () => {
    const session = new FakeSession();
    const files = new FakeFiles();
    const model = createSessionSettingsModel(session, files);

    expect(model.exportFile()).toEqual({ ok: true, message: 'Session exported' });
    expect(files.downloaded).toEqual({
      filename: 'solar-voyager-save.json',
      json: '{"version":2}',
    });
    files.saveError = new Error('download denied');
    expect(model.exportFile()).toMatchObject({ ok: false, message: 'Unable to export session' });
  });

  it('imports selected files and treats cancellation as a no-op', async () => {
    const session = new FakeSession();
    const files = new FakeFiles();
    const model = createSessionSettingsModel(session, files);

    expect(await model.importFile(null)).toBeNull();
    expect(await model.importFile({} as File)).toEqual({ ok: true, message: 'Session imported' });
    expect(session.importedJson).toBe('{"version":1}');
  });

  it('updates quality and bindings while retaining rejected binding state', () => {
    const session = new FakeSession();
    const model = createSessionSettingsModel(session, new FakeFiles());

    expect(model.selectQuality('low')).toMatchObject({ ok: true });
    expect(session.settings.qualityLock).toBe('low');
    expect(model.captureBinding('pitchUp', 'KeyI')).toMatchObject({ ok: true });
    expect(session.settings.inputBindings.pitchUp).toBe('KeyI');
    const before = session.settings;
    expect(model.captureBinding('pitchUp', session.settings.inputBindings.pitchDown)).toMatchObject(
      {
        ok: false,
      },
    );
    expect(session.settings).toBe(before);
    expect(model.selectQuality('ultra')).toMatchObject({ ok: false });
  });

  describe('gamepad settings controls (T0106)', () => {
    it('parses the deadzone and curve-exponent inputs as numbers', () => {
      const session = new FakeSession();
      const model = createSessionSettingsModel(session, new FakeFiles());

      expect(model.selectGamepadDeadzone('0.2')).toMatchObject({ ok: true });
      expect(session.settings.gamepad.deadzone).toBe(0.2);
      expect(model.selectGamepadCurveExponent('2')).toMatchObject({ ok: true });
      expect(session.settings.gamepad.curveExponent).toBe(2);
    });

    it('rejects an empty or non-numeric input without touching settings', () => {
      const session = new FakeSession();
      const model = createSessionSettingsModel(session, new FakeFiles());
      const before = session.settings;

      expect(model.selectGamepadDeadzone('')).toMatchObject({ ok: false });
      expect(model.selectGamepadDeadzone('not-a-number')).toMatchObject({ ok: false });
      expect(model.selectGamepadCurveExponent('  ')).toMatchObject({ ok: false });
      expect(session.settings).toBe(before);
    });

    it('surfaces the underlying range validation as a failed result', () => {
      const session = new FakeSession();
      const model = createSessionSettingsModel(session, new FakeFiles());

      expect(model.selectGamepadDeadzone('5')).toMatchObject({ ok: false });
      expect(model.selectGamepadAxisSensitivity('pitch', '99')).toMatchObject({ ok: false });
    });

    it('toggles one axis invert flag and parses that axis sensitivity independently', () => {
      const session = new FakeSession();
      const model = createSessionSettingsModel(session, new FakeFiles());

      expect(model.setGamepadAxisInvert('roll', true)).toMatchObject({ ok: true });
      expect(session.settings.gamepad.axes.roll.invert).toBe(true);
      expect(session.settings.gamepad.axes.pitch.invert).toBe(false);

      expect(model.selectGamepadAxisSensitivity('throttle', '1.75')).toMatchObject({ ok: true });
      expect(session.settings.gamepad.axes.throttle.sensitivity).toBe(1.75);
      expect(session.settings.gamepad.axes.roll.invert).toBe(true); // still set from above
    });
  });

  describe('sky settings controls (T0126)', () => {
    it('forwards each deep-sky checkbox to its own port method', () => {
      const session = new FakeSession();
      const model = createSessionSettingsModel(session, new FakeFiles());

      expect(model.setSkyPanorama(false)).toEqual({ ok: true, message: 'Milky Way panorama updated' });
      expect(session.settings.sky.panorama).toBe(false);
      expect(model.setSkyZodiacalLight(false)).toEqual({
        ok: true,
        message: 'Zodiacal light updated',
      });
      expect(session.settings.sky.zodiacalLight).toBe(false);
      expect(model.setSkyConstellations(true)).toEqual({
        ok: true,
        message: 'Constellation lines updated',
      });
      expect(session.settings.sky.constellations).toBe(true);
    });

    it('leaves the other two toggles alone when one changes', () => {
      const session = new FakeSession();
      const model = createSessionSettingsModel(session, new FakeFiles());

      expect(model.setSkyConstellations(true)).toMatchObject({ ok: true });

      expect(session.settings.sky).toEqual({
        panorama: true,
        zodiacalLight: true,
        constellations: true,
      });
    });
  });
});
