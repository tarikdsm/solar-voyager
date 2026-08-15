// This is `LEGACY_V2_SETTINGS_STORAGE_KEY` in src/game/settings.ts, deliberately
// hand-written and left at the OLD (pre-T0106) v2 shape rather than updated to
// v3 or imported from settings.ts. It exercises SettingsRepository.load()'s
// v2->v3 migration (gamepad defaults backfilled) on every perf-gate/bench run,
// exactly as it already exercised the T0108 binding backfill (13 actions here,
// current registry has more) — see that task's design doc §11 and
// docs/superpowers/specs/2026-08-15-gamepad-design.md's "Settings" section. If
// a future task renames or retires the v2 key, update the literal here too.
const SETTINGS_STORAGE_KEY = 'solar-voyager.settings.v2';
const HIGH_QUALITY_SETTINGS = JSON.stringify({
  version: 2,
  qualityLock: 'high',
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
  },
  tutorial: {
    status: 'skipped',
    stepId: 'focus-target',
  },
});

export async function installHighQualitySetting(page) {
  await page.addInitScript(
    ({ key, value }) => {
      globalThis.localStorage.setItem(key, value);
    },
    { key: SETTINGS_STORAGE_KEY, value: HIGH_QUALITY_SETTINGS },
  );
}
