const TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY =
  '__solarVoyagerTestDisableTrajectoryPrediction';
const TRAJECTORY_PREDICTION_TEST_HORIZON_PROPERTY =
  '__solarVoyagerTestTrajectoryHorizonSec';

/** Prevents unrelated browser contracts from competing with the 90-day worker job. */
export async function disableUnrelatedTrajectoryPrediction(page) {
  await page.addInitScript((property) => {
    Object.defineProperty(globalThis, property, { configurable: true, value: true });
  }, TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY);
}

/** Keeps the real worker/integrator path bounded in the dedicated browser regression. */
export async function installTrajectoryPredictionTestHorizon(page, horizonSec) {
  await page.addInitScript(
    ({ property, value }) => {
      Object.defineProperty(globalThis, property, { configurable: true, value });
    },
    { property: TRAJECTORY_PREDICTION_TEST_HORIZON_PROPERTY, value: horizonSec },
  );
}
