import type { QualityLock } from '../game/settings.js';
import type { ProceduralSunQuality } from './proceduralSunState.js';

export const AUTO_QUALITY_LOCK: QualityLock = 'auto';
export const QUALITY_TIER_COUNT = 6;
export const QUALITY_OVER_BUDGET_MS = 15.5;
export const QUALITY_HEADROOM_MS = 11;
export const QUALITY_COOLDOWN_MS = 3_000;
export const QUALITY_HEADROOM_DURATION_MS = 10_000;
export const QUALITY_FRAME_WINDOW_SIZE = 120;

export type BloomQuality = 'full' | 'half' | 'off';
export type AntiAliasingQuality = 'smaa' | 'fxaa' | 'off';
export type TextureQualityCap = 'full' | '2k' | '1k';

export interface RenderQualityProfile {
  readonly antiAliasing: AntiAliasingQuality;
  readonly bloom: BloomQuality;
  readonly downAction: string;
  readonly modelThresholdScale: number;
  readonly proceduralQuality: ProceduralSunQuality;
  readonly renderScale: number;
  readonly rung: number;
  readonly starCountCap: number;
  readonly textureCap: TextureQualityCap;
  readonly tier: number;
  readonly upAction: string;
}

function profile(
  rung: number,
  tier: number,
  renderScale: number,
  bloom: BloomQuality,
  antiAliasing: AntiAliasingQuality,
  proceduralQuality: ProceduralSunQuality,
  starCountCap: number,
  textureCap: TextureQualityCap,
  modelThresholdScale: number,
  downAction: string,
  upAction: string,
): RenderQualityProfile {
  return Object.freeze({
    antiAliasing,
    bloom,
    downAction,
    modelThresholdScale,
    proceduralQuality,
    renderScale,
    rung,
    starCountCap,
    textureCap,
    tier,
    upAction,
  });
}

export const QUALITY_PROFILES: readonly RenderQualityProfile[] = Object.freeze([
  profile(
    0,
    6,
    1,
    'full',
    'smaa',
    'full',
    9_000,
    'full',
    1,
    'Startup · full quality',
    'Restored · render scale 1.00',
  ),
  profile(
    1,
    6,
    0.85,
    'full',
    'smaa',
    'full',
    9_000,
    'full',
    1,
    'Reduced · render scale 0.85',
    'Restored · render scale 0.85',
  ),
  profile(
    2,
    6,
    0.7,
    'full',
    'smaa',
    'full',
    9_000,
    'full',
    1,
    'Reduced · render scale 0.70',
    'Restored · render scale 0.70',
  ),
  profile(
    3,
    5,
    0.55,
    'full',
    'smaa',
    'full',
    9_000,
    'full',
    1,
    'Reduced · render scale 0.55',
    'Restored · bloom full resolution',
  ),
  profile(
    4,
    5,
    0.55,
    'half',
    'smaa',
    'full',
    9_000,
    'full',
    1,
    'Reduced · bloom half resolution',
    'Restored · bloom half resolution',
  ),
  profile(
    5,
    4,
    0.55,
    'off',
    'smaa',
    'full',
    9_000,
    'full',
    1,
    'Reduced · bloom off',
    'Restored · SMAA',
  ),
  profile(6, 4, 0.55, 'off', 'fxaa', 'full', 9_000, 'full', 1, 'Reduced · FXAA', 'Restored · FXAA'),
  profile(
    7,
    3,
    0.55,
    'off',
    'off',
    'full',
    9_000,
    'full',
    1,
    'Reduced · anti-aliasing off',
    'Restored · procedural octaves full',
  ),
  profile(
    8,
    3,
    0.55,
    'off',
    'off',
    'half',
    9_000,
    'full',
    1,
    'Reduced · procedural octaves half',
    'Restored · procedural octaves half',
  ),
  profile(
    9,
    2,
    0.55,
    'off',
    'off',
    'minimum',
    9_000,
    'full',
    1,
    'Reduced · procedural octaves minimum',
    'Restored · 9,000 stars',
  ),
  profile(
    10,
    2,
    0.55,
    'off',
    'off',
    'minimum',
    4_000,
    'full',
    1,
    'Reduced · 4,000 stars',
    'Restored · 4,000 stars',
  ),
  profile(
    11,
    2,
    0.55,
    'off',
    'off',
    'minimum',
    2_000,
    'full',
    1,
    'Reduced · 2,000 stars',
    'Restored · full textures',
  ),
  profile(
    12,
    1,
    0.55,
    'off',
    'off',
    'minimum',
    2_000,
    '2k',
    1,
    'Reduced · texture cap 2k',
    'Restored · texture cap 2k',
  ),
  profile(
    13,
    1,
    0.55,
    'off',
    'off',
    'minimum',
    2_000,
    '1k',
    1,
    'Reduced · texture cap 1k',
    'Restored · tier-3 threshold',
  ),
  profile(
    14,
    1,
    0.55,
    'off',
    'off',
    'minimum',
    2_000,
    '1k',
    2,
    'Reduced · tier-3 threshold doubled',
    'Restored · tier-3 threshold',
  ),
]);

