import { describe, expect, it } from 'vitest';

import { SceneManager } from '../game/sceneManager.js';
import type { SessionActionResult, SessionExportResult } from '../game/sessionController.js';
import {
  DEFAULT_GAME_SETTINGS,
  parseGameSettings,
  rebindInput,
  type GameSettingsV1,
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
  settings: GameSettingsV1 = DEFAULT_GAME_SETTINGS;
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

  updateQualityLock(qualityLock: QualityLock): SessionActionResult {
    this.settings = parseGameSettings({ ...this.settings, qualityLock });
    return { ok: true, message: 'Quality setting updated' };
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
});
