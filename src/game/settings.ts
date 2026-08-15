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
  'attitudeNormal',
  'attitudeAntinormal',
  'attitudeRadialOut',
  'attitudeRadialIn',
  'attitudeTarget',
  'killRotation',
  'stabilityAssistToggle',
  // Reserved for T0116's CruiseDirector. Registered now so the gamepad A/B
  // buttons (T0106) and the keyboard rebinding UI have a real action to
  // target; nothing reads these yet (see game/input/gamepad.ts).
  'cruiseEngage',
  'cruiseAbort',
] as const);

/** Per-axis gamepad calibration: pitch/yaw/roll are rate axes, throttle is the trigger pair. */
export const GAMEPAD_AXES = Object.freeze(['pitch', 'yaw', 'roll', 'throttle'] as const);

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
export type GamepadAxisId = (typeof GAMEPAD_AXES)[number];

/** Preferences DTO embedded in SaveEnvelopeV3. Its schema intentionally remains version 1. */
export interface GameSettingsV1 {
  readonly version: 1;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
}

export interface TutorialProgress {
  readonly status: TutorialStatus;
  readonly stepId: TutorialStepId;
}

/** Per-axis gamepad calibration: invert flips sign, sensitivity scales after the response curve. */
export interface GamepadAxisSettings {
  readonly invert: boolean;
  readonly sensitivity: number;
}

export type GamepadAxisSettingsMap = Readonly<Record<GamepadAxisId, GamepadAxisSettings>>;

/** Gamepad calibration: global deadzone/curve shared by every axis, invert/sensitivity per axis. */
export interface GamepadSettings {
  readonly deadzone: number;
  readonly curveExponent: number;
  readonly axes: GamepadAxisSettingsMap;
}

/**
 * Independent profile settings document stored outside save slots, superseded by
 * {@link GameSettingsV3}. Kept only as the strict parse target for the one-time
 * v2->v3 migration (`parseProfileSettingsV2`) — do not use this as "the" profile
 * type in new code.
 */
export interface GameSettingsV2 {
  readonly version: 2;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
  readonly tutorial: TutorialProgress;
}

/** Independent profile settings document stored outside save slots. */
export interface GameSettingsV3 {
  readonly version: 3;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
  readonly tutorial: TutorialProgress;
  readonly gamepad: GamepadSettings;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SettingsLoadResult =
  | {
      readonly ok: true;
      readonly settings: GameSettingsV3;
      readonly source: 'default' | 'stored' | 'migrated';
    }
  | {
      readonly ok: false;
      readonly settings: GameSettingsV3;
      readonly error: string;
    };

export type SettingsSaveResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Storage keys, one per profile-document generation.
 *
 * Each schema-incompatible profile version gets its own key (the same choice
 * T0108 made going from v1 to v2), not a shared key with the document version
 * bumped in place. `SaveEnvelopeV3` deliberately keeps one slot name across
 * document versions (ADR-034 §4) — but that precedent doesn't transfer here:
 * the save slot has no fallback-read tier below it (renaming it would orphan
 * deployed saves with no path back to them), whereas the profile document
 * already has a proven two-tier fallback-read/migrate/write-forward
 * mechanism, so extending it to a third tier costs little. Sharing a key
 * would also mean a downgraded build (an older, pre-v3 build a player reverts
 * to, or a rolled-back deploy) reads the newer document, fails to parse it,
 * falls back to defaults for that session, and then — on the next settings
 * write triggered by perfectly ordinary play (tutorial progress, a quality
 * change) — persists a fresh older-schema document over it, silently
 * destroying the newer one. A dedicated key makes that non-destructive: the
 * older build never touches it, so the newer document simply waits
 * untouched until a v3-aware build reads it again.
 */
export const SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v3';
/** The v2 profile key (T0108's era) — read-and-migrate-forward only, never written by a v3+ build. */
export const LEGACY_V2_SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v2';
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
  attitudeNormal: 'Digit4',
  attitudeAntinormal: 'Digit5',
  attitudeRadialOut: 'Digit6',
  attitudeRadialIn: 'Digit7',
  attitudeTarget: 'Digit8',
  killRotation: 'KeyX',
  stabilityAssistToggle: 'KeyT',
  cruiseEngage: 'KeyG',
  cruiseAbort: 'KeyV',
};

