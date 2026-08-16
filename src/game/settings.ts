import { HUD_PRESETS, isHudPreset, type HudPreset } from './hud/hudPresets.js';

export type { HudPreset };
export { HUD_PRESETS };

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
  // T0112 HUD controls. Rebindable like every other action so the preset key and
  // the label toggle go through one focus policy (`blocksGameKey`) and one
  // rebinding UI, rather than becoming two more hardcoded camera-style keys.
  'hudPresetCycle',
  'hudBodyLabelsToggle',
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
/**
 * Exposure policy (T0127).
 *
 * `auto` runs the adaptive controller; `fixed` holds v1's exposure of 1.0. Lives
 * here rather than in `render/exposureController.ts` because `game/` may not import
 * `render/` — the same direction `QualityLock` already travels.
 */
export type ExposureMode = 'auto' | 'fixed';
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

/**
 * Independent profile settings document, superseded by {@link GameSettingsV4}.
 *
 * Kept only as the strict parse target for the one-time v3->v4 migration
 * (`parseProfileSettingsV3`), exactly as V2 is kept for v2->v3.
 */
export interface GameSettingsV3 {
  readonly version: 3;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
  readonly tutorial: TutorialProgress;
  readonly gamepad: GamepadSettings;
}

/**
 * Chase-camera presentation toggles (T0110).
 *
 * Both default on: the effects are sized to be subtle (+8 deg of field at full
 * throttle, 0.15 deg of shake at 5 g), not to be opt-in. They are switchable
 * because motion sensitivity is a real accessibility concern, not a preference.
 */
export interface CameraSettings {
  /** Widen the field of view with throttle. */
  readonly fovWidening: boolean;
  /** Shake the camera under high proper acceleration. */
  readonly shake: boolean;
}

/**
 * Independent profile settings document, superseded by {@link GameSettingsV5}.
 *
 * Kept only as the strict parse target for the one-time v4->v5 migration
 * (`parseProfileSettingsV4`), exactly as V3 is kept for v3->v4.
 */
export interface GameSettingsV4 {
  readonly version: 4;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
  readonly tutorial: TutorialProgress;
  readonly gamepad: GamepadSettings;
  readonly camera: CameraSettings;
}

/**
 * HUD preset and world-marker preferences (T0112).
 *
 * `preset` defaults to `clean` because that is the point of the task: v1 showed
 * every instrument at once and the maintainer's complaint was that the
 * instruments were the whole game. `bodyLabels` defaults on — a label with a
 * distance is navigation, not instrumentation, and it is the only in-world cue
 * for what you are looking at.
 */
export interface HudSettings {
  readonly preset: HudPreset;
  readonly bodyLabels: boolean;
}

/**
 * Independent profile settings document, superseded by {@link GameSettingsV7}.
 *
 * Kept only as the strict parse target for the one-time v5->v6 migration
 * (`parseProfileSettingsV5`), exactly as V4 is kept for v4->v5.
 */
export interface GameSettingsV5 {
  readonly version: 5;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
  readonly tutorial: TutorialProgress;
  readonly gamepad: GamepadSettings;
  readonly camera: CameraSettings;
  readonly hud: HudSettings;
}

/**
 * Renderer presentation preferences (T0127).
 *
 * `exposureMode` defaults to `auto`: the whole point of the adaptive controller is
 * that Neptune daylight and a near-Sun approach both read without the player
 * touching anything. `fixed` is the exact v1 behaviour, kept as an escape hatch for
 * anyone who finds a moving exposure distracting — and the value the adaptive
 * quality governor pins to on its lowest rungs.
 */
export interface RenderSettings {
  readonly exposureMode: ExposureMode;
}

/**
 * Independent profile settings document, superseded by {@link GameSettingsV7}.
 *
 * Kept only as the strict parse target for the one-time v6->v7 migration
 * (`parseProfileSettingsV6`), exactly as V5 is kept for v5->v6.
 */
export interface GameSettingsV6 {
  readonly version: 6;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
  readonly tutorial: TutorialProgress;
  readonly gamepad: GamepadSettings;
  readonly camera: CameraSettings;
  readonly hud: HudSettings;
  readonly render: RenderSettings;
}

/** Mixer buses the player can set independently (T0144, ADR-041). */
export const AUDIO_BUSES = Object.freeze(['master', 'music', 'sfx', 'ui'] as const);

export type AudioBus = (typeof AUDIO_BUSES)[number];

/**
 * Mixer levels and the Kubrick-mode music policy (T0144, ADR-041).
 *
 * Levels are stored as the **slider position** in [0, 1], not as a gain: the
 * perceptual taper lives in `game/audio/audioDirector.ts` so the persisted
 * number is the one the panel shows, and a future taper change does not
 * invalidate every stored profile.
 *
 * Defaults are deliberately below unity (design doc section 2): the game ships
 * audible rather than muted — the AudioContext is not even constructed until a
 * real user gesture, so page load stays silent without a mute — but the first
 * second of a session should not be a surprise.
 *
 * `exteriorMusic` is the one half of Kubrick mode the player chooses: exterior
 * cameras always silence the diegetic sfx bus, and this decides whether the
 * non-diegetic score survives with them or the vacuum is total.
 */
