import { useMemo, useState } from 'preact/hooks';

import type { SessionActionResult, SessionExportResult } from '../game/sessionController.js';
import type { TutorialController } from '../game/tutorialController.js';
import { formatHudPreset, HUD_PRESETS, type HudPreset } from '../game/hud/hudPresets.js';
import {
  GAMEPAD_AXES,
  GAMEPAD_CURVE_EXPONENT_MAX,
  GAMEPAD_CURVE_EXPONENT_MIN,
  GAMEPAD_DEADZONE_MAX,
  GAMEPAD_DEADZONE_MIN,
  GAMEPAD_SENSITIVITY_MAX,
  GAMEPAD_SENSITIVITY_MIN,
  INPUT_ACTIONS,
  isUnboundInputCode,
  type ExposureMode,
  type GamepadAxisId,
  type GameSettingsV6,
  type InputAction,
  type QualityLock,
} from '../game/settings.js';

export interface SessionSettingsPort {
  readonly initializationWarning: string | null;
  readonly settings: GameSettingsV6;
  exportJson(): SessionExportResult;
  importJson(json: string): SessionActionResult;
  loadLocal(): SessionActionResult;
  rebind(action: InputAction, code: string): SessionActionResult;
  saveLocal(): SessionActionResult;
  setGamepadAxisInvert(axis: GamepadAxisId, invert: boolean): SessionActionResult;
  setGamepadAxisSensitivity(axis: GamepadAxisId, sensitivity: number): SessionActionResult;
  setGamepadCurveExponent(curveExponent: number): SessionActionResult;
  setGamepadDeadzone(deadzone: number): SessionActionResult;
  setCameraFovWidening(fovWidening: boolean): SessionActionResult;
  setCameraShake(shake: boolean): SessionActionResult;
  setExposureMode(exposureMode: ExposureMode): SessionActionResult;
  setHudPreset(preset: HudPreset): SessionActionResult;
  setHudBodyLabels(bodyLabels: boolean): SessionActionResult;
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
  selectGamepadDeadzone(value: string): PanelActionResult;
  selectGamepadCurveExponent(value: string): PanelActionResult;
  setGamepadAxisInvert(axis: GamepadAxisId, invert: boolean): PanelActionResult;
  selectGamepadAxisSensitivity(axis: GamepadAxisId, value: string): PanelActionResult;
  setCameraFovWidening(fovWidening: boolean): PanelActionResult;
  setCameraShake(shake: boolean): PanelActionResult;
  selectExposureMode(value: string): PanelActionResult;
  selectHudPreset(value: string): PanelActionResult;
  setHudBodyLabels(bodyLabels: boolean): PanelActionResult;
}

export type SessionActivationCallback = (result: SessionActionResult) => void;
export type SessionActivationGuard = (action: () => SessionActionResult) => SessionActionResult;

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
  attitudeNormal: 'Normal hold',
  attitudeAntinormal: 'Anti-normal hold',
  attitudeRadialOut: 'Radial-out hold',
  attitudeRadialIn: 'Radial-in hold',
  attitudeTarget: 'Target hold',
  killRotation: 'Kill rotation',
  stabilityAssistToggle: 'Stability assist',
  // Registered in the bindings registry for the gamepad A/B defaults (T0106);
  // CruiseDirector (T0116) is what makes pressing either key do something.
  cruiseEngage: 'Cruise engage (reserved)',
  cruiseAbort: 'Cruise abort (reserved)',
  hudPresetCycle: 'Cycle HUD preset',
  hudBodyLabelsToggle: 'Toggle body labels',
});

const GAMEPAD_AXIS_LABELS: Readonly<Record<GamepadAxisId, string>> = Object.freeze({
  pitch: 'Pitch',
  yaw: 'Yaw',
  roll: 'Roll',
  throttle: 'Throttle',
});

const UNBOUND_BINDING_LABEL = 'Unbound';

/** Renders the append-safe placeholder an unbindable action carries as plain text. */
function describeBinding(code: string): string {
  return isUnboundInputCode(code) ? UNBOUND_BINDING_LABEL : code;
}

function simplify(result: SessionActionResult): PanelActionResult {
  return { ok: result.ok, message: result.message };
}

function isHudPresetValue(value: string): value is HudPreset {
  return (HUD_PRESETS as readonly string[]).includes(value);
}

function isExposureMode(value: string): value is ExposureMode {
  return value === 'auto' || value === 'fixed';
}

function isQualityLock(value: string): value is QualityLock {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high';
}

/** `<input type="number">.value` is always a string, including "" and non-numeric text. */
function parseFiniteNumber(value: string): number | null {
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isFinite(parsed) ? parsed : null;
}

