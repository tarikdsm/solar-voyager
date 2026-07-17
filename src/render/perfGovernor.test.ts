import { describe, expect, it, vi } from 'vitest';

import {
  AUTO_QUALITY_LOCK,
  QUALITY_PROFILES,
  PerfGovernor,
  QualityActionReason,
  createPerfQualityState,
  type QualityActionTelemetryPort,
  type RenderQualityApplicationPort,
} from './perfGovernor.js';

function fixture(initialLock = AUTO_QUALITY_LOCK) {
  const appliedRungs: number[] = [];
  const actions: Array<{ from: number; reason: QualityActionReason; time: number; to: number }> =
    [];
  const application: RenderQualityApplicationPort = {
    apply(profile) {
      appliedRungs.push(profile.rung);
    },
  };
  const telemetry: QualityActionTelemetryPort = {
    recordQualityAction(time, from, to, reason) {
      actions.push({ from, reason, time, to });
    },
  };
  const state = createPerfQualityState();
  const governor = new PerfGovernor({ application, initialLock, state, telemetry });
  return { actions, appliedRungs, governor, state };
}

describe('quality profiles', () => {
  it('walks one ordered knob at a time across all 15 immutable profiles', () => {
    expect(QUALITY_PROFILES).toHaveLength(15);
    expect(QUALITY_PROFILES.map((profile) => profile.renderScale)).toEqual([
      1, 0.85, 0.7, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55,
    ]);
    expect(QUALITY_PROFILES.map((profile) => profile.bloom)).toEqual([
      'full',
      'full',
      'full',
      'full',
      'half',
      'off',
      'off',
      'off',
      'off',
      'off',
      'off',
      'off',
      'off',
      'off',
      'off',
    ]);
    expect(QUALITY_PROFILES.map((profile) => profile.antiAliasing)).toEqual([
      'smaa',
      'smaa',
      'smaa',
      'smaa',
      'smaa',
      'smaa',
      'fxaa',
      'off',
      'off',
      'off',
      'off',
      'off',
      'off',
      'off',
      'off',
    ]);
    expect(QUALITY_PROFILES.map((profile) => profile.proceduralQuality)).toEqual([
      'full',
      'full',
      'full',
      'full',
      'full',
      'full',
      'full',
      'full',
      'half',
      'minimum',
      'minimum',
      'minimum',
      'minimum',
      'minimum',
      'minimum',
    ]);
    expect(QUALITY_PROFILES.map((profile) => profile.starCountCap)).toEqual([
      9_000, 9_000, 9_000, 9_000, 9_000, 9_000, 9_000, 9_000, 9_000, 9_000, 4_000, 2_000, 2_000,
      2_000, 2_000,
    ]);
    expect(QUALITY_PROFILES.map((profile) => profile.textureCap)).toEqual([
      'full',
      'full',
      'full',
      'full',
      'full',
      'full',
      'full',
      'full',
      'full',
      'full',
      'full',
      'full',
      '2k',
      '1k',
      '1k',
    ]);
    expect(QUALITY_PROFILES.map((profile) => profile.modelThresholdScale)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2,
    ]);
    expect(QUALITY_PROFILES.map((profile) => profile.tier)).toEqual([
      6, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1,
    ]);
    expect(Object.isFrozen(QUALITY_PROFILES)).toBe(true);
    expect(QUALITY_PROFILES.every((profile) => Object.isFrozen(profile))).toBe(true);
  });
});