export interface AudioSettings {
  readonly master: number;
  readonly music: number;
  readonly sfx: number;
  readonly ui: number;
  readonly exteriorMusic: boolean;
}

/**
 * Independent profile settings document, superseded by {@link GameSettingsV8}.
 *
 * Kept only as the strict parse target for the one-time v7->v8 migration
 * (`parseProfileSettingsV7`), exactly as V6 is kept for v6->v7.
 */
export interface GameSettingsV7 {
  readonly version: 7;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
  readonly tutorial: TutorialProgress;
  readonly gamepad: GamepadSettings;
  readonly camera: CameraSettings;
  readonly hud: HudSettings;
  readonly render: RenderSettings;
  readonly audio: AudioSettings;
}

/**
 * Deep-sky background toggles (T0126).
 *
 * The panorama and the zodiacal band are on by default because they are the
 * point of the feature; constellation lines are off by default because they are
 * an overlay, not scenery.
 */
export interface SkySettings {
  /** Draw the Milky Way panorama behind the star field. */
  readonly panorama: boolean;
  /** Draw the faint zodiacal-light gradient along the ecliptic. */
  readonly zodiacalLight: boolean;
  /** Draw the 88 IAU constellation-line figures. */
  readonly constellations: boolean;
}

/** Independent profile settings document stored outside save slots. */
/** Independent profile settings document stored outside save slots. */
export interface GameSettingsV8 {
  readonly version: 8;
  readonly qualityLock: QualityLock;
  readonly inputBindings: InputBindings;
  readonly tutorial: TutorialProgress;
  readonly gamepad: GamepadSettings;
  readonly camera: CameraSettings;
  readonly hud: HudSettings;
  readonly render: RenderSettings;
  readonly audio: AudioSettings;
  readonly sky: SkySettings;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SettingsLoadResult =
  | {
      readonly ok: true;
      readonly settings: GameSettingsV8;
      readonly source: 'default' | 'stored' | 'migrated';
    }
  | {
      readonly ok: false;
      readonly settings: GameSettingsV8;
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
export const SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v8';
/** The v7 profile key (T0144's era, pre-deep-sky) — read-and-migrate-forward only. */
export const LEGACY_V7_SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v7';
/** The v6 profile key (T0127 era, pre-audio) — read-and-migrate-forward only. */
export const LEGACY_V6_SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v6';
/** The v5 profile key (T0112's era, pre-exposure-mode) — read-and-migrate-forward only. */
export const LEGACY_V5_SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v5';
/** The v4 profile key (T0110's era, pre-HUD-preset) — read-and-migrate-forward only. */
export const LEGACY_V4_SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v4';
/** The v3 profile key (T0106's era, pre-camera) — read-and-migrate-forward only. */
export const LEGACY_V3_SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v3';
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
  hudPresetCycle: 'KeyH',
  hudBodyLabelsToggle: 'KeyL',
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

function freezeCameraSettings(fovWidening: boolean, shake: boolean): CameraSettings {
  return Object.freeze({ fovWidening, shake });
}

/** Chase-camera effects on, at the subtle amplitudes T0110 specifies. */
export const DEFAULT_CAMERA_SETTINGS = freezeCameraSettings(true, true);

function freezeV4Settings(
  qualityLock: QualityLock,
  inputBindings: Record<InputAction, string>,
  tutorial: TutorialProgress,
  gamepad: GamepadSettings,
  camera: CameraSettings,
): GameSettingsV4 {
  return Object.freeze({
    version: 4 as const,
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
    camera: Object.isFrozen(camera)
      ? camera
      : freezeCameraSettings(camera.fovWidening, camera.shake),
  });
}

function freezeHudSettings(preset: HudPreset, bodyLabels: boolean): HudSettings {
  return Object.freeze({ preset, bodyLabels });
}

/** Clean preset with world labels on — the v2 out-of-the-box HUD. */
export const DEFAULT_HUD_SETTINGS = freezeHudSettings('clean', true);

function freezeV5Settings(
  qualityLock: QualityLock,
  inputBindings: Record<InputAction, string>,
  tutorial: TutorialProgress,
  gamepad: GamepadSettings,
  camera: CameraSettings,
  hud: HudSettings,
): GameSettingsV5 {
  return Object.freeze({
    version: 5 as const,
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
    camera: Object.isFrozen(camera)
      ? camera
      : freezeCameraSettings(camera.fovWidening, camera.shake),
    hud: Object.isFrozen(hud) ? hud : freezeHudSettings(hud.preset, hud.bodyLabels),
  });
}

function freezeRenderSettings(exposureMode: ExposureMode): RenderSettings {
  return Object.freeze({ exposureMode });
}

/** Adaptive exposure on — the reason T0127 exists (plan §3.5). */
export const DEFAULT_RENDER_SETTINGS = freezeRenderSettings('auto');

function freezeV6Settings(
  qualityLock: QualityLock,
  inputBindings: Record<InputAction, string>,
  tutorial: TutorialProgress,
  gamepad: GamepadSettings,
  camera: CameraSettings,
  hud: HudSettings,
  render: RenderSettings,
): GameSettingsV6 {
  return Object.freeze({
    version: 6 as const,
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
    camera: Object.isFrozen(camera)
      ? camera
      : freezeCameraSettings(camera.fovWidening, camera.shake),
    hud: Object.isFrozen(hud) ? hud : freezeHudSettings(hud.preset, hud.bodyLabels),
    render: Object.isFrozen(render) ? render : freezeRenderSettings(render.exposureMode),
  });
}

function freezeAudioSettings(
  master: number,
  music: number,
  sfx: number,
  ui: number,
  exteriorMusic: boolean,
): AudioSettings {
  return Object.freeze({ master, music, sfx, ui, exteriorMusic });
}

/** Valid range of every mixer level: the slider position, not a gain. */
export const AUDIO_LEVEL_MIN = 0;
export const AUDIO_LEVEL_MAX = 1;

/**
 * Audible out of the box at modest levels, with the score kept on exterior
 * cameras (design doc section 2).
 *
 * The ship is louder than the score because the ship is the subject; both sit
 * below unity so a player on speakers is not startled by the first burn.
 */
export const DEFAULT_AUDIO_SETTINGS = freezeAudioSettings(0.7, 0.5, 0.7, 0.5, true);

function freezeV7Settings(
  qualityLock: QualityLock,
  inputBindings: Record<InputAction, string>,
  tutorial: TutorialProgress,
  gamepad: GamepadSettings,
  camera: CameraSettings,
  hud: HudSettings,
  render: RenderSettings,
  audio: AudioSettings,
): GameSettingsV7 {
  return Object.freeze({
    version: 7 as const,
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
    camera: Object.isFrozen(camera)
      ? camera
      : freezeCameraSettings(camera.fovWidening, camera.shake),
    hud: Object.isFrozen(hud) ? hud : freezeHudSettings(hud.preset, hud.bodyLabels),
    render: Object.isFrozen(render) ? render : freezeRenderSettings(render.exposureMode),
    audio: Object.isFrozen(audio)
      ? audio
      : freezeAudioSettings(audio.master, audio.music, audio.sfx, audio.ui, audio.exteriorMusic),
  });
}

function freezeSkySettings(
  panorama: boolean,
  zodiacalLight: boolean,
  constellations: boolean,
): SkySettings {
  return Object.freeze({ panorama, zodiacalLight, constellations });
}

/** Scenery on, overlay off — the deep sky as it looks, without the figure lines. */
export const DEFAULT_SKY_SETTINGS = freezeSkySettings(true, true, false);

function freezeV8Settings(
  qualityLock: QualityLock,
  inputBindings: Record<InputAction, string>,
  tutorial: TutorialProgress,
  gamepad: GamepadSettings,
  camera: CameraSettings,
  hud: HudSettings,
  render: RenderSettings,
  audio: AudioSettings,
  sky: SkySettings,
): GameSettingsV8 {
  return Object.freeze({
    version: 8 as const,
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
    camera: Object.isFrozen(camera)
      ? camera
      : freezeCameraSettings(camera.fovWidening, camera.shake),
    hud: Object.isFrozen(hud) ? hud : freezeHudSettings(hud.preset, hud.bodyLabels),
    render: Object.isFrozen(render) ? render : freezeRenderSettings(render.exposureMode),
    audio: Object.isFrozen(audio)
      ? audio
      : freezeAudioSettings(audio.master, audio.music, audio.sfx, audio.ui, audio.exteriorMusic),
    sky: Object.isFrozen(sky)
      ? sky
      : freezeSkySettings(sky.panorama, sky.zodiacalLight, sky.constellations),
  });
}

export const DEFAULT_GAME_SETTINGS = freezeV8Settings(
  'auto',
  { ...DEFAULT_INPUT_BINDINGS },
  { status: 'unoffered', stepId: 'focus-target' },
  DEFAULT_GAMEPAD_SETTINGS,
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_HUD_SETTINGS,
  DEFAULT_RENDER_SETTINGS,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_SKY_SETTINGS,
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

/**
 * Strictly parses the superseded version-3 profile settings document.
 *
 * Not exported: the only remaining caller is the v3->v4 migration inside
 * `SettingsRepository.load()`. Kept byte-for-byte equivalent to what
 * `parseProfileSettings` used to do before `camera` existed.
 */
function parseProfileSettingsV3(value: unknown): GameSettingsV3 {
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

/** Strictly parses camera presentation toggles. Every field is required. */
function parseCameraSettings(value: unknown): CameraSettings {
  if (!isRecord(value)) throw new RangeError('camera settings must be an object');
  assertExactKeys(value, ['fovWidening', 'shake'], 'unknown camera settings field');
  if (typeof value.fovWidening !== 'boolean') {
    throw new RangeError('camera fovWidening must be a boolean');
  }
  if (typeof value.shake !== 'boolean') throw new RangeError('camera shake must be a boolean');
  return freezeCameraSettings(value.fovWidening, value.shake);
}

/**
 * Strictly parses the superseded version-4 profile settings document.
 *
 * Not exported: the only remaining caller is the v4->v5 migration inside
 * `SettingsRepository.load()`. Kept byte-for-byte equivalent to what
 * `parseProfileSettings` used to do before `hud` existed.
 */
function parseProfileSettingsV4(value: unknown): GameSettingsV4 {
  if (!isRecord(value)) throw new RangeError('profile settings must be an object');
  assertExactKeys(
    value,
    ['version', 'qualityLock', 'inputBindings', 'tutorial', 'gamepad', 'camera'],
    'unknown profile settings field',
  );
  if (value.version !== 4) throw new RangeError('profile settings version must be 4');
  if (!isQualityLock(value.qualityLock)) {
    throw new RangeError('profile settings quality lock is not supported');
  }
  return freezeV4Settings(
    value.qualityLock,
    parseInputBindings(value.inputBindings),
    parseTutorial(value.tutorial),
    parseGamepadSettings(value.gamepad),
    parseCameraSettings(value.camera),
  );
}

/** Strictly parses HUD preferences. Every field is required. */
function parseHudSettings(value: unknown): HudSettings {
  if (!isRecord(value)) throw new RangeError('hud settings must be an object');
  assertExactKeys(value, ['preset', 'bodyLabels'], 'unknown hud settings field');
  if (!isHudPreset(value.preset)) throw new RangeError('hud preset is not supported');
  if (typeof value.bodyLabels !== 'boolean') {
    throw new RangeError('hud bodyLabels must be a boolean');
  }
  return freezeHudSettings(value.preset, value.bodyLabels);
}

/**
 * Strictly parses the superseded version-5 profile settings document.
 *
 * Not exported: the only remaining caller is the v5->v6 migration inside
 * `SettingsRepository.load()`. Kept byte-for-byte equivalent to what
 * `parseProfileSettings` used to do before `render` existed.
 */
function parseProfileSettingsV5(value: unknown): GameSettingsV5 {
  if (!isRecord(value)) throw new RangeError('profile settings must be an object');
  assertExactKeys(
    value,
    ['version', 'qualityLock', 'inputBindings', 'tutorial', 'gamepad', 'camera', 'hud'],
    'unknown profile settings field',
  );
  if (value.version !== 5) throw new RangeError('profile settings version must be 5');
  if (!isQualityLock(value.qualityLock)) {
    throw new RangeError('profile settings quality lock is not supported');
  }
  return freezeV5Settings(
    value.qualityLock,
    parseInputBindings(value.inputBindings),
    parseTutorial(value.tutorial),
    parseGamepadSettings(value.gamepad),
    parseCameraSettings(value.camera),
    parseHudSettings(value.hud),
  );
}

function isExposureMode(value: unknown): value is ExposureMode {
  return value === 'auto' || value === 'fixed';
}

/** Strictly parses renderer presentation preferences. Every field is required. */
function parseRenderSettings(value: unknown): RenderSettings {
  if (!isRecord(value)) throw new RangeError('render settings must be an object');
  assertExactKeys(value, ['exposureMode'], 'unknown render settings field');
  if (!isExposureMode(value.exposureMode)) {
    throw new RangeError('render exposure mode is not supported');
  }
  return freezeRenderSettings(value.exposureMode);
}

/**
 * Strictly parses the superseded version-6 profile settings document.
 *
 * Not exported: the only remaining caller is the v6->v7 migration inside
 * `SettingsRepository.load()`. Kept byte-for-byte equivalent to what
 * `parseProfileSettings` used to do before `audio` existed.
 */
function parseProfileSettingsV6(value: unknown): GameSettingsV6 {
  if (!isRecord(value)) throw new RangeError('profile settings must be an object');
  assertExactKeys(
    value,
    ['version', 'qualityLock', 'inputBindings', 'tutorial', 'gamepad', 'camera', 'hud', 'render'],
    'unknown profile settings field',
  );
  if (value.version !== 6) throw new RangeError('profile settings version must be 6');
  if (!isQualityLock(value.qualityLock)) {
    throw new RangeError('profile settings quality lock is not supported');
  }
  return freezeV6Settings(
    value.qualityLock,
    parseInputBindings(value.inputBindings),
    parseTutorial(value.tutorial),
    parseGamepadSettings(value.gamepad),
    parseCameraSettings(value.camera),
    parseHudSettings(value.hud),
    parseRenderSettings(value.render),
  );
}

function validateAudioLevel(value: unknown, bus: AudioBus): number {
  if (!isFiniteNumberInRange(value, AUDIO_LEVEL_MIN, AUDIO_LEVEL_MAX)) {
    throw new RangeError(
      `audio ${bus} level must be a number in [${String(AUDIO_LEVEL_MIN)}, ${String(AUDIO_LEVEL_MAX)}]`,
    );
  }
  return value;
}

/** Strictly parses mixer levels and the Kubrick music policy. Every field is required. */
function parseAudioSettings(value: unknown): AudioSettings {
  if (!isRecord(value)) throw new RangeError('audio settings must be an object');
  assertExactKeys(value, [...AUDIO_BUSES, 'exteriorMusic'], 'unknown audio settings field');
  if (typeof value.exteriorMusic !== 'boolean') {
    throw new RangeError('audio exteriorMusic must be a boolean');
  }
  return freezeAudioSettings(
    validateAudioLevel(value.master, 'master'),
    validateAudioLevel(value.music, 'music'),
    validateAudioLevel(value.sfx, 'sfx'),
    validateAudioLevel(value.ui, 'ui'),
    value.exteriorMusic,
  );
}

/** Strictly parses deep-sky background toggles. Every field is required. */
function parseSkySettings(value: unknown): SkySettings {
  if (!isRecord(value)) throw new RangeError('sky settings must be an object');
  assertExactKeys(
    value,
    ['panorama', 'zodiacalLight', 'constellations'],
    'unknown sky settings field',
  );
  if (typeof value.panorama !== 'boolean') throw new RangeError('sky panorama must be a boolean');
  if (typeof value.zodiacalLight !== 'boolean') {
    throw new RangeError('sky zodiacalLight must be a boolean');
  }
  if (typeof value.constellations !== 'boolean') {
    throw new RangeError('sky constellations must be a boolean');
  }
  return freezeSkySettings(value.panorama, value.zodiacalLight, value.constellations);
}
/**
 * Strictly parses a superseded version-7 profile settings document.
 *
 * Not exported: the only remaining caller is the v7->v8 migration inside
 * {@link SettingsRepository.load}, exactly as `parseProfileSettingsV6` is kept
 * for v6->v7.
 */
function parseProfileSettingsV7(value: unknown): GameSettingsV7 {
  if (!isRecord(value)) throw new RangeError('profile settings must be an object');
  assertExactKeys(
    value,
    [
      'version',
      'qualityLock',
      'inputBindings',
      'tutorial',
      'gamepad',
      'camera',
      'hud',
      'render',
      'audio',
    ],
    'unknown profile settings field',
  );
  if (value.version !== 7) throw new RangeError('profile settings version must be 7');
  if (!isQualityLock(value.qualityLock)) {
    throw new RangeError('profile settings quality lock is not supported');
  }
  return freezeV7Settings(
    value.qualityLock,
    parseInputBindings(value.inputBindings),
    parseTutorial(value.tutorial),
    parseGamepadSettings(value.gamepad),
    parseCameraSettings(value.camera),
    parseHudSettings(value.hud),
    parseRenderSettings(value.render),
    parseAudioSettings(value.audio),
  );
}

/** Strictly parses the independent version-8 profile settings document. */
export function parseProfileSettings(value: unknown): GameSettingsV8 {
  if (!isRecord(value)) throw new RangeError('profile settings must be an object');
  assertExactKeys(
    value,
    [
      'version',
      'qualityLock',
      'inputBindings',
      'tutorial',
      'gamepad',
      'camera',
      'hud',
      'render',
      'audio',
      'sky',
    ],
    'unknown profile settings field',
  );
  if (value.version !== 8) throw new RangeError('profile settings version must be 8');
  if (!isQualityLock(value.qualityLock)) {
    throw new RangeError('profile settings quality lock is not supported');
  }
  return freezeV8Settings(
    value.qualityLock,
    parseInputBindings(value.inputBindings),
    parseTutorial(value.tutorial),
    parseGamepadSettings(value.gamepad),
    parseCameraSettings(value.camera),
    parseHudSettings(value.hud),
    parseRenderSettings(value.render),
    parseAudioSettings(value.audio),
    parseSkySettings(value.sky),
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

/**
 * Lifts a superseded v3 profile to v4 by attaching default camera toggles.
 *
 * Same shape as `migrateProfileV2ToV3` one version up: `camera` is a brand-new
 * required object with no prior partial state anywhere in a v3 document to
 * recover from, so this is a whole-document migration rather than a per-field
 * backfill.
 */
function migrateProfileV3ToV4(settings: GameSettingsV3): GameSettingsV4 {
  return freezeV4Settings(
    settings.qualityLock,
    { ...settings.inputBindings },
    settings.tutorial,
    settings.gamepad,
    DEFAULT_CAMERA_SETTINGS,
  );
}

/**
 * Lifts a superseded v4 profile to v5 by attaching default HUD preferences.
 *
 * Same shape as `migrateProfileV3ToV4` one version up: `hud` is a brand-new
 * required object with no prior partial state anywhere in a v4 document to
 * recover from, so this is a whole-document migration rather than a per-field
 * backfill. A returning player therefore lands on Clean — which is the intended
 * v2 default, not an accident of migration: their v1 panel set is one press of
 * the preset key away and the choice then persists.
 */
function migrateProfileV4ToV5(settings: GameSettingsV4): GameSettingsV5 {
  return freezeV5Settings(
    settings.qualityLock,
    { ...settings.inputBindings },
    settings.tutorial,
    settings.gamepad,
    settings.camera,
    DEFAULT_HUD_SETTINGS,
  );
}

/**
 * Lifts a superseded v5 profile to v6 by attaching default renderer preferences.
 *
 * Same shape as `migrateProfileV4ToV5` one version up: `render` is a brand-new
 * required object with no prior partial state anywhere in a v5 document to recover
 * from. A returning player lands on adaptive exposure, which is the intended
 * default and one dropdown away from the v1 behaviour they had.
 */
function migrateProfileV5ToV6(settings: GameSettingsV5): GameSettingsV6 {
  return freezeV6Settings(
    settings.qualityLock,
    { ...settings.inputBindings },
    settings.tutorial,
    settings.gamepad,
    settings.camera,
    settings.hud,
    DEFAULT_RENDER_SETTINGS,
  );
}

/**
 * Lifts a superseded v6 profile to v7 by attaching default mixer levels.
 *
 * Same shape as `migrateProfileV5ToV6` one version up: `audio` is a brand-new
 * required object with no prior partial state anywhere in a v6 document to
 * recover from, so this is a whole-document migration rather than a per-field
 * backfill. A returning player therefore lands on the shipped defaults — audible,
 * not muted (design doc section 2) — which is the same posture a new profile gets.
 */
function migrateProfileV6ToV7(settings: GameSettingsV6): GameSettingsV7 {
  return freezeV7Settings(
    settings.qualityLock,
    { ...settings.inputBindings },
    settings.tutorial,
    settings.gamepad,
    settings.camera,
    settings.hud,
    settings.render,
    DEFAULT_AUDIO_SETTINGS,
  );
}

/**
 * Lifts a superseded v7 profile to v8 by attaching default deep-sky toggles.
 *
 * Same shape as `migrateProfileV6ToV7` one version up: `sky` is a brand-new
 * required object with no prior partial state anywhere in a v7 document to
 * recover from, so this is a whole-document migration rather than a per-field
 * backfill. Everything the player already chose — including their mixer levels —
 * is carried across untouched; only `sky` is new.
 */
function migrateProfileV7ToV8(settings: GameSettingsV7): GameSettingsV8 {
  return freezeV8Settings(
    settings.qualityLock,
    { ...settings.inputBindings },
    settings.tutorial,
    settings.gamepad,
    settings.camera,
    settings.hud,
    settings.render,
    settings.audio,
    DEFAULT_SKY_SETTINGS,
  );
}

/**
 * The full v6->v8 chain, named once.
 *
 * Every storage tier below v7 has to climb through audio to reach the sky, and
 * spelling that nesting out at each of the five call sites is how a tier quietly
 * ends up skipping a generation.
 */
function migrateProfileV6ToV8(settings: GameSettingsV6): GameSettingsV8 {
  return migrateProfileV7ToV8(migrateProfileV6ToV7(settings));
}

/** Projects profile preferences into the stable DTO used by SaveEnvelopeV3. */
export function projectGameSettingsV1(settings: GameSettingsV8): GameSettingsV1 {
  const validated = parseProfileSettings(settings);
  return freezeV1Settings(validated.qualityLock, { ...validated.inputBindings });
}

/**
 * Merges imported save preferences while preserving profile-only state.
 *
 * Tutorial progress, gamepad calibration, camera toggles, HUD preferences and
 * renderer preferences belong to the player's profile, not to a mission someone
 * emailed them, so only the two fields the save DTO actually carries are taken
 * from the import.
 */
export function mergeGameSettingsPreferences(
  profile: GameSettingsV8,
  preferences: GameSettingsV1,
): GameSettingsV8 {
  const validatedProfile = parseProfileSettings(profile);
  const validated = parseGameSettings(preferences);
  return freezeV8Settings(
    validated.qualityLock,
    { ...validated.inputBindings },
    validatedProfile.tutorial,
    validatedProfile.gamepad,
    validatedProfile.camera,
    validatedProfile.hud,
    validatedProfile.render,
    validatedProfile.audio,
    validatedProfile.sky,
  );
}

/** Returns a validated frozen profile with new tutorial progress. */
export function updateTutorialSettings(
  settings: GameSettingsV8,
  tutorial: TutorialProgress,
): GameSettingsV8 {
  return parseProfileSettings({ ...settings, tutorial });
}

/** Returns a validated frozen profile with the chase field-of-view widening toggled. */
export function updateCameraFovWidening(
  settings: GameSettingsV8,
  fovWidening: boolean,
): GameSettingsV8 {
  return parseProfileSettings({ ...settings, camera: { ...settings.camera, fovWidening } });
}

/** Returns a validated frozen profile with the chase camera shake toggled. */
export function updateCameraShake(settings: GameSettingsV8, shake: boolean): GameSettingsV8 {
  return parseProfileSettings({ ...settings, camera: { ...settings.camera, shake } });
}

/**
 * Returns a validated frozen profile with both HUD preferences applied at once.
 *
 * One commit, not two. Applying them separately makes the first commit publish
 * `onSettingsChanged` carrying the *old* value of the second field, and any
 * listener that mirrors settings back into live state — `main.ts` does, so the
 * settings panel and the HUD key agree — then overwrites the change that had
 * not been committed yet. The second write reads the clobbered value back and
 * persists it, so the toggle silently does nothing.
 */
export function updateHudSettings(
  settings: GameSettingsV8,
  preset: HudPreset,
  bodyLabels: boolean,
): GameSettingsV8 {
  return parseProfileSettings({ ...settings, hud: { preset, bodyLabels } });
}

/** Returns a validated frozen profile with a new HUD preset. */
export function updateHudPreset(settings: GameSettingsV8, preset: HudPreset): GameSettingsV8 {
  return parseProfileSettings({ ...settings, hud: { ...settings.hud, preset } });
}

/** Returns a validated frozen profile with the world body labels toggled. */
export function updateHudBodyLabels(settings: GameSettingsV8, bodyLabels: boolean): GameSettingsV8 {
  return parseProfileSettings({ ...settings, hud: { ...settings.hud, bodyLabels } });
}

/** Returns a validated frozen profile with a new exposure mode (T0127). */
export function updateRenderExposureMode(
  settings: GameSettingsV8,
  exposureMode: ExposureMode,
): GameSettingsV8 {
  return parseProfileSettings({ ...settings, render: { ...settings.render, exposureMode } });
}

/** Returns a validated frozen profile with one mixer bus level changed. */
export function updateAudioLevel(
  settings: GameSettingsV8,
  bus: AudioBus,
  level: number,
): GameSettingsV8 {
  return parseProfileSettings({ ...settings, audio: { ...settings.audio, [bus]: level } });
}

/** Returns a validated frozen profile with the Kubrick-mode music policy toggled. */
export function updateAudioExteriorMusic(
  settings: GameSettingsV8,
  exteriorMusic: boolean,
): GameSettingsV8 {
  return parseProfileSettings({ ...settings, audio: { ...settings.audio, exteriorMusic } });
}

/** Returns a validated frozen profile with the Milky Way panorama toggled. */
export function updateSkyPanorama(settings: GameSettingsV8, panorama: boolean): GameSettingsV8 {
  return parseProfileSettings({ ...settings, sky: { ...settings.sky, panorama } });
}

/** Returns a validated frozen profile with the zodiacal-light gradient toggled. */
export function updateSkyZodiacalLight(
  settings: GameSettingsV8,
  zodiacalLight: boolean,
): GameSettingsV8 {
  return parseProfileSettings({ ...settings, sky: { ...settings.sky, zodiacalLight } });
}

/** Returns a validated frozen profile with the constellation-line figures toggled. */
export function updateSkyConstellations(
  settings: GameSettingsV8,
  constellations: boolean,
): GameSettingsV8 {
  return parseProfileSettings({ ...settings, sky: { ...settings.sky, constellations } });
}

/** Returns a validated frozen profile with one input action rebound. */
export function rebindInput(
  settings: GameSettingsV8,
  action: InputAction,
  code: string,
): GameSettingsV8 {
  const nextBindings = { ...settings.inputBindings, [action]: code };
  return parseProfileSettings({ ...settings, inputBindings: nextBindings });
}

/** Returns a validated frozen profile with the global gamepad deadzone updated. */
export function updateGamepadDeadzone(settings: GameSettingsV8, deadzone: number): GameSettingsV8 {
  return parseProfileSettings({ ...settings, gamepad: { ...settings.gamepad, deadzone } });
}

/** Returns a validated frozen profile with the global gamepad response-curve exponent updated. */
export function updateGamepadCurveExponent(
  settings: GameSettingsV8,
  curveExponent: number,
): GameSettingsV8 {
  return parseProfileSettings({ ...settings, gamepad: { ...settings.gamepad, curveExponent } });
}

/** Returns a validated frozen profile with one gamepad axis's invert flag updated. */
export function updateGamepadAxisInvert(
  settings: GameSettingsV8,
  axis: GamepadAxisId,
  invert: boolean,
): GameSettingsV8 {
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
  settings: GameSettingsV8,
  axis: GamepadAxisId,
  sensitivity: number,
): GameSettingsV8 {
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

    // Tier 2: the v7 key (T0144's era, pre-deep-sky). One step up, then persist
    // forward to the current key so the mixer levels a player already chose are
    // never quietly replaced by defaults.
    let legacyV7Text: string | null;
    try {
      legacyV7Text = this.storage.getItem(LEGACY_V7_SETTINGS_STORAGE_KEY);
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to read settings: ${describeError(error)}`,
      };
    }
    if (legacyV7Text !== null) {
      return this.migrateForward(() =>
        migrateProfileV7ToV8(parseProfileSettingsV7(JSON.parse(legacyV7Text as string) as unknown)),
      );
    }

    // Tier 3: the v6 key (T0127 era, pre-audio). Migrate up two steps and persist
    // forward to the current key.
    let legacyV6Text: string | null;
    try {
      legacyV6Text = this.storage.getItem(LEGACY_V6_SETTINGS_STORAGE_KEY);
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to read settings: ${describeError(error)}`,
      };
    }
    if (legacyV6Text !== null) {
      return this.migrateForward(() =>
        migrateProfileV6ToV8(parseProfileSettingsV6(JSON.parse(legacyV6Text as string) as unknown)),
      );
    }

    // Tier 4: the v5 key (T0112's era, pre-exposure-mode). Migrate up three steps
    // and persist forward to the current key.
    let legacyV5Text: string | null;
    try {
      legacyV5Text = this.storage.getItem(LEGACY_V5_SETTINGS_STORAGE_KEY);
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to read settings: ${describeError(error)}`,
      };
    }
    if (legacyV5Text !== null) {
      return this.migrateForward(() =>
        migrateProfileV6ToV8(
          migrateProfileV5ToV6(
            parseProfileSettingsV5(JSON.parse(legacyV5Text as string) as unknown),
          ),
        ),
      );
    }

    // Tier 5: the v4 key (T0110's era, pre-HUD-preset). Migrate up four steps and
    // persist forward to the current key.
    let legacyV4Text: string | null;
    try {
      legacyV4Text = this.storage.getItem(LEGACY_V4_SETTINGS_STORAGE_KEY);
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to read settings: ${describeError(error)}`,
      };
    }
    if (legacyV4Text !== null) {
      return this.migrateForward(() =>
        migrateProfileV6ToV8(
          migrateProfileV5ToV6(
            migrateProfileV4ToV5(
              parseProfileSettingsV4(JSON.parse(legacyV4Text as string) as unknown),
            ),
          ),
        ),
      );
    }

    // Tier 6: the v3 key (T0106's era, pre-camera). Migrate up five steps and
    // persist forward to the current key.
    let legacyV3Text: string | null;
    try {
      legacyV3Text = this.storage.getItem(LEGACY_V3_SETTINGS_STORAGE_KEY);
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to read settings: ${describeError(error)}`,
      };
    }
    if (legacyV3Text !== null) {
      return this.migrateForward(() =>
        migrateProfileV6ToV8(
          migrateProfileV5ToV6(
            migrateProfileV4ToV5(
              migrateProfileV3ToV4(
                parseProfileSettingsV3(JSON.parse(legacyV3Text as string) as unknown),
              ),
            ),
          ),
        ),
      );
    }

    // Tier 7: the v2 key (T0108's era, pre-gamepad). Migrate up six steps and
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
      return this.migrateForward(() =>
        migrateProfileV6ToV8(
          migrateProfileV5ToV6(
            migrateProfileV4ToV5(
              migrateProfileV3ToV4(
                migrateProfileV2ToV3(
                  parseProfileSettingsV2(JSON.parse(legacyV2Text as string) as unknown),
                ),
              ),
            ),
          ),
        ),
      );
    }

    // Tier 8: the v1 key (pre-T0108, standalone-profile era). Migrate up seven
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

    return this.migrateForward(
      () =>
        migrateProfileV6ToV8(
          migrateProfileV5ToV6(
            migrateProfileV4ToV5(
              migrateProfileV3ToV4(
                migrateProfileV2ToV3(
                  migrateLegacySettings(
                    parseGameSettings(JSON.parse(legacyV1Text as string) as unknown),
                  ),
                ),
              ),
            ),
          ),
        ),
      'legacy settings',
    );
  }

  /**
   * Runs one migration tier: parse, then persist forward under the current key.
   *
   * Every tier does exactly this, and each added generation made the copy-paste
   * version of it longer; sharing it means a new generation adds one `if` block
   * instead of another twenty lines of identical error plumbing. (T0112's v5
   * tier was the first to cash that in; T0127's v6 tier was the second.)
   */
  private migrateForward(migrate: () => GameSettingsV8, label = 'settings'): SettingsLoadResult {
    let migrated: GameSettingsV8;
    try {
      migrated = migrate();
    } catch (error: unknown) {
      return {
        ok: false,
        settings: DEFAULT_GAME_SETTINGS,
        error: `Unable to parse ${label}: ${describeError(error)}`,
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

  save(settings: GameSettingsV8): SettingsSaveResult {
    try {
      const validated = parseProfileSettings(settings);
      this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validated));
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: `Unable to save settings: ${describeError(error)}` };
    }
  }
}