/** Gamepad shaping defaults and valid ranges (T0106 brief: deadzone 0.08, curve exponent 1.6). */
export const GAMEPAD_DEADZONE_DEFAULT = 0.08;
export const GAMEPAD_DEADZONE_MIN = 0;
export const GAMEPAD_DEADZONE_MAX = 0.5;
export const GAMEPAD_CURVE_EXPONENT_DEFAULT = 1.6;
export const GAMEPAD_CURVE_EXPONENT_MIN = 0.5;
export const GAMEPAD_CURVE_EXPONENT_MAX = 4;
export const GAMEPAD_SENSITIVITY_DEFAULT = 1;
export const GAMEPAD_SENSITIVITY_MIN = 0.1;
export const GAMEPAD_SENSITIVITY_MAX = 4;

/**
 * Prefix of the placeholder code a backfilled action gets when its default is taken.
 *
 * `KeyboardEvent.code` never contains a dot, so a placeholder can never be
 * produced by a keyboard and the action is simply unbound until the player
 * rebinds it. See `parseInputBindings`.
 */
const UNBOUND_CODE_PREFIX = 'unbound.';

/** True for the placeholder an append-safe backfill assigns to an unbindable action. */
export function isUnboundInputCode(code: string): boolean {
  return code.startsWith(UNBOUND_CODE_PREFIX);
}

/**
 * Returns a placeholder code that is free in `assignedCodes`.
 *
 * A previous backfill's placeholder is a legal explicit binding — the document
 * it wrote must round-trip — so an untrusted document can carry
 * `unbound.<action>` on some *other* action. Emitting the bare placeholder
 * anyway would produce two actions sharing one code: a document this parser
 * accepts but rejects on the next load, which is exactly the unloadable-profile
 * failure the backfill exists to prevent. The suffix search terminates after at
 * most `INPUT_ACTIONS.length` probes, since that bounds the codes in play.
 */
function unboundCodeFor(action: InputAction, assignedCodes: ReadonlySet<string>): string {
  const preferred = `${UNBOUND_CODE_PREFIX}${action}`;
  if (!assignedCodes.has(preferred)) return preferred;
  for (let suffix = 1; suffix <= INPUT_ACTIONS.length; suffix += 1) {
    const candidate = `${preferred}.${String(suffix)}`;
    if (!assignedCodes.has(candidate)) return candidate;
  }
  throw new RangeError(`input binding ${action} has no free placeholder code`);
}

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

function freezeGamepadAxisSettings(invert: boolean, sensitivity: number): GamepadAxisSettings {
  return Object.freeze({ invert, sensitivity });
}

function freezeGamepadSettings(
  deadzone: number,
  curveExponent: number,
  axes: Record<GamepadAxisId, GamepadAxisSettings>,
): GamepadSettings {
  const frozenAxes = {} as Record<GamepadAxisId, GamepadAxisSettings>;
  for (let index = 0; index < GAMEPAD_AXES.length; index += 1) {
    const axis = GAMEPAD_AXES[index] as GamepadAxisId;
    const setting = axes[axis];
    frozenAxes[axis] = Object.isFrozen(setting)
      ? setting
      : freezeGamepadAxisSettings(setting.invert, setting.sensitivity);
  }
  return Object.freeze({ deadzone, curveExponent, axes: Object.freeze(frozenAxes) });
}

const DEFAULT_GAMEPAD_AXIS_SETTINGS = freezeGamepadAxisSettings(false, GAMEPAD_SENSITIVITY_DEFAULT);

/** Default gamepad calibration: no inversion, unit sensitivity, the brief's deadzone/curve. */
export const DEFAULT_GAMEPAD_SETTINGS = freezeGamepadSettings(
  GAMEPAD_DEADZONE_DEFAULT,
  GAMEPAD_CURVE_EXPONENT_DEFAULT,
  {
    pitch: DEFAULT_GAMEPAD_AXIS_SETTINGS,
    yaw: DEFAULT_GAMEPAD_AXIS_SETTINGS,
    roll: DEFAULT_GAMEPAD_AXIS_SETTINGS,
    throttle: DEFAULT_GAMEPAD_AXIS_SETTINGS,
  },
);

