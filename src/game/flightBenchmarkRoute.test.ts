import { describe, expect, it } from 'vitest';

import { createFlightBenchmarkRoute } from './flightBenchmarkRoute.js';

describe('createFlightBenchmarkRoute', () => {
  it('creates valid simulation checkpoints for the complete 180-second route', () => {
    const route = createFlightBenchmarkRoute();

    expect(route.map(({ simTimeSec, targetBodyId }) => ({ simTimeSec, targetBodyId }))).toEqual([
      { simTimeSec: 0, targetBodyId: 'earth' },
      { simTimeSec: 60, targetBodyId: 'moon' },
      { simTimeSec: 120, targetBodyId: 'jupiter' },
      { simTimeSec: 180, targetBodyId: 'jupiter' },
    ]);
    expect(route.map((checkpoint) => checkpoint.dominantBodyId)).toEqual([
      'earth',
      'moon',
      'jupiter',
      'jupiter',
    ]);
    expect(route.map((checkpoint) => checkpoint.distanceToTargetKm)).toEqual([
      6_771.0084, 2_737.4, 219_911, 219_911,
    ]);
    for (const checkpoint of route) {
      const save = JSON.parse(checkpoint.saveJson) as {
        simulation: { simTimeSec: number; targetBodyId: string };
        settings: { qualityLock: string };
      };
      expect(save.simulation.simTimeSec).toBe(checkpoint.simTimeSec);
      expect(save.simulation.targetBodyId).toBe(checkpoint.targetBodyId);
      expect(save.settings.qualityLock).toBe('high');
    }
  });

  it('is byte-for-byte deterministic for the fixed route', () => {
    expect(createFlightBenchmarkRoute()).toEqual(createFlightBenchmarkRoute());
  });
});
