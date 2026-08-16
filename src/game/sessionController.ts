import type { SimulationCore } from '../sim/simulation.js';
import type { SimulationPersistentState } from '../sim/simulationState.js';
import {
  createSaveEnvelope,
  type SaveEnvelopeV3,
  type SaveRepository,
  serializeSaveEnvelope,
} from './saveLoad.js';
import {
  mergeGameSettingsPreferences,
  parseProfileSettings,
  projectGameSettingsV1,
  rebindInput,
  updateCameraFovWidening,
  updateCameraShake,
  updateGamepadAxisInvert,
  updateGamepadAxisSensitivity,
  updateGamepadCurveExponent,
  updateGamepadDeadzone,
  updateHudBodyLabels,
  updateHudPreset,
  updateHudSettings,
  updateRenderExposureMode,
  updateTutorialSettings,
  type ExposureMode,
  type GamepadAxisId,
  type GameSettingsV6,
  type HudPreset,
  type InputAction,
  type QualityLock,
  type SettingsRepository,
  type TutorialProgress,
} from './settings.js';

export type SessionActionResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string; readonly detail?: string };

export type SessionExportResult =
  { readonly ok: true; readonly json: string } | { readonly ok: false; readonly message: string };

export type SettingsChangeOrigin = 'restore' | 'user';

/**
 * Why the simulation core was replaced.
 *
 * The distinction that matters to consumers is **timeline change vs recovery**:
 * `new-game`, `load` and `import` start a mission the previous core knows
 * nothing about, while `restore` and `respawn` (ADR-036) move within the mission
 * already in progress. State keyed to the timeline — the restore-point ring
 * above all — must survive the second kind.
 */
export type SimulationReplacementOrigin = 'new-game' | 'load' | 'import' | 'restore' | 'respawn';

export interface GameSessionControllerOptions {
  readonly initialSimulation: SimulationCore;
  readonly saveRepository: SaveRepository;
  readonly settingsRepository: SettingsRepository;
  readonly createNewSimulation: () => SimulationCore;
  readonly createSimulation: (state: SimulationPersistentState) => SimulationCore;
  /**
   * ADR-036 — builds the respawn document for a body index. Injected rather than
   * imported so the controller keeps knowing nothing about the body catalog.
   */
  readonly createRespawnState?: (
    source: SimulationPersistentState,
    shipPositionKm: Float64Array,
    bodyIndex: number,
  ) => SimulationPersistentState;
  readonly onSimulationReplaced?: (
    simulation: SimulationCore,
    origin: SimulationReplacementOrigin,
  ) => void;
  readonly onSettingsChanged?: (settings: GameSettingsV6, origin: SettingsChangeOrigin) => void;
}

/** Coordinates atomic simulation replacement and persisted user settings. */
export class GameSessionController {
  private currentSimulation: SimulationCore;
  private currentSettings: GameSettingsV6;
  private readonly settingsInitializationWarning: string | null;
  private readonly saveRepository: SaveRepository;
  private readonly settingsRepository: SettingsRepository;
  private readonly createNewSimulation: () => SimulationCore;
  private readonly createSimulation: (state: SimulationPersistentState) => SimulationCore;
  private readonly createRespawnState:
    | ((
        source: SimulationPersistentState,
        shipPositionKm: Float64Array,
        bodyIndex: number,
      ) => SimulationPersistentState)
    | null;

  private readonly onSimulationReplaced:
    ((simulation: SimulationCore, origin: SimulationReplacementOrigin) => void) | null;
  private readonly onSettingsChanged:
    ((settings: GameSettingsV6, origin: SettingsChangeOrigin) => void) | null;

  constructor(options: GameSessionControllerOptions) {
    this.currentSimulation = options.initialSimulation;
    this.saveRepository = options.saveRepository;
    this.settingsRepository = options.settingsRepository;
    this.createNewSimulation = options.createNewSimulation;
    this.createSimulation = options.createSimulation;
    this.createRespawnState = options.createRespawnState ?? null;
    this.onSimulationReplaced = options.onSimulationReplaced ?? null;
    this.onSettingsChanged = options.onSettingsChanged ?? null;
    const settingsResult = this.settingsRepository.load();
    this.currentSettings = settingsResult.settings;
    this.settingsInitializationWarning = settingsResult.ok ? null : settingsResult.error;
  }

