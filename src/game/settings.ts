export const INPUT_ACTIONS = Object.freeze([
  'throttleIncrease',
  'throttleDecrease',
  'warpIncrease',
  'warpDecrease',
  'pitchUp',
  'pitchDown',
  'yawLeft',
  'yawRight',
  'rollLeft',
  'rollRight',
  'attitudeManual',
  'attitudePrograde',
  'attitudeRetrograde',
] as const);

export const TUTORIAL_STEP_IDS = Object.freeze([
  'focus-target',
  'camera',
  'readouts',
  'attitude-thrust',
  'thrust-off',
  'warp',
  'map-open',
  'map-return',
  'burn-log',
  'performance',
  'save',
  'return-to-play',
] as const);

export type InputAction = (typeof INPUT_ACTIONS)[number];
export type InputBindings = Readonly<Record<InputAction, string>>;
export type QualityLock = 'auto' | 'low' | 'medium' | 'high';
export type TutorialStepId = (typeof TUTORIAL_STEP_IDS)[number];
export type TutorialStatus = 'unoffered' | 'active' | 'skipped' | 'completed';

/** Preferences DTO embedded in SaveEnvelopeV2. Its schema intentionally remains version 1. */
export interface GameSettingsV1 {
  readonly version: 1;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
}

export interface TutorialProgress {
  readonly status: TutorialStatus;
  readonly stepId: TutorialStepId;
}

/** Independent profile settings document stored outside save slots. */
export interface GameSettingsV2 {
  readonly version: 2;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
  readonly tutorial: TutorialProgress;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SettingsLoadResult =
  | {
      readonly ok: true;
      readonly settings: GameSettingsV2;
      readonly source: 'default' | 'stored' | 'migrated';
    }
  | {
      readonly ok: false;
      readonly settings: GameSettingsV2;
      readonly error: string;
    };

export type SettingsSaveResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export const SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v2';
export const LEGACY_SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v1';

const RESERVED_CODES = Object.freeze(
  new Set(['Escape', 'F1', 'F3', 'F5', 'F11', 'F12', 'Tab', 'MetaLeft', 'MetaRight']),
);

const DEFAULT_INPUT_BINDINGS: Record<InputAction, string> = {
  throttleIncrease: 'KeyR',
  throttleDecrease: 'KeyF',
  warpIncrease: 'Equal',
  warpDecrease: 'Minus',
  pitchUp: 'KeyW',
  pitchDown: 'KeyS',
  yawLeft: 'KeyA',
  yawRight: 'KeyD',
  rollLeft: 'KeyZ',
  rollRight: 'KeyC',
  attitudeManual: 'Digit1',
  attitudePrograde: 'Digit2',
  attitudeRetrograde: 'Digit3',
};

function freezeV1Settings(
  qualityLock: QualityLock,
  inputBindings: Record<InputAction, string>,
): GameSettingsV1 {
  return Object.freeze({
    version: 1 as const,
    qualityLock,
    inputBindings: Object.freeze(inputBindings),
  });
}

function freezeTutorial(status: TutorialStatus, stepId: TutorialStepId): TutorialProgress {
  return Object.freeze({ status, stepId });
}

function freezeV2Settings(
  qualityLock: QualityLock,
  inputBindings: Record<InputAction, string>,
  tutorial: TutorialProgress,
): GameSettingsV2 {
  return Object.freeze({
    version: 2 as const,
    qualityLock,
    inputBindings: Object.freeze(inputBindings),
    tutorial: Object.isFrozen(tutorial)
      ? tutorial
      : freezeTutorial(tutorial.status, tutorial.stepId),
  });
}

export const DEFAULT_GAME_SETTINGS = freezeV2Settings(
  'auto',
  { ...DEFAULT_INPUT_BINDINGS },
  { status: 'unoffered', stepId: 'focus-target' },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  unknownMessage: string,
): void {
  const actualKeys = Object.keys(value);
  for (let index = 0; index < actualKeys.length; index += 1) {
    const key = actualKeys[index];
    if (key !== undefined && !expectedKeys.includes(key)) {
      throw new RangeError(`${unknownMessage}: ${key}`);
    }
  }
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index];
    if (key !== undefined && !(key in value)) {
      throw new RangeError(`settings field is missing: ${key}`);
    }
  }
}

function isQualityLock(value: unknown): value is QualityLock {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high';
}

function isTutorialStatus(value: unknown): value is TutorialStatus {
  return (
    value === 'unoffered' || value === 'active' || value === 'skipped' || value === 'completed'
  );
}

function isTutorialStepId(value: unknown): value is TutorialStepId {
  return TUTORIAL_STEP_IDS.includes(value as TutorialStepId);
}

function validateCode(code: unknown, action: InputAction): string {
  if (typeof code !== 'string' || code.length === 0 || code.length > 64 || /\s/u.test(code)) {
    throw new RangeError(`input binding ${action} must be a nonempty KeyboardEvent.code`);
  }
  if (RESERVED_CODES.has(code)) throw new RangeError(`input binding ${code} is reserved`);
  return code;
}

function parseInputBindings(value: unknown): Record<InputAction, string> {
  if (!isRecord(value)) throw new RangeError('inputBindings must be an object');
  const actualKeys = Object.keys(value);
  for (let index = 0; index < actualKeys.length; index += 1) {
    const key = actualKeys[index];
    if (key !== undefined && !INPUT_ACTIONS.includes(key as InputAction)) {
      throw new RangeError(`unknown input action: ${key}`);
    }
  }
  const result = {} as Record<InputAction, string>;
  const assignedCodes = new Set<string>();
  for (let index = 0; index < INPUT_ACTIONS.length; index += 1) {
    const action = INPUT_ACTIONS[index];
    if (action === undefined) throw new RangeError('input action list is sparse');
    const code = validateCode(value[action], action);
    if (assignedCodes.has(code)) throw new RangeError(`input code ${code} is already bound`);
    assignedCodes.add(code);
    result[action] = code;
  }
  return result;
}