describe('PerfGovernor', () => {
  it('requires two unique over-budget windows and enforces a three-second cooldown', () => {
    const { actions, appliedRungs, governor, state } = fixture();

    expect(governor.update(0, { frameCount: 120, p75FrameMs: 16 })).toBe(false);
    expect(governor.update(1, { frameCount: 120, p75FrameMs: 16 })).toBe(false);
    expect(governor.update(250, { frameCount: 135, p75FrameMs: 16 })).toBe(true);
    expect(state.rung).toBe(1);
    expect(governor.update(500, { frameCount: 150, p75FrameMs: 20 })).toBe(false);
    expect(governor.update(3_249, { frameCount: 165, p75FrameMs: 20 })).toBe(false);
    expect(governor.update(3_250, { frameCount: 180, p75FrameMs: 20 })).toBe(false);
    expect(governor.update(3_500, { frameCount: 195, p75FrameMs: 20 })).toBe(true);

    expect(appliedRungs).toEqual([0, 1, 2]);
    expect(actions).toEqual([
      { from: 0, reason: QualityActionReason.OverBudget, time: 250, to: 1 },
      { from: 1, reason: QualityActionReason.OverBudget, time: 3_500, to: 2 },
    ]);
  });

  it('steps up only after ten continuous seconds below the headroom threshold', () => {
    const { governor, state } = fixture('medium');
    governor.setLock('auto', 0);

    expect(governor.update(3_000, { frameCount: 1, p75FrameMs: 10 })).toBe(false);
    expect(governor.update(12_999, { frameCount: 2, p75FrameMs: 10 })).toBe(false);
    expect(governor.update(13_000, { frameCount: 3, p75FrameMs: 10 })).toBe(true);
    expect(state.rung).toBe(6);

    governor.update(16_000, { frameCount: 4, p75FrameMs: 10 });
    governor.update(20_000, { frameCount: 5, p75FrameMs: 12 });
    governor.update(30_000, { frameCount: 6, p75FrameMs: 10 });
    expect(governor.update(39_999, { frameCount: 7, p75FrameMs: 10 })).toBe(false);
    expect(state.rung).toBe(6);
  });

  it('makes the manual lock authoritative and resumes auto with a fresh cooldown', () => {
    const { actions, appliedRungs, governor, state } = fixture();
    governor.setLock('low', 100);

    expect(state.rung).toBe(14);
    expect(state.governorState).toBe('Locked · Low');
    for (let sample = 1; sample <= 20; sample += 1) {
      expect(governor.update(sample * 1_000, { frameCount: sample, p75FrameMs: 5 })).toBe(false);
    }
    expect(appliedRungs).toEqual([0, 14]);

    governor.setLock('high', 21_000);
    expect(state.rung).toBe(0);
    governor.setLock('auto', 22_000);
    governor.update(24_999, { frameCount: 30, p75FrameMs: 20 });
    governor.update(25_000, { frameCount: 31, p75FrameMs: 20 });
    expect(governor.update(25_250, { frameCount: 32, p75FrameMs: 20 })).toBe(true);
    expect(actions.map((action) => action.reason)).toEqual([
      QualityActionReason.ManualLock,
      QualityActionReason.ManualLock,
      QualityActionReason.AutoResume,
      QualityActionReason.OverBudget,
    ]);
  });

  it('recovers a synthetic 60 FPS load within three rungs and does not oscillate', () => {
    const { governor, state } = fixture();
    let frameCount = 0;
    let nowMs = 0;
    const syntheticP75 = () => (state.rung === 0 ? 20 : state.rung === 1 ? 17 : 14);

    for (let sample = 0; sample < 40; sample += 1) {
      frameCount += 15;
      governor.update(nowMs, { frameCount, p75FrameMs: syntheticP75() });
      nowMs += 250;
    }

    expect(state.rung).toBe(2);
    expect(syntheticP75()).toBeLessThanOrEqual(15.5);
    expect(state.lastAction).toContain('render scale 0.70');
  });

  it('rejects invalid clocks and samples without calling collaborators', () => {
    const { governor } = fixture();
    const updateSpy = vi.spyOn(governor, 'update');

    expect(() => governor.update(Number.NaN, { frameCount: 1, p75FrameMs: 10 })).toThrow(/time/iu);
    expect(() => governor.update(0, { frameCount: -1, p75FrameMs: 10 })).toThrow(/frame/iu);
    expect(() => governor.update(0, { frameCount: 1, p75FrameMs: Number.NaN })).toThrow(/p75/iu);
    expect(updateSpy).toHaveBeenCalledTimes(3);
  });
});
