export type StartupStage =
  | 'boot'
  | 'context'
  | 'star-catalog'
  | 'asset-manifest'
  | 'hero-spheres'
  | 'flight-shaders'
  | 'map-shaders'
  | 'quality'
  | 'post-ready'
  | 'ready'
  | 'failed';

export type StartupQualitySource = 'auto' | 'manual';

export interface StartupResourceMetrics {
  readonly encodedBodyBytes: number;
  readonly programCount: number;
  readonly resourceCount: number;
  readonly transferBytes: number;
}

export interface StartupDiagnostic {
  readonly encodedBodyBytes: number;
  readonly errorCount: number;
  readonly errorMessage: string | null;
  readonly failedStage: string | null;
  readonly firstPlayableMs: number | null;
  readonly probeMeanMs: number | null;
  readonly programCountAtReady: number;
  readonly progress: number;
  readonly qualitySource: StartupQualitySource | null;
  readonly resourceCount: number;
  readonly selectedRung: number;
  readonly stage: StartupStage;
  readonly transferBytes: number;
}

const MILESTONES = Object.freeze([
  'context',
  'star-catalog',
  'asset-manifest',
  'hero-spheres',
  'flight-shaders',
  'map-shaders',
  'quality',
  'post-ready',
  'ready',
] as const);

const PROGRESS = Object.freeze([0.1, 0.2, 0.3, 0.55, 0.7, 0.8, 0.86, 0.96, 1] as const);

type StartupMilestone = (typeof MILESTONES)[number];
type DirectStartupMilestone = Exclude<StartupMilestone, 'quality' | 'ready'>;

function cleanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw.replace(/\s+/gu, ' ').trim();
  return (cleaned.length === 0 ? 'Unknown startup error.' : cleaned).slice(0, 160);
}

function assertMetric(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative integer.`);
  }
}

/** Owns monotonic setup-only evidence without DOM or renderer dependencies. */
export class StartupTracker {
  private readonly startedAtMs: number;
  private milestoneIndex = -1;
  private currentStage: StartupStage = 'boot';
  private currentProgress = 0;
  private currentFailedStage: string | null = null;
  private currentFirstPlayableMs: number | null = null;
  private currentQualitySource: StartupQualitySource | null = null;
  private currentProbeMeanMs: number | null = null;
  private currentSelectedRung = -1;
  private currentEncodedBodyBytes = 0;
  private currentProgramCountAtReady = 0;
  private currentResourceCount = 0;
  private currentTransferBytes = 0;
  private currentErrorCount = 0;
  private currentErrorMessage: string | null = null;

  constructor(startedAtMs: number) {
    if (!Number.isFinite(startedAtMs)) throw new RangeError('Startup start time must be finite.');
    this.startedAtMs = startedAtMs;
  }

  get stage(): StartupStage {
    return this.currentStage;
  }

  get progress(): number {
    return this.currentProgress;
  }

  get failedStage(): string | null {
    return this.currentFailedStage;
  }

  get firstPlayableMs(): number | null {
    return this.currentFirstPlayableMs;
  }

  get qualitySource(): StartupQualitySource | null {
    return this.currentQualitySource;
  }

  get probeMeanMs(): number | null {
    return this.currentProbeMeanMs;
  }

  get selectedRung(): number {
    return this.currentSelectedRung;
  }

  get encodedBodyBytes(): number {
    return this.currentEncodedBodyBytes;
  }

  get programCountAtReady(): number {
    return this.currentProgramCountAtReady;
  }

  get resourceCount(): number {
    return this.currentResourceCount;
  }

  get transferBytes(): number {
    return this.currentTransferBytes;
  }

  get errorCount(): number {
    return this.currentErrorCount;
  }

  get errorMessage(): string | null {
    return this.currentErrorMessage;
  }

  advance(stage: DirectStartupMilestone): void {
    this.move(stage);
  }

  recordQuality(rung: number, source: StartupQualitySource, probeMeanMs: number | null): void {
    if (!Number.isInteger(rung) || rung < 0 || rung > 14) {
      throw new RangeError('Startup quality rung must be an integer from zero to fourteen.');
    }
    if (source === 'manual' && probeMeanMs !== null) {
      throw new RangeError('Manual startup quality must not include probe evidence.');
    }
    if (source === 'auto' && (!Number.isFinite(probeMeanMs) || (probeMeanMs ?? -1) < 0)) {
      throw new RangeError('Automatic startup quality requires finite probe evidence.');
    }
    this.move('quality');
    this.currentSelectedRung = rung;
    this.currentQualitySource = source;
    this.currentProbeMeanMs = probeMeanMs;
  }

  recordReady(nowMs: number, metrics: StartupResourceMetrics): void {
    if (!Number.isFinite(nowMs) || nowMs < this.startedAtMs) {
      throw new RangeError('Startup ready time must be finite and monotonic.');
    }
    assertMetric(metrics.encodedBodyBytes, 'Encoded body bytes');
    assertMetric(metrics.programCount, 'Program count');
    assertMetric(metrics.resourceCount, 'Resource count');
    assertMetric(metrics.transferBytes, 'Transfer bytes');
    this.move('ready');
    this.currentFirstPlayableMs = nowMs - this.startedAtMs;
    this.currentEncodedBodyBytes = metrics.encodedBodyBytes;
    this.currentProgramCountAtReady = metrics.programCount;
    this.currentResourceCount = metrics.resourceCount;
    this.currentTransferBytes = metrics.transferBytes;
  }

  fail(error: unknown): void {
    if (this.currentStage === 'failed' || this.currentStage === 'ready') return;
    this.currentFailedStage = this.currentStage;
    this.currentStage = 'failed';
    this.currentErrorCount += 1;
    this.currentErrorMessage = cleanError(error);
  }

  createDiagnostic(): StartupDiagnostic {
    return createDiagnostic(this);
  }

  private move(stage: StartupMilestone): void {
    if (this.currentStage === 'failed') throw new Error('Startup has already failed.');
    const expected = MILESTONES[this.milestoneIndex + 1];
    if (stage !== expected) {
      throw new Error(`Startup expected ${expected ?? 'no further milestone'}, received ${stage}.`);
    }
    this.milestoneIndex += 1;
    this.currentStage = stage;
    this.currentProgress = PROGRESS[this.milestoneIndex] ?? this.currentProgress;
  }
}

function createDiagnostic(tracker: StartupTracker): StartupDiagnostic {
  return Object.freeze(
    Object.setPrototypeOf(
      {
        get encodedBodyBytes() {
          return tracker.encodedBodyBytes;
        },
        get errorCount() {
          return tracker.errorCount;
        },
        get errorMessage() {
          return tracker.errorMessage;
        },
        get failedStage() {
          return tracker.failedStage;
        },
        get firstPlayableMs() {
          return tracker.firstPlayableMs;
        },
        get probeMeanMs() {
          return tracker.probeMeanMs;
        },
        get programCountAtReady() {
          return tracker.programCountAtReady;
        },
        get progress() {
          return tracker.progress;
        },
        get qualitySource() {
          return tracker.qualitySource;
        },
        get resourceCount() {
          return tracker.resourceCount;
        },
        get selectedRung() {
          return tracker.selectedRung;
        },
        get stage() {
          return tracker.stage;
        },
        get transferBytes() {
          return tracker.transferBytes;
        },
      },
      null,
    ),
  ) as StartupDiagnostic;
}
