import { describe, expect, it } from 'vitest';

import {
  TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY,
  TRAJECTORY_PREDICTION_TEST_HORIZON_PROPERTY,
  TRAJECTORY_PREDICTION_TEST_POINT_COUNT_PROPERTY,
  isTrajectoryPredictionRuntimeEnabled,
  readTrajectoryPredictionTestHorizonSec,
  readTrajectoryPredictionTestPointCount,
} from './trajectoryPredictionRuntimePolicy.js';

describe('trajectory prediction runtime policy', () => {
  it('is enabled by default and only honors the exact test-disable sentinel', () => {
    expect(isTrajectoryPredictionRuntimeEnabled({})).toBe(true);
    expect(
      isTrajectoryPredictionRuntimeEnabled({
        [TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY]: false,
      }),
    ).toBe(true);
    expect(
      isTrajectoryPredictionRuntimeEnabled({
        [TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY]: 'true',
      }),
    ).toBe(true);
    expect(
      isTrajectoryPredictionRuntimeEnabled({
        [TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY]: true,
      }),
    ).toBe(false);
  });

  it('returns only a finite positive test horizon sentinel', () => {
    expect(readTrajectoryPredictionTestHorizonSec({})).toBeUndefined();
    expect(
      readTrajectoryPredictionTestHorizonSec({
        [TRAJECTORY_PREDICTION_TEST_HORIZON_PROPERTY]: '21600',
      }),
    ).toBeUndefined();
    expect(
      readTrajectoryPredictionTestHorizonSec({
        [TRAJECTORY_PREDICTION_TEST_HORIZON_PROPERTY]: 0,
      }),
    ).toBeUndefined();
    expect(
      readTrajectoryPredictionTestHorizonSec({
        [TRAJECTORY_PREDICTION_TEST_HORIZON_PROPERTY]: 21_600,
      }),
    ).toBe(21_600);
  });

  it('returns only an integer test point count in the predictor bounds', () => {
    expect(readTrajectoryPredictionTestPointCount({})).toBeUndefined();
    expect(
      readTrajectoryPredictionTestPointCount({
        [TRAJECTORY_PREDICTION_TEST_POINT_COUNT_PROPERTY]: '128',
      }),
    ).toBeUndefined();
    expect(
      readTrajectoryPredictionTestPointCount({
        [TRAJECTORY_PREDICTION_TEST_POINT_COUNT_PROPERTY]: 1,
      }),
    ).toBeUndefined();
    expect(
      readTrajectoryPredictionTestPointCount({
        [TRAJECTORY_PREDICTION_TEST_POINT_COUNT_PROPERTY]: 128.5,
      }),
    ).toBeUndefined();
    expect(
      readTrajectoryPredictionTestPointCount({
        [TRAJECTORY_PREDICTION_TEST_POINT_COUNT_PROPERTY]: 128,
      }),
    ).toBe(128);
  });
});
