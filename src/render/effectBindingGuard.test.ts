import { describe, expect, it, vi } from 'vitest';

import {
  createEffectBindingDegradeState,
  createEffectBindingTelemetry,
  degradeEffectBinding,
  restoreEffectBinding,
} from './effectBindingGuard.js';

describe('effect binding guard', () => {
  it('starts with a clear flag and no degraded bindings', () => {
    const telemetry = createEffectBindingTelemetry();

    expect(telemetry).toEqual({
      degradedBindingCount: 0,
      lastDegradedLabel: null,
      nonFiniteObserved: false,
      skippedBindCount: 0,
    });
  });

  it('rejects an unlabelled binding', () => {
    expect(() => createEffectBindingDegradeState('')).toThrow(RangeError);
  });

  it('warns exactly once per binding while counting every skipped frame', () => {
    const telemetry = createEffectBindingTelemetry();
    const binding = createEffectBindingDegradeState('plume');
    const warn = vi.fn();

    degradeEffectBinding(telemetry, binding, warn);
    degradeEffectBinding(telemetry, binding, warn);
    degradeEffectBinding(telemetry, binding, warn);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('plume');
    expect(telemetry.skippedBindCount).toBe(3);
    expect(telemetry.degradedBindingCount).toBe(1);
    expect(telemetry.nonFiniteObserved).toBe(true);
    expect(telemetry.lastDegradedLabel).toBe('plume');
  });

  it('counts each degraded binding once and names the most recent one', () => {
    const telemetry = createEffectBindingTelemetry();
    const plume = createEffectBindingDegradeState('plume');
    const marker = createEffectBindingDegradeState('target-marker');
    const warn = vi.fn();

    degradeEffectBinding(telemetry, plume, warn);
    degradeEffectBinding(telemetry, marker, warn);
    degradeEffectBinding(telemetry, plume, warn);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(telemetry.degradedBindingCount).toBe(2);
    expect(telemetry.skippedBindCount).toBe(3);
    expect(telemetry.lastDegradedLabel).toBe('plume');
  });

  it('clears the live count on recovery but never the evidence', () => {
    const telemetry = createEffectBindingTelemetry();
    const binding = createEffectBindingDegradeState('skybox');
    const warn = vi.fn();

    degradeEffectBinding(telemetry, binding, warn);
    restoreEffectBinding(telemetry, binding);

    expect(telemetry.degradedBindingCount).toBe(0);
    expect(telemetry.nonFiniteObserved).toBe(true);
    expect(telemetry.skippedBindCount).toBe(1);
    expect(telemetry.lastDegradedLabel).toBe('skybox');

    restoreEffectBinding(telemetry, binding);
    expect(telemetry.degradedBindingCount).toBe(0);
  });

  it('does not re-warn a binding that recovered and failed again', () => {
    const telemetry = createEffectBindingTelemetry();
    const binding = createEffectBindingDegradeState('rcs-puff');
    const warn = vi.fn();

    degradeEffectBinding(telemetry, binding, warn);
    restoreEffectBinding(telemetry, binding);
    degradeEffectBinding(telemetry, binding, warn);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(telemetry.degradedBindingCount).toBe(1);
    expect(telemetry.skippedBindCount).toBe(2);
  });
});
