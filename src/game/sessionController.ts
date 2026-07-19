import type { SimulationCore } from '../sim/simulation.js';
import type { SimulationPersistentState } from '../sim/simulationState.js';
import {
  createSaveEnvelope,
  type SaveEnvelopeV2,
  type SaveRepository,
  serializeSaveEnvelope,
} from './saveLoad.js';
import {
  mergeGameSettingsPreferences,
  parseProfileSettings,
  projectGameSettingsV1,
  rebindInput,
  updateTutorialSettings,
  type GameSettingsV2,
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

export interface GameSessionControllerOptions {
  readonly initialSimulation: SimulationCore;
  readonly saveRepository: SaveRepository;
  readonly settingsRepository: SettingsRepository;
  readonly createNewSimulation: () => SimulationCore;
  readonly createSimulation: (state: SimulationPersistentState) => SimulationCore;
  readonly onSimulationReplaced?: (simulation: SimulationCore) => void;
  readonly onSettingsChanged?: (settings: GameSettingsV2, origin: SettingsChangeOrigin) => void;
}

/** Coordinates atomic simulation replacement and persisted user settings. */
export class GameSessionController {
  private currentSimulation: SimulationCore;
  private currentSettings: GameSettingsV2;
  private readonly settingsInitializationWarning: string | null;
  private readonly saveRepository: SaveRepository;
  private readonly settingsRepository: SettingsRepository;
  private readonly createNewSimulation: () => SimulationCore;
  private readonly createSimulation: (state: SimulationPersistentState) => SimulationCore;
  private readonly onSimulationReplaced: ((simulation: SimulationCore) => void) | null;
  private readonly onSettingsChanged:
    ((settings: GameSettingsV2, origin: SettingsChangeOrigin) => void) | null;

  constructor(options: GameSessionControllerOptions) {
    this.currentSimulation = options.initialSimulation;
    this.saveRepository = options.saveRepository;
    this.settingsRepository = options.settingsRepository;
    this.createNewSimulation = options.createNewSimulation;
    this.createSimulation = options.createSimulation;
    this.onSimulationReplaced = options.onSimulationReplaced ?? null;
    this.onSettingsChanged = options.onSettingsChanged ?? null;
    const settingsResult = this.settingsRepository.load();
    this.currentSettings = settingsResult.settings;
    this.settingsInitializationWarning = settingsResult.ok ? null : settingsResult.error;
  }

  get simulation(): SimulationCore {
    return this.currentSimulation;
  }

  get settings(): GameSettingsV2 {
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
    this.replaceSimulation(candidateSimulation);
    return { ok: true, message: 'New game started' };
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
    return this.replaceFromEnvelope(result.envelope, 'Session loaded', 'Unable to load session');
  }

  exportJson(): SessionExportResult {
    try {
      return { ok: true, json: serializeSaveEnvelope(this.createCurrentEnvelope()) };
    } catch (error: unknown) {
      return { ok: false, message: `Unable to export session: ${describeError(error)}` };
    }
  }

  importJson(json: string): SessionActionResult {
    let envelope: SaveEnvelopeV2;
    try {
      envelope = this.saveRepository.parse(json, this.currentSimulation.snapshot.bodyIds);
    } catch (error: unknown) {
      return { ok: false, message: 'Imported session is invalid', detail: describeError(error) };
    }
    return this.replaceFromEnvelope(envelope, 'Session imported', 'Unable to import session');
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

  updateTutorial(transition: (current: TutorialProgress) => TutorialProgress): SessionActionResult {
    try {
      const candidate = updateTutorialSettings(
        this.currentSettings,
        transition(this.currentSettings.tutorial),
      );
      return this.commitSettings(candidate, 'Tutorial progress updated');
    } catch (error: unknown) {
      return {
        ok: false,
        message: 'Unable to update tutorial progress',
        detail: describeError(error),
      };
    }
  }

  private createCurrentEnvelope(): SaveEnvelopeV2 {
    return createSaveEnvelope(
      this.currentSimulation.exportPersistentState(),
      projectGameSettingsV1(this.currentSettings),
      this.currentSimulation.snapshot.bodyIds,
    );
  }

  private replaceFromEnvelope(
    envelope: SaveEnvelopeV2,
    successMessage: string,
    failureMessage: string,
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
    this.onSimulationReplaced?.(candidateSimulation);
    this.onSettingsChanged?.(candidateSettings, 'restore');
    return { ok: true, message: successMessage };
  }

  private replaceSimulation(simulation: SimulationCore): void {
    this.currentSimulation = simulation;
    this.onSimulationReplaced?.(simulation);
  }

  private commitSettings(settings: GameSettingsV2, successMessage: string): SessionActionResult {
    const result = this.settingsRepository.save(settings);
    if (!result.ok) {
      return { ok: false, message: 'Unable to save settings', detail: result.error };
    }
    this.currentSettings = settings;
    this.onSettingsChanged?.(settings, 'user');
    return { ok: true, message: successMessage };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
