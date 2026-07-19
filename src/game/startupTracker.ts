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
  readonly programCountCurrent: number;
  readonly programCountAfterFirstFrame: number | null;
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
type Milestone = (typeof MILESTONES)[number];
type DirectMilestone = Exclude<Milestone, 'quality' | 'ready'>;

/** Owns monotonic setup-only evidence without DOM or renderer dependencies. */
export class StartupTracker {
  stage: StartupStage = 'boot';
  progress = 0;
  failedStage: string | null = null;
  firstPlayableMs: number | null = null;
  qualitySource: StartupQualitySource | null = null;
  probeMeanMs: number | null = null;
  selectedRung = -1;
  encodedBodyBytes = 0;
  programCountAtReady = 0;
  programCountAfterFirstFrame: number | null = null;
  resourceCount = 0;
  transferBytes = 0;
  errorCount = 0;
  errorMessage: string | null = null;
  private index = 0;

  constructor(private readonly startedAtMs: number) {
    if (!Number.isFinite(startedAtMs)) throw new RangeError('Startup time must be finite.');
  }

  advance(stage: DirectMilestone): void {
    this.move(stage);
  }

  recordQuality(rung: number, source: StartupQualitySource, probe: number | null): void {
    if (!Number.isInteger(rung) || rung < 0 || rung > 14) throw new RangeError('Invalid rung.');
    if (
      source === 'manual' ? probe !== null : probe === null || !Number.isFinite(probe) || probe < 0
    ) {
      throw new RangeError(`${source === 'manual' ? 'Manual' : 'Auto'} probe evidence is invalid.`);
    }
    this.move('quality');
    this.selectedRung = rung;
    this.qualitySource = source;
    this.probeMeanMs = probe;
  }

  recordReady(nowMs: number, metrics: StartupResourceMetrics): void {
    if (!Number.isFinite(nowMs) || nowMs < this.startedAtMs)
      throw new RangeError('Invalid ready time.');
    for (const value of Object.values(metrics)) {
      if (!Number.isInteger(value) || value < 0) throw new RangeError('Invalid startup metric.');
    }
    this.move('ready');
    this.firstPlayableMs = nowMs - this.startedAtMs;
    this.encodedBodyBytes = metrics.encodedBodyBytes;
    this.programCountAtReady = metrics.programCount;
    this.resourceCount = metrics.resourceCount;
    this.transferBytes = metrics.transferBytes;
  }

  fail(error: unknown): void {
    if (this.stage === 'failed' || this.stage === 'ready') return;
    this.failedStage = this.stage;
    this.stage = 'failed';
    this.errorCount = 1;
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/gu, ' ')
      .trim();
    this.errorMessage = (message || 'Unknown startup error.').slice(0, 160);
  }

  recordFirstFrameProgramCount(programCount: number): void {
    if (!Number.isInteger(programCount) || programCount < 0) {
      throw new RangeError('Invalid first-frame program count.');
    }
    this.programCountAfterFirstFrame ??= programCount;
  }

  createDiagnostic(readProgramCount = (): number => this.programCountAtReady): StartupDiagnostic {
    return createDiagnostic(this, readProgramCount);
  }

  private move(stage: Milestone): void {
    if (this.stage === 'failed') throw new Error('Startup failed.');
    const expected = MILESTONES[this.index];
    if (stage !== expected) throw new Error(`Startup expected ${expected}, received ${stage}.`);
    this.stage = stage;
    this.progress = PROGRESS[this.index] ?? this.progress;
    this.index += 1;
  }
}

function createDiagnostic(
  state: StartupTracker,
  readProgramCount: () => number,
): StartupDiagnostic {
  return Object.freeze(
    Object.setPrototypeOf(
      {
        get encodedBodyBytes() {
          return state.encodedBodyBytes;
        },
        get errorCount() {
          return state.errorCount;
        },
        get errorMessage() {
          return state.errorMessage;
        },
        get failedStage() {
          return state.failedStage;
        },
        get firstPlayableMs() {
          return state.firstPlayableMs;
        },
        get probeMeanMs() {
          return state.probeMeanMs;
        },
        get programCountCurrent() {
          return readProgramCount();
        },
        get programCountAfterFirstFrame() {
          return state.programCountAfterFirstFrame;
        },
        get programCountAtReady() {
          return state.programCountAtReady;
        },
        get progress() {
          return state.progress;
        },
        get qualitySource() {
          return state.qualitySource;
        },
        get resourceCount() {
          return state.resourceCount;
        },
        get selectedRung() {
          return state.selectedRung;
        },
        get stage() {
          return state.stage;
        },
        get transferBytes() {
          return state.transferBytes;
        },
      },
      null,
    ),
  ) as StartupDiagnostic;
}