  get simulation(): SimulationCore {
    return this.currentSimulation;
  }

  get settings(): GameSettingsV6 {
    return this.currentSettings;
  }

  get initializationWarning(): string | null {
    return this.settingsInitializationWarning;
  }

  startNewGame(): SessionActionResult {
    let candidateSimulation: SimulationCore;
    try {
      candidateSimulation = this.createNewSimulation();
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to start new game',
        detail: describeError(error),
      };
    }
    this.replaceSimulation(candidateSimulation, 'new-game');
    return { ok: true, message: 'New game started' };
  }

  /**
   * ADR-036 — replaces the frozen core with a captured restore point.
   *
   * Routed through the same `createSimulation` the save loader uses, so a
   * restore point is validated by exactly the rules a loaded save must satisfy;
   * a slot that fails validation leaves the freeze in place rather than
   * producing a half-restored session.
   */
  restoreFromState(state: SimulationPersistentState): SessionActionResult {
    let candidateSimulation: SimulationCore;
    try {
      candidateSimulation = this.createSimulation(state);
    } catch (error: unknown) {
      return { ok: false, message: 'Unable to restore', detail: describeError(error) };
    }
    this.replaceSimulation(candidateSimulation, 'restore');
    return { ok: true, message: 'Restored' };
  }

  /**
   * ADR-036 — relocates the ship to a circular orbit two body radii up.
   *
   * Defaults to the body that was hit; falls back to the dominant body so the
   * action still works if it is ever offered outside a freeze.
   */
  respawnInOrbit(bodyIndex?: number): SessionActionResult {
    if (this.createRespawnState === null) {
      return { ok: false, message: 'Unable to respawn', detail: 'no respawn builder configured' };
    }
    const snapshot = this.currentSimulation.snapshot;
    const selectedBodyIndex =
      bodyIndex ??
      (snapshot.impactBodyIndex >= 0 ? snapshot.impactBodyIndex : snapshot.dominantBodyIndex);
    if (selectedBodyIndex < 0) {
      return { ok: false, message: 'Unable to respawn', detail: 'no body to orbit' };
    }
    let candidateSimulation: SimulationCore;
    try {
      const source = this.currentSimulation.exportPersistentState();
      candidateSimulation = this.createSimulation(
        this.createRespawnState(source, snapshot.shipState, selectedBodyIndex),
      );
    } catch (error: unknown) {
      return { ok: false, message: 'Unable to respawn', detail: describeError(error) };
    }
    this.replaceSimulation(candidateSimulation, 'respawn');
    return { ok: true, message: 'Respawned in orbit' };
  }

  hasValidLocalSave(): boolean {
    try {
      return this.saveRepository.load(this.currentSimulation.snapshot.bodyIds).ok;
    } catch {
      return false;
    }
  }

  saveLocal(): SessionActionResult {
    try {
      const envelope = this.createCurrentEnvelope();
      const result = this.saveRepository.save(envelope);
      return result.ok
        ? { ok: true, message: 'Session saved' }
        : { ok: false, message: 'Unable to save session', detail: result.error };
    } catch (error: unknown) {
      return { ok: false, message: 'Unable to save session', detail: describeError(error) };
    }
  }

  loadLocal(): SessionActionResult {
    const result = this.saveRepository.load(this.currentSimulation.snapshot.bodyIds);
    if (!result.ok) {
      if (result.reason === 'not-found') return { ok: false, message: 'No local save found' };
      return {
        ok: false,
        message:
          result.reason === 'invalid' ? 'Saved session is invalid' : 'Unable to read saved session',
        detail: result.error,
      };
    }
    return this.replaceFromEnvelope(
      result.envelope,
      'Session loaded',
      'Unable to load session',
      'load',
    );
  }

  exportJson(): SessionExportResult {
    try {
      return { ok: true, json: serializeSaveEnvelope(this.createCurrentEnvelope()) };
    } catch (error: unknown) {
      return { ok: false, message: `Unable to export session: ${describeError(error)}` };
    }
  }

  importJson(json: string): SessionActionResult {
    let envelope: SaveEnvelopeV3;
    try {
      envelope = this.saveRepository.parse(json, this.currentSimulation.snapshot.bodyIds);
    } catch (error: unknown) {
      return { ok: false, message: 'Imported session is invalid', detail: describeError(error) };
    }
    return this.replaceFromEnvelope(
      envelope,
      'Session imported',
      'Unable to import session',
      'import',
    );
  }

  updateQualityLock(qualityLock: QualityLock): SessionActionResult {
    try {
      const candidate = parseProfileSettings({ ...this.currentSettings, qualityLock });
      return this.commitSettings(candidate, 'Quality setting updated');
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update quality setting',
        detail: describeError(error),
      };
    }
  }

  rebind(action: InputAction, code: string): SessionActionResult {
    try {
      const candidate = rebindInput(this.currentSettings, action, code);
      return this.commitSettings(candidate, 'Input binding updated');
    } catch (error: unknown) {
      return { ok: false, message: 'Unable to update input binding', detail: describeError(error) };
    }
  }

  // Named distinctly from the `settings.ts` builders they call (`set*` here
  // vs `update*` there), the same way `rebind`/`rebindInput` already are —
  // a class method and a same-named free function would still resolve
  // correctly (methods are not bare identifiers), but distinct names read
  // unambiguously instead of relying on that scoping rule.
  setGamepadDeadzone(deadzone: number): SessionActionResult {
    try {
      const candidate = updateGamepadDeadzone(this.currentSettings, deadzone);
      return this.commitSettings(candidate, 'Gamepad deadzone updated');
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update gamepad deadzone',
        detail: describeError(error),
      };
    }
  }

  setGamepadCurveExponent(curveExponent: number): SessionActionResult {
    try {
      const candidate = updateGamepadCurveExponent(this.currentSettings, curveExponent);
      return this.commitSettings(candidate, 'Gamepad response curve updated');
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update gamepad response curve',
        detail: describeError(error),
      };
    }
  }

  setGamepadAxisInvert(axis: GamepadAxisId, invert: boolean): SessionActionResult {
    try {
      const candidate = updateGamepadAxisInvert(this.currentSettings, axis, invert);
      return this.commitSettings(candidate, 'Gamepad axis invert updated');
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update gamepad axis invert',
        detail: describeError(error),
      };
    }
  }

  setGamepadAxisSensitivity(axis: GamepadAxisId, sensitivity: number): SessionActionResult {
    try {
      const candidate = updateGamepadAxisSensitivity(this.currentSettings, axis, sensitivity);
      return this.commitSettings(candidate, 'Gamepad axis sensitivity updated');
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update gamepad axis sensitivity',
        detail: describeError(error),
      };
    }
  }

  /** T0110 — chase field-of-view widening on or off. */
  setCameraFovWidening(fovWidening: boolean): SessionActionResult {
    try {
      const candidate = updateCameraFovWidening(this.currentSettings, fovWidening);
      return this.commitSettings(candidate, 'Camera field of view updated');
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update camera field of view',
        detail: describeError(error),
      };
    }
  }

  /** T0110 — chase camera shake on or off. */
  setCameraShake(shake: boolean): SessionActionResult {
    try {
      const candidate = updateCameraShake(this.currentSettings, shake);
      return this.commitSettings(candidate, 'Camera shake updated');
    } catch (error: unknown) {
      return { ok: false, message: 'Unable to update camera shake', detail: describeError(error) };
    }
  }

  /** T0112 — HUD preset ring position, persisted in the profile. */
  setHudPreset(preset: HudPreset): SessionActionResult {
    try {
      const candidate = updateHudPreset(this.currentSettings, preset);
      return this.commitSettings(candidate, 'HUD preset updated');
    } catch (error: unknown) {
      return { ok: false, message: 'Unable to update HUD preset', detail: describeError(error) };
    }
  }

  /**
   * T0112 — both HUD preferences in one commit.
   *
   * The path the preset key and the label key take. Two separate commits would
   * round-trip the first one's `onSettingsChanged` through the live store and
   * undo the second; see `updateHudSettings`.
   */
  setHudPreferences(preset: HudPreset, bodyLabels: boolean): SessionActionResult {
    try {
      const candidate = updateHudSettings(this.currentSettings, preset, bodyLabels);
      return this.commitSettings(candidate, 'HUD preferences updated');
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update HUD preferences',
        detail: describeError(error),
      };
    }
  }

  /** T0112 — in-world body labels on or off. */
  setHudBodyLabels(bodyLabels: boolean): SessionActionResult {
    try {
      const candidate = updateHudBodyLabels(this.currentSettings, bodyLabels);
      return this.commitSettings(candidate, 'Body labels updated');
    } catch (error: unknown) {
      return { ok: false, message: 'Unable to update body labels', detail: describeError(error) };
    }
  }

  /** T0127 — adaptive or fixed exposure, persisted in the profile. */
  setExposureMode(exposureMode: ExposureMode): SessionActionResult {
    try {
      const candidate = updateRenderExposureMode(this.currentSettings, exposureMode);
      return this.commitSettings(candidate, 'Exposure mode updated');
    } catch (error: unknown) {
      return { ok: false, message: 'Unable to update exposure mode', detail: describeError(error) };
    }
  }

  updateTutorial(transition: (current: TutorialProgress) => TutorialProgress): SessionActionResult {
    try {
      const candidate = updateTutorialSettings(
        this.currentSettings,
        transition(this.currentSettings.tutorial),
      );
      return this.commitSettings(candidate, 'Tutorial progress updated', false);
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update tutorial progress',
        detail: describeError(error),
      };
    }
  }

  private createCurrentEnvelope(): SaveEnvelopeV3 {
    return createSaveEnvelope(
      this.currentSimulation.exportPersistentState(),
      projectGameSettingsV1(this.currentSettings),
      this.currentSimulation.snapshot.bodyIds,
    );
  }

  private replaceFromEnvelope(
    envelope: SaveEnvelopeV3,
    successMessage: string,
    failureMessage: string,
    origin: SimulationReplacementOrigin,
  ): SessionActionResult {
    let candidateSimulation: SimulationCore;
    try {
      candidateSimulation = this.createSimulation(envelope.simulation);
    } catch (error: unknown) {
      return { ok: false, message: failureMessage, detail: describeError(error) };
    }
    const candidateSettings = mergeGameSettingsPreferences(this.currentSettings, envelope.settings);
    const settingsResult = this.settingsRepository.save(candidateSettings);
    if (!settingsResult.ok) {
      return { ok: false, message: failureMessage, detail: settingsResult.error };
    }
    this.currentSimulation = candidateSimulation;
    this.currentSettings = candidateSettings;
    this.onSimulationReplaced?.(candidateSimulation, origin);
    this.onSettingsChanged?.(candidateSettings, 'restore');
    return { ok: true, message: successMessage };
  }

  private replaceSimulation(simulation: SimulationCore, origin: SimulationReplacementOrigin): void {
    this.currentSimulation = simulation;
    this.onSimulationReplaced?.(simulation, origin);
  }

  private commitSettings(
    settings: GameSettingsV6,
    successMessage: string,
    publish = true,
  ): SessionActionResult {
    const result = this.settingsRepository.save(settings);
    if (!result.ok) {
      return { ok: false, message: 'Unable to save settings', detail: result.error };
    }
    this.currentSettings = settings;
    if (publish) this.onSettingsChanged?.(settings, 'user');
    return { ok: true, message: successMessage };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
