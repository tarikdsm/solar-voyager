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