function parseTutorial(value: unknown): TutorialProgress {
  if (!isRecord(value)) throw new RangeError('settings tutorial must be an object');
  assertExactKeys(value, ['status', 'stepId'], 'unknown tutorial field');
  if (!isTutorialStatus(value.status)) {
    throw new RangeError('settings tutorial status is not supported');
  }
  if (!isTutorialStepId(value.stepId)) {
    throw new RangeError('settings tutorial step is not supported');
  }
  if (value.status === 'unoffered' && value.stepId !== 'focus-target') {
    throw new RangeError('unoffered tutorial must use the focus-target step');
  }
  if (value.status === 'completed' && value.stepId !== 'return-to-play') {
    throw new RangeError('completed tutorial must use the return-to-play step');
  }
  return freezeTutorial(value.status, value.stepId);
}

/** Strictly parses the preferences DTO embedded in save documents. */
export function parseGameSettings(value: unknown): GameSettingsV1 {
  if (!isRecord(value)) throw new RangeError('settings must be an object');
  assertExactKeys(value, ['version', 'qualityLock', 'inputBindings'], 'unknown settings field');
  if (value.version !== 1) throw new RangeError('settings version must be 1');
  if (!isQualityLock(value.qualityLock)) {
    throw new RangeError('settings quality lock is not supported');
  }
  return freezeV1Settings(value.qualityLock, parseInputBindings(value.inputBindings));
}

/** Strictly parses the independent version-2 profile settings document. */
export function parseProfileSettings(value: unknown): GameSettingsV2 {
  if (!isRecord(value)) throw new RangeError('profile settings must be an object');
  assertExactKeys(
    value,
    ['version', 'qualityLock', 'inputBindings', 'tutorial'],
    'unknown profile settings field',
  );
  if (value.version !== 2) throw new RangeError('profile settings version must be 2');
  if (!isQualityLock(value.qualityLock)) {
    throw new RangeError('profile settings quality lock is not supported');
  }
  return freezeV2Settings(
    value.qualityLock,
    parseInputBindings(value.inputBindings),
    parseTutorial(value.tutorial),
  );
}

/** Projects profile preferences into the stable DTO used by SaveEnvelopeV2. */
export function projectGameSettingsV1(settings: GameSettingsV2): GameSettingsV1 {
  const validated = parseProfileSettings(settings);
  return freezeV1Settings(validated.qualityLock, { ...validated.inputBindings });
}

/** Merges imported save preferences while preserving profile-only tutorial progress. */
export function mergeGameSettingsPreferences(
  profile: GameSettingsV2,
  preferences: GameSettingsV1,
): GameSettingsV2 {
  const validatedProfile = parseProfileSettings(profile);
  const validated = parseGameSettings(preferences);
  return freezeV2Settings(
    validated.qualityLock,
    { ...validated.inputBindings },
    validatedProfile.tutorial,
  );
}

/** Returns a validated frozen profile with new tutorial progress. */
export function updateTutorialSettings(
  settings: GameSettingsV2,
  tutorial: TutorialProgress,
): GameSettingsV2 {
  return parseProfileSettings({ ...settings, tutorial });
}

/** Returns a validated frozen profile with one input action rebound. */
export function rebindInput(
  settings: GameSettingsV2,
  action: InputAction,
  code: string,
): GameSettingsV2 {
  const nextBindings = { ...settings.inputBindings, [action]: code };
  return parseProfileSettings({ ...settings, inputBindings: nextBindings });
}

function migrateLegacySettings(settings: GameSettingsV1): GameSettingsV2 {
  return freezeV2Settings(
    settings.qualityLock,
    { ...settings.inputBindings },
    {
      status: 'skipped',
      stepId: 'focus-target',
    },
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Persists independent profile settings through a browser-compatible storage port. */
export class SettingsRepository {
  constructor(private readonly storage: KeyValueStorage) {}

  load(): SettingsLoadResult {
    let text: string | null;
    try {
      text = this.storage.getItem(SETTINGS_STORAGE_KEY);
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to read settings: ${describeError(error)}`,
      };
    }
    if (text !== null) {
      try {
        return {
          ok: true,
          settings: parseProfileSettings(JSON.parse(text) as unknown),
          source: 'stored',
        };
      } catch (error: unknown) {
        return {
          ok: false,
          settings: DEFAULT_GAME_SETTINGS,
          error: `Unable to parse settings: ${describeError(error)}`,
        };
      }
    }

    let legacyText: string | null;
    try {
      legacyText = this.storage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to read legacy settings: ${describeError(error)}`,
      };
    }
    if (legacyText === null) {
      return { ok: true, settings: DEFAULT_GAME_SETTINGS, source: 'default' };
    }

    let migrated: GameSettingsV2;
    try {
      migrated = migrateLegacySettings(parseGameSettings(JSON.parse(legacyText) as unknown));
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to parse legacy settings: ${describeError(error)}`,
      };
    }
    try {
      this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(migrated));
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to migrate settings: ${describeError(error)}`,
      };
    }
    return { ok: true, settings: migrated, source: 'migrated' };
  }

  save(settings: GameSettingsV2): SettingsSaveResult {
    try {
      const validated = parseProfileSettings(settings);
      this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validated));
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: `Unable to save settings: ${describeError(error)}` };
    }
  }
}
