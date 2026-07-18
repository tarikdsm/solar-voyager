import { describe, expect, it } from 'vitest';

import type { TrajectoryEventSummary } from '../game/trajectoryPredictionModel.js';
import { createTrajectoryPredictionSignalStore } from './trajectoryPredictionSignals.js';

const BODY_IDS = Object.freeze(['sun', 'earth', 'moon']);

function summary(overrides: Partial<TrajectoryEventSummary> = {}): TrajectoryEventSummary {
  return {
    closestApproachBodyIndex: 2,
    closestApproachTimeSec: 110,
    closestApproachDistanceKm: 12_345,
    impactBodyIndex: 1,
    impactTimeSec: 120,
    ...overrides,
  };
}

describe('trajectory prediction signals', () => {
  it('shows no target, pending, success, and unavailable states deterministically', () => {
    const store = createTrajectoryPredictionSignalStore();

    store.publishPending(-1);
    expect(store.display.nextClosestApproach.value).toBe('—');
    expect(store.display.impactVisible.value).toBe(false);

    store.publishPending(2);
    expect(store.display.nextClosestApproach.value).toBe('Calculating…');

    store.publishSuccess(summary(), BODY_IDS, 100);
    expect(store.display.nextClosestApproach.value).toBe('12,345 km · T−00:00:10.000');
    expect(store.display.impactVisible.value).toBe(true);
    expect(store.display.impactMessage.value).toBe('Earth impact in 00:00:20.000');

    store.publishError();
    expect(store.display.nextClosestApproach.value).toBe('Prediction unavailable');
    expect(store.display.impactVisible.value).toBe(false);
    expect(store.display.impactMessage.value).toBe('');
  });

  it('samples countdown time at 10 Hz without rebuilding prediction state', () => {
    const store = createTrajectoryPredictionSignalStore();
    store.publishPending(2);
    store.publishSuccess(summary(), BODY_IDS, 100);

    expect(store.publishTime(105, 0)).toBe(true);
    expect(store.display.nextClosestApproach.value).toBe('12,345 km · T−00:00:05.000');
    expect(store.display.impactMessage.value).toBe('Earth impact in 00:00:15.000');

    expect(store.publishTime(106, 50)).toBe(false);
    expect(store.display.impactMessage.value).toBe('Earth impact in 00:00:15.000');

    expect(store.publishTime(106, 100)).toBe(true);
    expect(store.display.impactMessage.value).toBe('Earth impact in 00:00:14.000');
  });

  it('keeps impact hidden when a successful prediction has no impact', () => {
    const store = createTrajectoryPredictionSignalStore();
    store.publishPending(2);
    store.publishSuccess(
      summary({ impactBodyIndex: -1, impactTimeSec: Number.NaN }),
      BODY_IDS,
      100,
    );

    expect(store.display.impactVisible.value).toBe(false);
    expect(store.display.impactMessage.value).toBe('');
  });

  it('rejects invalid body references and sampling times', () => {
    const store = createTrajectoryPredictionSignalStore();

    expect(() => store.publishPending(1.5)).toThrow(/target body index/u);
    expect(() => store.publishSuccess(summary(), BODY_IDS, Number.NaN)).toThrow(/simulation time/u);
    expect(() => store.publishSuccess(summary({ impactBodyIndex: 5 }), BODY_IDS, 100)).toThrow(
      /impact body index/u,
    );
    expect(() => store.publishTime(Number.NaN, 0)).toThrow(/simulation time/u);
    expect(() => store.publishTime(100, Number.NaN)).toThrow(/sample time/u);
  });
});
