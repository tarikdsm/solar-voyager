export const TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY =
  '__solarVoyagerTestDisableTrajectoryPrediction';

/** Keeps unrelated browser contracts from competing with the long-horizon test worker. */
export function isTrajectoryPredictionRuntimeEnabled(host: object): boolean {
  return Reflect.get(host, TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY) !== true;
}
