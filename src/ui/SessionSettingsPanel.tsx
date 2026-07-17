import { useMemo, useState } from 'preact/hooks';

import type { SessionActionResult, SessionExportResult } from '../game/sessionController.js';
import {
  INPUT_ACTIONS,
  type GameSettingsV1,
  type InputAction,
  type QualityLock,
} from '../game/settings.js';

export interface SessionSettingsPort {
  readonly initializationWarning: string | null;
  readonly settings: GameSettingsV1;
  exportJson(): SessionExportResult;
  importJson(json: string): SessionActionResult;
  loadLocal(): SessionActionResult;
  rebind(action: InputAction, code: string): SessionActionResult;
  saveLocal(): SessionActionResult;
  updateQualityLock(qualityLock: QualityLock): SessionActionResult;
}

export interface SessionFilePort {
  readText(file: File): Promise<string>;
  saveJson(filename: string, json: string): void;
}

export interface PanelActionResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface SessionSettingsModel {
  save(): PanelActionResult;
  load(): PanelActionResult;
  exportFile(): PanelActionResult;
  importFile(file: File | null): Promise<PanelActionResult | null>;
  selectQuality(value: string): PanelActionResult;
  captureBinding(action: InputAction, code: string): PanelActionResult;
}

const INPUT_ACTION_LABELS: Readonly<Record<InputAction, string>> = Object.freeze({
  throttleIncrease: 'Throttle up',
  throttleDecrease: 'Throttle down',
  warpIncrease: 'Warp up',
  warpDecrease: 'Warp down',
  pitchUp: 'Pitch up',
  pitchDown: 'Pitch down',
  yawLeft: 'Yaw left',
  yawRight: 'Yaw right',
  rollLeft: 'Roll left',
  rollRight: 'Roll right',
  attitudeManual: 'Manual attitude',
  attitudePrograde: 'Prograde hold',
  attitudeRetrograde: 'Retrograde hold',
});

function simplify(result: SessionActionResult): PanelActionResult {
  return { ok: result.ok, message: result.message };
}

function isQualityLock(value: string): value is QualityLock {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high';
}

/** Builds the event-driven panel behavior independently from Preact and browser files. */
export function createSessionSettingsModel(
  session: SessionSettingsPort,
  files: SessionFilePort,
): SessionSettingsModel {
  return {
    save: () => simplify(session.saveLocal()),
    load: () => simplify(session.loadLocal()),
    exportFile: () => {
      const result = session.exportJson();
      if (!result.ok) return { ok: false, message: result.message };
      try {
        files.saveJson('solar-voyager-save.json', result.json);
        return { ok: true, message: 'Session exported' };
      } catch {
        return { ok: false, message: 'Unable to export session' };
      }
    },
    importFile: async (file) => {
      if (file === null) return null;
      try {
        return simplify(session.importJson(await files.readText(file)));
      } catch {
        return { ok: false, message: 'Unable to read imported session' };
      }
    },
    selectQuality: (value) =>
      isQualityLock(value)
        ? simplify(session.updateQualityLock(value))
        : { ok: false, message: 'Unsupported quality setting' },
    captureBinding: (action, code) => simplify(session.rebind(action, code)),
  };
}

export const browserSessionFilePort: SessionFilePort = Object.freeze({
  readText: async (file: File) => file.text(),
  saveJson: (filename: string, json: string) => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    try {
      const link = document.createElement('a');
      link.download = filename;
      link.href = url;
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  },
});

export interface SessionSettingsPanelProps {
  readonly session: SessionSettingsPort;
  readonly files?: SessionFilePort;
}

/** Renders explicit session persistence, quality lock, and key rebinding controls. */
export function SessionSettingsPanel({
  session,
  files = browserSessionFilePort,
}: SessionSettingsPanelProps) {
  const model = useMemo(() => createSessionSettingsModel(session, files), [session, files]);
  const [settings, setSettings] = useState(session.settings);
  const [status, setStatus] = useState<PanelActionResult | null>(
    session.initializationWarning === null
      ? null
      : { ok: false, message: session.initializationWarning },
  );
  const [capturingAction, setCapturingAction] = useState<InputAction | null>(null);

  const publish = (result: PanelActionResult): void => {
    setStatus(result);
    setSettings(session.settings);
  };

  return (
    <details id="session-settings" class="session-settings">
      <summary>Session &amp; settings</summary>
      <div class="session-settings-content">
        <section aria-labelledby="session-actions-title">
          <h2 id="session-actions-title">Session</h2>
          <div class="session-action-grid">
            <button id="session-save" type="button" onClick={() => publish(model.save())}>
              Save session
            </button>
            <button id="session-load" type="button" onClick={() => publish(model.load())}>
              Load session
            </button>
            <button id="session-export" type="button" onClick={() => publish(model.exportFile())}>
              Export JSON
            </button>
            <label class="session-import-label" for="session-import-input">
              Import JSON
              <input
                id="session-import-input"
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0] ?? null;
                  void model.importFile(file).then((result) => {
                    if (result !== null) publish(result);
                    input.value = '';
                  });
                }}
              />
            </label>
          </div>
        </section>

        <section aria-labelledby="quality-settings-title">
          <h2 id="quality-settings-title">Quality</h2>
          <label class="quality-lock-label" for="quality-lock">
            Governor lock
            <select
              id="quality-lock"
              value={settings.qualityLock}
              onChange={(event) => publish(model.selectQuality(event.currentTarget.value))}
            >
              <option value="auto">Auto</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </section>

        <section aria-labelledby="input-bindings-title">
          <h2 id="input-bindings-title">Keyboard</h2>
          <div class="binding-grid">
            {INPUT_ACTIONS.map((action) => {
              const label = INPUT_ACTION_LABELS[action];
              const capturing = capturingAction === action;
              return (
                <button
                  key={action}
                  type="button"
                  class="binding-button"
                  aria-label={
                    capturing
                      ? `Press a key for ${label}`
                      : `${label}: ${settings.inputBindings[action]}`
                  }
                  onClick={() => setCapturingAction(action)}
                  onKeyDown={(event) => {
                    if (!capturing) return;
                    event.preventDefault();
                    event.stopPropagation();
                    publish(model.captureBinding(action, event.code));
                    setCapturingAction(null);
                  }}
                >
                  <span>{label}</span>
                  <kbd>{capturing ? 'Press key' : settings.inputBindings[action]}</kbd>
                </button>
              );
            })}
          </div>
        </section>

        <p
          id="session-status"
          class={status?.ok === false ? 'session-status session-status-error' : 'session-status'}
          aria-live="polite"
        >
          {status?.message ?? 'Ready'}
        </p>
      </div>
    </details>
  );
}