export enum QualityActionReason {
  OverBudget = 1,
  Headroom = 2,
  ManualLock = 3,
  AutoResume = 4,
}

export interface PerfQualityState {
  governorState: string;
  lastAction: string;
  renderScale: number;
  rung: number;
  tier: number;
  tierCount: number;
}

export interface RenderQualityApplicationPort {
  apply(profile: RenderQualityProfile): void;
}

export interface QualityActionTelemetryPort {
  recordQualityAction(
    timestampMs: number,
    fromRung: number,
    toRung: number,
    reason: QualityActionReason,
  ): void;
}

export interface PerfGovernorSample {
  readonly frameCount: number;
  readonly frameSampleCount: number;
  readonly p75FrameMs: number;
}

export interface PerfGovernorOptions {
  readonly application: RenderQualityApplicationPort;
  readonly initialLock?: QualityLock;
  readonly state: PerfQualityState;
  readonly telemetry: QualityActionTelemetryPort;
}

const AUTO_MONITORING = 'Auto · monitoring';
const AUTO_COOLDOWN = 'Auto · cooldown';
const AUTO_MINIMUM = 'Auto · minimum quality';
const LOCKED_HIGH = 'Locked · High';
const LOCKED_MEDIUM = 'Locked · Medium';
const LOCKED_LOW = 'Locked · Low';
const AUTO_RESUMED = 'Auto resumed';
const LOCK_HIGH_ACTION = 'Locked · high quality';
const LOCK_MEDIUM_ACTION = 'Locked · medium quality';
const LOCK_LOW_ACTION = 'Locked · low quality';

function lockRung(lock: Exclude<QualityLock, 'auto'>): number {
  return lock === 'high' ? 0 : lock === 'medium' ? 7 : 14;
}

function lockedState(lock: Exclude<QualityLock, 'auto'>): string {
  return lock === 'high' ? LOCKED_HIGH : lock === 'medium' ? LOCKED_MEDIUM : LOCKED_LOW;
}

function lockAction(lock: Exclude<QualityLock, 'auto'>): string {
  return lock === 'high'
    ? LOCK_HIGH_ACTION
    : lock === 'medium'
      ? LOCK_MEDIUM_ACTION
      : LOCK_LOW_ACTION;
}

export function createPerfQualityState(): PerfQualityState {
  return {
    governorState: AUTO_MONITORING,
    lastAction: QUALITY_PROFILES[0]?.downAction ?? 'Startup',
    renderScale: 1,
    rung: 0,
    tier: QUALITY_TIER_COUNT,
    tierCount: QUALITY_TIER_COUNT,
  };
}

/** Allocation-free p75 control loop over immutable render quality profiles. */
export class PerfGovernor {
  private readonly application: RenderQualityApplicationPort;
  private readonly state: PerfQualityState;
  private readonly telemetry: QualityActionTelemetryPort;
  private currentLock: QualityLock;
  private cooldownUntilMs = Number.NEGATIVE_INFINITY;
  private headroomSinceMs = Number.NEGATIVE_INFINITY;
  private lastFrameCount = -1;
  private overBudgetWindows = 0;

  constructor(options: PerfGovernorOptions) {
    this.application = options.application;
    this.state = options.state;
    this.telemetry = options.telemetry;
    this.currentLock = options.initialLock ?? AUTO_QUALITY_LOCK;
    const manualLock =
      this.currentLock === 'auto' ? null : (this.currentLock as Exclude<QualityLock, 'auto'>);
    const initialRung = manualLock === null ? 0 : lockRung(manualLock);
    this.applyProfile(initialRung);
    if (manualLock !== null) {
      this.state.governorState = lockedState(manualLock);
      this.state.lastAction = lockAction(manualLock);
    }
  }

