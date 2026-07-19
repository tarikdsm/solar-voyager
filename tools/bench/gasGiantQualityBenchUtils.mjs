export function qualityMeasurementPlan(timerQueryAvailable) {
  if (typeof timerQueryAvailable !== 'boolean') {
    throw new TypeError('Timer-query availability must be boolean.');
  }
  return timerQueryAvailable
    ? { enforceMinimumCheaper: true, limitation: null, method: 'gpu-timer' }
    : {
        enforceMinimumCheaper: false,
        limitation: 'EXT_disjoint_timer_query_webgl2 unavailable; recorded CPU frame-work timing.',
        method: 'cpu-frame-work',
      };
}
