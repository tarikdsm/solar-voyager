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

export type InputAction = (typeof INPUT_ACTIONS)[number];
export type InputBindings = Readonly<Record<InputAction, string>>;
export type QualityLock = 'auto' | 'low' | 'medium' | 'high';

export interface GameSettingsV1 {
  readonly version: 1;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SettingsLoadResult =
  | {
      readonly ok: true;
      readonly settings: GameSettingsV1;
      readonly source: 'default' | 'stored';
    }
  | {
      readonly ok: false;
      readonly settings: GameSettingsV1;
      readonly error: string;
    };

export type SettingsSaveResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export const SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v1';

const RESERVED_CODES = Object.freeze(
  new Set(['Escape', 'F1', 'F5', 'F11', 'F12', 'Tab', 'MetaLeft', 'MetaRight']),
);

function freezeSettings(
  qualityLock: QualityLock,
  inputBindings: Record<InputAction, string>,
): GameSettingsV1 {
  return Object.freeze({
    version: 1 as const,
    qualityLock,
    inputBindings: Object.freeze(inputBindings),
  });
}

export const DEFAULT_GAME_SETTINGS = freezeSettings('auto', {
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
});

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
    if (key !== undefined && !expectedKeys.includes(key))
      throw new RangeError(`${unknownMessage}: ${key}`);
  }
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index];
    if (key !== undefined && !(key in value))
      throw new RangeError(`settings field is missing: ${key}`);
  }
}

function isQualityLock(value: unknown): value is QualityLock {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high';
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

/** Strictly parses settings from an unknown JSON-compatible value. */
export function parseGameSettings(value: unknown): GameSettingsV1 {
  if (!isRecord(value)) throw new RangeError('settings must be an object');
  assertExactKeys(value, ['version', 'qualityLock', 'inputBindings'], 'unknown settings field');
  if (value.version !== 1) throw new RangeError('settings version must be 1');
  if (!isQualityLock(value.qualityLock))
    throw new RangeError('settings quality lock is not supported');
  return freezeSettings(value.qualityLock, parseInputBindings(value.inputBindings));
}

/** Returns a validated frozen copy with one input action rebound. */
export function rebindInput(
  settings: GameSettingsV1,
  action: InputAction,
  code: string,
): GameSettingsV1 {
  const nextBindings = { ...settings.inputBindings, [action]: code };
  return parseGameSettings({ ...settings, inputBindings: nextBindings });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Persists settings through a browser-compatible storage port. */
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
    if (text === null) return { ok: true, settings: DEFAULT_GAME_SETTINGS, source: 'default' };
    try {
      return {
        ok: true,
        settings: parseGameSettings(JSON.parse(text) as unknown),
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

  save(settings: GameSettingsV1): SettingsSaveResult {
    try {
      const validated = parseGameSettings(settings);
      this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validated));
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: `Unable to save settings: ${describeError(error)}` };
    }
  }
}