/** Builds the event-driven panel behavior independently from Preact and browser files. */
export function createSessionSettingsModel(
  session: SessionSettingsPort,
  files: SessionFilePort,
  onSessionActivated: SessionActivationCallback | null = null,
  activationGuard: SessionActivationGuard | null = null,
  onSaveSucceeded: (() => void) | null = null,
): SessionSettingsModel {
  const activate = (action: () => SessionActionResult): PanelActionResult => {
    const result = activationGuard === null ? action() : activationGuard(action);
    if (result.ok) onSessionActivated?.(result);
    return simplify(result);
  };
  return {
    save: () => {
      const result = session.saveLocal();
      if (result.ok) onSaveSucceeded?.();
      return simplify(result);
    },
    load: () => activate(() => session.loadLocal()),
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
        const json = await files.readText(file);
        return activate(() => session.importJson(json));
      } catch {
        return { ok: false, message: 'Unable to read imported session' };
      }
    },
    selectQuality: (value) =>
      isQualityLock(value)
        ? simplify(session.updateQualityLock(value))
        : { ok: false, message: 'Unsupported quality setting' },
    captureBinding: (action, code) => simplify(session.rebind(action, code)),
    selectGamepadDeadzone: (value) => {
      const deadzone = parseFiniteNumber(value);
      return deadzone === null
        ? { ok: false, message: 'Unsupported gamepad deadzone' }
        : simplify(session.setGamepadDeadzone(deadzone));
    },
    selectGamepadCurveExponent: (value) => {
      const curveExponent = parseFiniteNumber(value);
      return curveExponent === null
        ? { ok: false, message: 'Unsupported gamepad response curve' }
        : simplify(session.setGamepadCurveExponent(curveExponent));
    },
    setGamepadAxisInvert: (axis, invert) => simplify(session.setGamepadAxisInvert(axis, invert)),
    selectGamepadAxisSensitivity: (axis, value) => {
      const sensitivity = parseFiniteNumber(value);
      return sensitivity === null
        ? { ok: false, message: 'Unsupported gamepad sensitivity' }
        : simplify(session.setGamepadAxisSensitivity(axis, sensitivity));
    },
    setCameraFovWidening: (fovWidening) => simplify(session.setCameraFovWidening(fovWidening)),
    setCameraShake: (shake) => simplify(session.setCameraShake(shake)),
    selectExposureMode: (value) =>
      isExposureMode(value)
        ? simplify(session.setExposureMode(value))
        : { ok: false, message: 'Unsupported exposure mode' },
    selectHudPreset: (value) =>
      isHudPresetValue(value)
        ? simplify(session.setHudPreset(value))
        : { ok: false, message: 'Unsupported HUD preset' },
    setHudBodyLabels: (bodyLabels) => simplify(session.setHudBodyLabels(bodyLabels)),
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
  readonly activationGuard?: SessionActivationGuard | null;
  readonly onSessionActivated?: SessionActivationCallback | null;
  readonly onSaveSucceeded?: (() => void) | null;
  readonly tutorial?: TutorialController | null;
}

