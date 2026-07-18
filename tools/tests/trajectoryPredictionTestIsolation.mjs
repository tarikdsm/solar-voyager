const TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY =
  '__solarVoyagerTestDisableTrajectoryPrediction';

/** Prevents unrelated browser contracts from competing with the 90-day worker job. */
export async function disableUnrelatedTrajectoryPrediction(page) {
  await page.addInitScript((property) => {
    Object.defineProperty(globalThis, property, { configurable: true, value: true });
  }, TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY);
}