  update(nowMs: number, sample: PerfGovernorSample): boolean {
    this.assertSample(nowMs, sample);
    if (sample.frameCount === this.lastFrameCount) return false;
    this.lastFrameCount = sample.frameCount;
    if (this.currentLock !== AUTO_QUALITY_LOCK) return false;
    if (sample.frameSampleCount < QUALITY_FRAME_WINDOW_SIZE) {
      this.resetEvidence();
      return false;
    }
    if (nowMs < this.cooldownUntilMs) {
      this.resetEvidence();
      return false;
    }
    if (this.state.governorState === AUTO_COOLDOWN) this.state.governorState = AUTO_MONITORING;

    if (sample.p75FrameMs > QUALITY_OVER_BUDGET_MS) {
      this.headroomSinceMs = Number.NEGATIVE_INFINITY;
      this.overBudgetWindows += 1;
      if (this.overBudgetWindows < 2) return false;
      if (this.state.rung >= QUALITY_PROFILES.length - 1) {
        this.overBudgetWindows = 0;
        this.state.governorState = AUTO_MINIMUM;
        return false;
      }
      return this.changeRung(nowMs, this.state.rung + 1, QualityActionReason.OverBudget, true);
    }

    this.overBudgetWindows = 0;
    if (sample.p75FrameMs < QUALITY_HEADROOM_MS && this.state.rung > 0) {
      if (!Number.isFinite(this.headroomSinceMs)) {
        this.headroomSinceMs = nowMs;
        return false;
      }
      if (nowMs - this.headroomSinceMs >= QUALITY_HEADROOM_DURATION_MS) {
        return this.changeRung(nowMs, this.state.rung - 1, QualityActionReason.Headroom, false);
      }
      return false;
    }

    this.headroomSinceMs = Number.NEGATIVE_INFINITY;
    return false;
  }

  setLock(lock: QualityLock, nowMs: number): void {
    if (!Number.isFinite(nowMs)) throw new RangeError('Quality lock time must be finite.');
    if (lock !== 'auto' && lock !== 'low' && lock !== 'medium' && lock !== 'high') {
      throw new RangeError('Unknown quality lock.');
    }
    if (lock === this.currentLock) return;
    const fromRung = this.state.rung;
    this.currentLock = lock;
    this.resetEvidence();
    this.cooldownUntilMs = nowMs + QUALITY_COOLDOWN_MS;
    if (lock === AUTO_QUALITY_LOCK) {
      this.state.governorState = AUTO_COOLDOWN;
      this.state.lastAction = AUTO_RESUMED;
      this.telemetry.recordQualityAction(nowMs, fromRung, fromRung, QualityActionReason.AutoResume);
      return;
    }
    const manualLock = lock as Exclude<QualityLock, 'auto'>;
    const targetRung = lockRung(manualLock);
    this.applyProfile(targetRung);
    this.state.governorState = lockedState(manualLock);
    this.state.lastAction = lockAction(manualLock);
    this.telemetry.recordQualityAction(nowMs, fromRung, targetRung, QualityActionReason.ManualLock);
  }

  private changeRung(
    nowMs: number,
    targetRung: number,
    reason: QualityActionReason,
    steppingDown: boolean,
  ): true {
    const fromRung = this.state.rung;
    this.applyProfile(targetRung);
    const target = QUALITY_PROFILES[targetRung];
    if (target === undefined) throw new Error('Quality profile is missing.');
    this.state.lastAction = steppingDown ? target.downAction : target.upAction;
    this.state.governorState = AUTO_COOLDOWN;
    this.cooldownUntilMs = nowMs + QUALITY_COOLDOWN_MS;
    this.resetEvidence();
    this.telemetry.recordQualityAction(nowMs, fromRung, targetRung, reason);
    return true;
  }

  private applyProfile(rung: number): void {
    const selected = QUALITY_PROFILES[rung];
    if (selected === undefined) throw new RangeError('Quality rung is out of range.');
    this.application.apply(selected);
    this.state.renderScale = selected.renderScale;
    this.state.rung = selected.rung;
    this.state.tier = selected.tier;
    this.state.tierCount = QUALITY_TIER_COUNT;
  }

  private resetEvidence(): void {
    this.overBudgetWindows = 0;
    this.headroomSinceMs = Number.NEGATIVE_INFINITY;
  }

  private assertSample(nowMs: number, sample: PerfGovernorSample): void {
    if (!Number.isFinite(nowMs)) throw new RangeError('Governor sample time must be finite.');
    if (!Number.isInteger(sample.frameCount) || sample.frameCount < 0) {
      throw new RangeError('Governor sample frame count must be a nonnegative integer.');
    }
    if (
      !Number.isInteger(sample.frameSampleCount) ||
      sample.frameSampleCount < 0 ||
      sample.frameSampleCount > QUALITY_FRAME_WINDOW_SIZE
    ) {
      throw new RangeError('Governor frame sample count must be an integer between zero and 120.');
    }
    if (!Number.isFinite(sample.p75FrameMs) || sample.p75FrameMs < 0) {
      throw new RangeError('Governor p75 frame time must be finite and nonnegative.');
    }
  }
}