function freezeV3Settings(
  qualityLock: QualityLock,
  inputBindings: Record<InputAction, string>,
  tutorial: TutorialProgress,
  gamepad: GamepadSettings,
): GameSettingsV3 {
  return Object.freeze({
    version: 3 as const,
    qualityLock,
    inputBindings: Object.freeze(inputBindings),
    tutorial: Object.isFrozen(tutorial)
      ? tutorial
      : freezeTutorial(tutorial.status, tutorial.stepId),
    gamepad: Object.isFrozen(gamepad)
      ? gamepad
      : freezeGamepadSettings(
          gamepad.deadzone,
          gamepad.curveExponent,
          gamepad.axes as Record<GamepadAxisId, GamepadAxisSettings>,
        ),
  });
}

export const DEFAULT_GAME_SETTINGS = freezeV3Settings(
  'auto',
  { ...DEFAULT_INPUT_BINDINGS },
  { status: 'unoffered', stepId: 'focus-target' },
  DEFAULT_GAMEPAD_SETTINGS,
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

function isFiniteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validateDeadzone(value: unknown): number {
  if (!isFiniteNumberInRange(value, GAMEPAD_DEADZONE_MIN, GAMEPAD_DEADZONE_MAX)) {
    throw new RangeError(
      `gamepad deadzone must be a number in [${String(GAMEPAD_DEADZONE_MIN)}, ${String(GAMEPAD_DEADZONE_MAX)}]`,
    );
  }
  return value;
}

function validateCurveExponent(value: unknown): number {
  if (!isFiniteNumberInRange(value, GAMEPAD_CURVE_EXPONENT_MIN, GAMEPAD_CURVE_EXPONENT_MAX)) {
    throw new RangeError(
      `gamepad curve exponent must be a number in [${String(GAMEPAD_CURVE_EXPONENT_MIN)}, ${String(GAMEPAD_CURVE_EXPONENT_MAX)}]`,
    );
  }
  return value;
}

function validateSensitivity(value: unknown, axis: GamepadAxisId): number {
  if (!isFiniteNumberInRange(value, GAMEPAD_SENSITIVITY_MIN, GAMEPAD_SENSITIVITY_MAX)) {
    throw new RangeError(
      `gamepad axis ${axis} sensitivity must be a number in [${String(GAMEPAD_SENSITIVITY_MIN)}, ${String(GAMEPAD_SENSITIVITY_MAX)}]`,
    );
  }
  return value;
}

function parseGamepadAxisSettings(value: unknown, axis: GamepadAxisId): GamepadAxisSettings {
  if (!isRecord(value)) throw new RangeError(`gamepad axis ${axis} must be an object`);
  assertExactKeys(value, ['invert', 'sensitivity'], `unknown gamepad axis field (${axis})`);
  if (typeof value.invert !== 'boolean') {
    throw new RangeError(`gamepad axis ${axis} invert must be a boolean`);
  }
  return freezeGamepadAxisSettings(value.invert, validateSensitivity(value.sensitivity, axis));
}

/** Strictly parses gamepad calibration. Every field is required — there is no prior version to backfill from. */
function parseGamepadSettings(value: unknown): GamepadSettings {
  if (!isRecord(value)) throw new RangeError('gamepad settings must be an object');
  assertExactKeys(value, ['deadzone', 'curveExponent', 'axes'], 'unknown gamepad settings field');
  const deadzone = validateDeadzone(value.deadzone);
  const curveExponent = validateCurveExponent(value.curveExponent);
  if (!isRecord(value.axes)) throw new RangeError('gamepad axes must be an object');
  assertExactKeys(value.axes, [...GAMEPAD_AXES], 'unknown gamepad axis');
  const axes = {} as Record<GamepadAxisId, GamepadAxisSettings>;
  for (let index = 0; index < GAMEPAD_AXES.length; index += 1) {
    const axis = GAMEPAD_AXES[index] as GamepadAxisId;
    axes[axis] = parseGamepadAxisSettings(value.axes[axis], axis);
  }
  return freezeGamepadSettings(deadzone, curveExponent, axes);
}

function validateCode(code: unknown, action: InputAction): string {
  if (typeof code !== 'string' || code.length === 0 || code.length > 64 || /\s/u.test(code)) {
    throw new RangeError(`input binding ${action} must be a nonempty KeyboardEvent.code`);
  }
  if (RESERVED_CODES.has(code)) throw new RangeError(`input binding ${code} is reserved`);
  return code;
}

/**
 * Parses a binding map, treating `INPUT_ACTIONS` as an append-only registry.
 *
 * A document written before an action existed is incomplete, not corrupt.
 * Rejecting it would be fatal rather than strict: this runs inside
 * `parseGameSettings`, which every `SaveEnvelope` load goes through, so any
 * later task that adds an action would make every existing save unloadable.
 * Missing actions are therefore backfilled from the defaults; unknown actions,
 * duplicate codes and reserved codes still throw.
 */
function parseInputBindings(value: unknown): Record<InputAction, string> {
  if (!isRecord(value)) throw new RangeError('inputBindings must be an object');
  const actualKeys = Object.keys(value);
  for (let index = 0; index < actualKeys.length; index += 1) {
    const key = actualKeys[index];
    if (key !== undefined && !INPUT_ACTIONS.includes(key as InputAction)) {
      throw new RangeError(`unknown input action: ${key}`);
    }
  }
  const assignedCodes = new Set<string>();
  const explicitCodes: (string | undefined)[] = [];
  for (let index = 0; index < INPUT_ACTIONS.length; index += 1) {
    const action = INPUT_ACTIONS[index];
    if (action === undefined) throw new RangeError('input action list is sparse');
    if (!(action in value)) continue;
    const code = validateCode(value[action], action);
    if (assignedCodes.has(code)) throw new RangeError(`input code ${code} is already bound`);
    assignedCodes.add(code);
    explicitCodes[index] = code;
  }
  // Written in registry order so `Object.keys` matches `INPUT_ACTIONS`, which
  // the settings tests and the rebinding panel both rely on.
  const result = {} as Record<InputAction, string>;
  for (let index = 0; index < INPUT_ACTIONS.length; index += 1) {
    const action = INPUT_ACTIONS[index] as InputAction;
    const explicit = explicitCodes[index];
    if (explicit !== undefined) {
      result[action] = explicit;
      continue;
    }
    // A pre-existing binding may already occupy a new action's default key.
    // Leaving that action unbindable beats failing the whole document.
    const preferred = DEFAULT_INPUT_BINDINGS[action];
    const code = assignedCodes.has(preferred) ? unboundCodeFor(action, assignedCodes) : preferred;
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

/**
 * Strictly parses the superseded version-2 profile settings document.
 *
 * Not exported: the only remaining caller is the v2->v3 migration inside
 * `SettingsRepository.load()`. Kept byte-for-byte equivalent to what this
 * function used to do before `gamepad` existed, so a genuine pre-T0106
 * document (no `gamepad` field) still parses here even though it now fails
 * the current `parseProfileSettings`.
 */
function parseProfileSettingsV2(value: unknown): GameSettingsV2 {
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

/** Strictly parses the independent version-3 profile settings document. */
export function parseProfileSettings(value: unknown): GameSettingsV3 {
  if (!isRecord(value)) throw new RangeError('profile settings must be an object');
  assertExactKeys(
    value,
    ['version', 'qualityLock', 'inputBindings', 'tutorial', 'gamepad'],
    'unknown profile settings field',
  );
  if (value.version !== 3) throw new RangeError('profile settings version must be 3');
  if (!isQualityLock(value.qualityLock)) {
    throw new RangeError('profile settings quality lock is not supported');
  }
  return freezeV3Settings(
    value.qualityLock,
    parseInputBindings(value.inputBindings),
    parseTutorial(value.tutorial),
    parseGamepadSettings(value.gamepad),
  );
}

/**
 * Lifts a superseded v2 profile to v3 by attaching default gamepad calibration.
 *
 * Mirrors `migrateLegacySettings` (v1->v2) one version up: a whole-document
 * migration rather than a per-field backfill, because `gamepad` is a brand-new
 * required object with no prior partial state to recover — there is nothing to
 * backfill *from* inside an existing v2 document.
 */
function migrateProfileV2ToV3(settings: GameSettingsV2): GameSettingsV3 {
  return freezeV3Settings(
    settings.qualityLock,
    { ...settings.inputBindings },
    settings.tutorial,
    DEFAULT_GAMEPAD_SETTINGS,
  );
}

/** Projects profile preferences into the stable DTO used by SaveEnvelopeV3. */
export function projectGameSettingsV1(settings: GameSettingsV3): GameSettingsV1 {
  const validated = parseProfileSettings(settings);
  return freezeV1Settings(validated.qualityLock, { ...validated.inputBindings });
}

/** Merges imported save preferences while preserving profile-only tutorial and gamepad state. */
export function mergeGameSettingsPreferences(
  profile: GameSettingsV3,
  preferences: GameSettingsV1,
): GameSettingsV3 {
  const validatedProfile = parseProfileSettings(profile);
  const validated = parseGameSettings(preferences);
  return freezeV3Settings(
    validated.qualityLock,
    { ...validated.inputBindings },
    validatedProfile.tutorial,
    validatedProfile.gamepad,
  );
}

/** Returns a validated frozen profile with new tutorial progress. */
export function updateTutorialSettings(
  settings: GameSettingsV3,
  tutorial: TutorialProgress,
): GameSettingsV3 {
  return parseProfileSettings({ ...settings, tutorial });
}

/** Returns a validated frozen profile with one input action rebound. */
export function rebindInput(
  settings: GameSettingsV3,
  action: InputAction,
  code: string,
): GameSettingsV3 {
  const nextBindings = { ...settings.inputBindings, [action]: code };
  return parseProfileSettings({ ...settings, inputBindings: nextBindings });
}

/** Returns a validated frozen profile with the global gamepad deadzone updated. */
export function updateGamepadDeadzone(settings: GameSettingsV3, deadzone: number): GameSettingsV3 {
  return parseProfileSettings({ ...settings, gamepad: { ...settings.gamepad, deadzone } });
}

/** Returns a validated frozen profile with the global gamepad response-curve exponent updated. */
export function updateGamepadCurveExponent(
  settings: GameSettingsV3,
  curveExponent: number,
): GameSettingsV3 {
  return parseProfileSettings({ ...settings, gamepad: { ...settings.gamepad, curveExponent } });
}

/** Returns a validated frozen profile with one gamepad axis's invert flag updated. */
export function updateGamepadAxisInvert(
  settings: GameSettingsV3,
  axis: GamepadAxisId,
  invert: boolean,
): GameSettingsV3 {
  return parseProfileSettings({
    ...settings,
    gamepad: {
      ...settings.gamepad,
      axes: { ...settings.gamepad.axes, [axis]: { ...settings.gamepad.axes[axis], invert } },
    },
  });
}

/** Returns a validated frozen profile with one gamepad axis's sensitivity updated. */
export function updateGamepadAxisSensitivity(
  settings: GameSettingsV3,
  axis: GamepadAxisId,
  sensitivity: number,
): GameSettingsV3 {
  return parseProfileSettings({
    ...settings,
    gamepad: {
      ...settings.gamepad,
      axes: { ...settings.gamepad.axes, [axis]: { ...settings.gamepad.axes[axis], sensitivity } },
    },
  });
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
    // Tier 1: the current key. Present-but-invalid fails closed here — it
    // does not cascade to older keys, the same "a present current document
    // that is broken is a real error, not a version guess" rule the v1/v2
    // boundary already established.
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

    // Tier 2: the v2 key (T0108's era, pre-gamepad). Migrate up one step and
    // persist forward to the current key.
    let legacyV2Text: string | null;
    try {
      legacyV2Text = this.storage.getItem(LEGACY_V2_SETTINGS_STORAGE_KEY);
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to read settings: ${describeError(error)}`,
      };
    }
    if (legacyV2Text !== null) {
      let migrated: GameSettingsV3;
      try {
        migrated = migrateProfileV2ToV3(
          parseProfileSettingsV2(JSON.parse(legacyV2Text) as unknown),
        );
      } catch (error: unknown) {
        return {
          ok: false,
          settings: DEFAULT_GAME_SETTINGS,
          error: `Unable to parse settings: ${describeError(error)}`,
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

    // Tier 3: the v1 key (pre-T0108, standalone-profile era). Migrate up two
    // steps and persist forward to the current key.
    let legacyV1Text: string | null;
    try {
      legacyV1Text = this.storage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to read legacy settings: ${describeError(error)}`,
      };
    }
    if (legacyV1Text === null) {
      return { ok: true, settings: DEFAULT_GAME_SETTINGS, source: 'default' };
    }

    let migrated: GameSettingsV3;
    try {
      migrated = migrateProfileV2ToV3(
        migrateLegacySettings(parseGameSettings(JSON.parse(legacyV1Text) as unknown)),
      );
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

  save(settings: GameSettingsV3): SettingsSaveResult {
    try {
      const validated = parseProfileSettings(settings);
      this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validated));
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: `Unable to save settings: ${describeError(error)}` };
    }
  }
}
