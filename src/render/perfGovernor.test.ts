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

function fullWindow(frameCount: number, p75FrameMs: number) {
  return { frameCount, frameSampleCount: 120, p75FrameMs };
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
    expect(QUALITY_PROFILES.map((profile) => profile.ringParticleCount)).toEqual([
      4096, 4096, 4096, 4096, 4096, 2048, 2048, 1024, 1024, 1024, 1024, 1024, 0, 0, 0,
    ]);
    expect(QUALITY_PROFILES.map((profile) => profile.tier)).toEqual([
      6, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1,
    ]);
    expect(QUALITY_PROFILES.map((profile) => profile.upAction)).toEqual([
      'Restored · render scale 1.00',
      'Restored · render scale 0.85',
      'Restored · render scale 0.70',
      'Restored · bloom full resolution',
      'Restored · bloom half resolution',
      'Restored · SMAA',
      'Restored · FXAA',
      'Restored · procedural octaves full',
      'Restored · procedural octaves half',
      'Restored · 9,000 stars',
      'Restored · 4,000 stars',
      'Restored · full textures',
      'Restored · texture cap 2k',
      'Restored · tier-3 threshold',
      'Restored · tier-3 threshold',
    ]);
    expect(Object.isFrozen(QUALITY_PROFILES)).toBe(true);
    expect(QUALITY_PROFILES.every((profile) => Object.isFrozen(profile))).toBe(true);
  });
});

describe('PerfGovernor', () => {
  it('starts auto at the detected rung while a manual lock still wins', () => {
    const autoApplication = { apply: vi.fn() };
    const autoState = createPerfQualityState();
    new PerfGovernor({
      application: autoApplication,
      initialAutoRung: 7,
      state: autoState,
      telemetry: { recordQualityAction: vi.fn() },
    });
    expect(autoState).toMatchObject({ rung: 7, tier: 3 });
    expect(autoApplication.apply).toHaveBeenCalledWith(QUALITY_PROFILES[7]);

    const manualApplication = { apply: vi.fn() };
    const manualState = createPerfQualityState();
    new PerfGovernor({
      application: manualApplication,
      initialAutoRung: 99,
      initialLock: 'high',
      state: manualState,
      telemetry: { recordQualityAction: vi.fn() },
    });
    expect(manualState).toMatchObject({ rung: 0, tier: 6 });
    expect(manualApplication.apply).toHaveBeenCalledWith(QUALITY_PROFILES[0]);
  });

  it('requires two unique over-budget windows and enforces a three-second cooldown', () => {
    const { actions, appliedRungs, governor, state } = fixture();

    expect(governor.update(0, fullWindow(120, 16))).toBe(false);
    expect(governor.update(1, fullWindow(120, 16))).toBe(false);
    expect(governor.update(250, fullWindow(135, 16))).toBe(true);
    expect(state.rung).toBe(1);
    expect(governor.update(500, fullWindow(150, 20))).toBe(false);
    expect(governor.update(3_249, fullWindow(165, 20))).toBe(false);
    expect(governor.update(3_250, fullWindow(180, 20))).toBe(false);
    expect(governor.update(3_500, fullWindow(195, 20))).toBe(true);

    expect(appliedRungs).toEqual([0, 1, 2]);
    expect(actions).toEqual([
      { from: 0, reason: QualityActionReason.OverBudget, time: 250, to: 1 },
      { from: 1, reason: QualityActionReason.OverBudget, time: 3_500, to: 2 },
    ]);
  });

  it('steps up only after ten continuous seconds below the headroom threshold', () => {
    const { governor, state } = fixture('medium');
    governor.setLock('auto', 0);

    expect(governor.update(3_000, fullWindow(120, 10))).toBe(false);
    expect(governor.update(12_999, fullWindow(121, 10))).toBe(false);
    expect(governor.update(13_000, fullWindow(122, 10))).toBe(true);
    expect(state.rung).toBe(6);

    governor.update(16_000, fullWindow(123, 10));
    governor.update(20_000, fullWindow(124, 12));
    governor.update(30_000, fullWindow(125, 10));
    expect(governor.update(39_999, fullWindow(126, 10))).toBe(false);
    expect(state.rung).toBe(6);
  });

  it('makes the manual lock authoritative and resumes auto with a fresh cooldown', () => {
    const { actions, appliedRungs, governor, state } = fixture();
    governor.setLock('low', 100);

    expect(state.rung).toBe(14);
    expect(state.governorState).toBe('Locked · Low');
    for (let sample = 1; sample <= 20; sample += 1) {
      expect(governor.update(sample * 1_000, fullWindow(120 + sample, 5))).toBe(false);
    }
    expect(appliedRungs).toEqual([0, 14]);

    governor.setLock('high', 21_000);
    expect(state.rung).toBe(0);
    governor.setLock('auto', 22_000);
    governor.update(24_999, fullWindow(150, 20));
    governor.update(25_000, fullWindow(151, 20));
    expect(governor.update(25_250, fullWindow(152, 20))).toBe(true);
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
      governor.update(nowMs, fullWindow(frameCount, syntheticP75()));
      nowMs += 250;
    }

    expect(state.rung).toBe(2);
    expect(syntheticP75()).toBeLessThanOrEqual(15.5);
    expect(state.lastAction).toContain('render scale 0.70');
  });

  it('does not accumulate control evidence before the 120-frame window is full', () => {
    const { governor, state } = fixture();

    expect(governor.update(0, { frameCount: 30, frameSampleCount: 30, p75FrameMs: 30 })).toBe(
      false,
    );
    expect(governor.update(250, { frameCount: 60, frameSampleCount: 60, p75FrameMs: 30 })).toBe(
      false,
    );
    expect(governor.update(500, fullWindow(120, 30))).toBe(false);
    expect(governor.update(750, fullWindow(135, 30))).toBe(true);
    expect(state.rung).toBe(1);
  });

  it('rejects invalid clocks and samples without calling collaborators', () => {
    const { governor } = fixture();
    const updateSpy = vi.spyOn(governor, 'update');

    expect(() => governor.update(Number.NaN, fullWindow(120, 10))).toThrow(/time/iu);
    expect(() => governor.update(0, fullWindow(-1, 10))).toThrow(/frame/iu);
    expect(() => governor.update(0, fullWindow(120, Number.NaN))).toThrow(/p75/iu);
    expect(() =>
      governor.update(0, { frameCount: 120, frameSampleCount: 121, p75FrameMs: 10 }),
    ).toThrow(/sample count/iu);
    expect(updateSpy).toHaveBeenCalledTimes(4);
  });
});
