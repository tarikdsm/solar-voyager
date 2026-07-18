export const TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY =
  '__solarVoyagerTestDisableTrajectoryPrediction';
export const TRAJECTORY_PREDICTION_TEST_HORIZON_PROPERTY = '__solarVoyagerTestTrajectoryHorizonSec';

/** Keeps unrelated browser contracts from competing with the long-horizon test worker. */
export function isTrajectoryPredictionRuntimeEnabled(host: object): boolean {
  return Reflect.get(host, TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY) !== true;
}

/** Reads the browser-test-only prediction horizon without enabling string coercion. */
export function readTrajectoryPredictionTestHorizonSec(host: object): number | undefined {
  const value = Reflect.get(host, TRAJECTORY_PREDICTION_TEST_HORIZON_PROPERTY);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
