import { describe, expect, it } from 'vitest';

import {
  TRAJECTORY_PREDICTION_TEST_DISABLE_PROPERTY,
  isTrajectoryPredictionRuntimeEnabled,
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
});
