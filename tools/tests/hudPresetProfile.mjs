/**
 * Engineer-preset profile seeding for browser gates (T0112).
 *
 * v2 ships with the **Clean** HUD: the mission-control panels are unmounted
 * until the player asks for them. Gates written before the preset ring exists
 * assert against those panels — `#orbit-readout`, `#dual-clock`, `#warp-control`,
 * `#target-selector`, `#burn-log-toggle`, the state-vector panel — so each one
 * that does declares here that it exercises the Engineer HUD, rather than the
 * default being weakened to keep them green.
 *
 * The document is hand-written at the current profile shape rather than imported
 * from `src/game/settings.ts`: these are browser-side fixtures and importing the
 * app's own constant would let a schema change pass its gate by moving both sides
 * at once. If a future generation renames the key or adds a required field,
 * update this literal — the parse is strict and will say so loudly.
 */

const SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v7';

const DEFAULT_GAMEPAD_AXIS = { invert: false, sensitivity: 1 };

const ENGINEER_PROFILE = JSON.stringify({
  version: 7,
  qualityLock: 'auto',
  inputBindings: {
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
  },
  tutorial: { status: 'skipped', stepId: 'focus-target' },
  gamepad: {
    deadzone: 0.08,
    curveExponent: 1.6,
    axes: {
      pitch: DEFAULT_GAMEPAD_AXIS,
      yaw: DEFAULT_GAMEPAD_AXIS,
      roll: DEFAULT_GAMEPAD_AXIS,
      throttle: DEFAULT_GAMEPAD_AXIS,
    },
  },
  camera: { fovWidening: true, shake: true },
  // Labels off: they are DOM nodes over the canvas and several gates compare
  // screenshots. The preset ring itself is covered by `test:hud-presets`.
  hud: { preset: 'engineer', bodyLabels: false },
  // T0127 — pin the v1 fixed exposure so the screenshot-comparing gates keep a
  // stable key while the adaptive controller runs everywhere else.
  render: { exposureMode: 'fixed' },
  // T0126 — panorama and zodiacal band off: both paint the whole background and
  // several gates compare screenshots. `test:milky-way` covers them switched on.
  sky: { panorama: false, zodiacalLight: false, constellations: false },
});

/** Plants an Engineer-preset profile before the app boots, on every navigation. */
export async function installEngineerHudPreset(page) {
  await page.addInitScript(
    ({ key, value }) => {
      globalThis.localStorage.setItem(key, value);
    },
    { key: SETTINGS_STORAGE_KEY, value: ENGINEER_PROFILE },
  );
}

export { SETTINGS_STORAGE_KEY as HUD_PROFILE_STORAGE_KEY };