/** Renders explicit session persistence, quality lock, and key rebinding controls. */
export function SessionSettingsPanel({
  session,
  files = browserSessionFilePort,
  activationGuard = null,
  onSessionActivated = null,
  onSaveSucceeded = null,
  tutorial = null,
}: SessionSettingsPanelProps) {
  const model = useMemo(
    () =>
      createSessionSettingsModel(
        session,
        files,
        onSessionActivated,
        activationGuard,
        onSaveSucceeded,
      ),
    [session, files, onSessionActivated, activationGuard, onSaveSucceeded],
  );
  const [settings, setSettings] = useState(session.settings);
  const [status, setStatus] = useState<PanelActionResult | null>(
    session.initializationWarning === null
      ? null
      : { ok: false, message: session.initializationWarning },
  );
  const [capturingAction, setCapturingAction] = useState<InputAction | null>(null);
  const tutorialProgress = tutorial?.progress ?? null;

  const publish = (result: PanelActionResult): void => {
    setStatus(result);
    setSettings(session.settings);
  };

  return (
    <details id="session-settings" class="session-settings">
      <summary>Session &amp; settings</summary>
      <div class="session-settings-content">
        {tutorial === null || tutorialProgress === null ? null : (
          <section aria-labelledby="tutorial-settings-title">
            <h2 id="tutorial-settings-title">Tutorial</h2>
            <p class="session-status">
              Status: <strong>{tutorialProgress.status}</strong>
            </p>
            <div class="session-action-grid">
              <button
                type="button"
                disabled={tutorialProgress.status !== 'skipped'}
                onClick={() => tutorial.resume()}
              >
                Resume tutorial
              </button>
              <button type="button" onClick={() => tutorial.reset()}>
                Reset tutorial
              </button>
            </div>
          </section>
        )}
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

        <section aria-labelledby="exposure-settings-title">
          <h2 id="exposure-settings-title">Exposure</h2>
          <p class="quality-lock-hint">
            Adaptive exposure follows the light where you actually are, so Neptune reads as daylight
            and the Sun stays unclipped up close. Fixed holds one exposure everywhere. The quality
            governor pins Fixed on its lowest tier.
          </p>
          <label class="quality-lock-label" for="exposure-mode">
            Mode
            <select
              id="exposure-mode"
              value={settings.render.exposureMode}
              onChange={(event) => publish(model.selectExposureMode(event.currentTarget.value))}
            >
              <option value="auto">Adaptive</option>
              <option value="fixed">Fixed</option>
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
                      : `${label}: ${describeBinding(settings.inputBindings[action])}`
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
                  <kbd>
                    {capturing ? 'Press key' : describeBinding(settings.inputBindings[action])}
                  </kbd>
                </button>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="gamepad-settings-title">
          <h2 id="gamepad-settings-title">Gamepad</h2>
          <p class="gamepad-settings-hint">
            Standard-mapping default: left stick pitch/yaw, right stick X roll, triggers throttle. A
            and B are reserved for the cruise system and do nothing yet.
          </p>
          <div class="gamepad-shaping-grid">
            <label for="gamepad-deadzone">
              Deadzone
              <input
                id="gamepad-deadzone"
                type="number"
                min={GAMEPAD_DEADZONE_MIN}
                max={GAMEPAD_DEADZONE_MAX}
                step="0.01"
                value={settings.gamepad.deadzone}
                onChange={(event) =>
                  publish(model.selectGamepadDeadzone(event.currentTarget.value))
                }
              />
            </label>
            <label for="gamepad-curve-exponent">
              Response curve
              <input
                id="gamepad-curve-exponent"
                type="number"
                min={GAMEPAD_CURVE_EXPONENT_MIN}
                max={GAMEPAD_CURVE_EXPONENT_MAX}
                step="0.1"
                value={settings.gamepad.curveExponent}
                onChange={(event) =>
                  publish(model.selectGamepadCurveExponent(event.currentTarget.value))
                }
              />
            </label>
          </div>
          <div class="gamepad-axis-grid">
            {GAMEPAD_AXES.map((axis) => {
              const axisSettings = settings.gamepad.axes[axis];
              return (
                <div key={axis} class="gamepad-axis-row">
                  <span class="gamepad-axis-label">{GAMEPAD_AXIS_LABELS[axis]}</span>
                  <label for={`gamepad-axis-${axis}-invert`}>
                    <input
                      id={`gamepad-axis-${axis}-invert`}
                      type="checkbox"
                      checked={axisSettings.invert}
                      onChange={(event) =>
                        publish(model.setGamepadAxisInvert(axis, event.currentTarget.checked))
                      }
                    />
                    Invert
                  </label>
                  <label for={`gamepad-axis-${axis}-sensitivity`}>
                    Sensitivity
                    <input
                      id={`gamepad-axis-${axis}-sensitivity`}
                      type="number"
                      min={GAMEPAD_SENSITIVITY_MIN}
                      max={GAMEPAD_SENSITIVITY_MAX}
                      step="0.1"
                      value={axisSettings.sensitivity}
                      onChange={(event) =>
                        publish(model.selectGamepadAxisSensitivity(axis, event.currentTarget.value))
                      }
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="hud-settings-title">
          <h2 id="hud-settings-title">HUD</h2>
          <p class="hud-settings-hint">
            Clean keeps the reticle, the throttle strip and warnings. Pilot adds the navball, the
            clocks and the warp indicator. Engineer restores every mission-control panel. Cycle in
            flight with the HUD preset key.
          </p>
          <div class="hud-settings-grid">
            <label class="quality-lock-label" for="hud-preset">
              Preset
              <select
                id="hud-preset"
                value={settings.hud.preset}
                onChange={(event) => publish(model.selectHudPreset(event.currentTarget.value))}
              >
                {HUD_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {formatHudPreset(preset)}
                  </option>
                ))}
              </select>
            </label>
            <label for="hud-body-labels">
              <input
                id="hud-body-labels"
                type="checkbox"
                checked={settings.hud.bodyLabels}
                onChange={(event) => publish(model.setHudBodyLabels(event.currentTarget.checked))}
              />
              Show body labels in the world
            </label>
          </div>
        </section>

        <section aria-labelledby="camera-settings-title">
          <h2 id="camera-settings-title">Camera</h2>
          <p class="camera-settings-hint">
            The chase camera opens its field of view under thrust and vibrates under heavy
            acceleration. Both are deliberately subtle; turn them off here if motion is
            uncomfortable.
          </p>
          <div class="camera-settings-grid">
            <label for="camera-fov-widening">
              <input
                id="camera-fov-widening"
                type="checkbox"
                checked={settings.camera.fovWidening}
                onChange={(event) =>
                  publish(model.setCameraFovWidening(event.currentTarget.checked))
                }
              />
              Widen field of view with throttle
            </label>
            <label for="camera-shake">
              <input
                id="camera-shake"
                type="checkbox"
                checked={settings.camera.shake}
                onChange={(event) => publish(model.setCameraShake(event.currentTarget.checked))}
              />
              Shake under high acceleration
            </label>
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
