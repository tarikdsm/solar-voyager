import type { TutorialProgress, TutorialStepId } from './settings.js';

export interface TutorialPersistencePort {
  updateTutorial(update: (current: TutorialProgress) => TutorialProgress): { readonly ok: boolean };
}

export type TutorialProgressListener = (progress: TutorialProgress) => void;

const NEXT_STEP: Readonly<Partial<Record<TutorialStepId, TutorialStepId>>> = Object.freeze({
  'focus-target': 'camera',
  camera: 'readouts',
  readouts: 'attitude-thrust',
  'attitude-thrust': 'thrust-off',
  'thrust-off': 'warp',
  warp: 'map-open',
  'map-open': 'map-return',
  'map-return': 'burn-log',
  'burn-log': 'performance',
  performance: 'save',
  save: 'return-to-play',
});

function createProgress(
  status: TutorialProgress['status'],
  stepId: TutorialStepId,
): TutorialProgress {
  return Object.freeze({ status, stepId });
}

/**
 * DOM-free tutorial state machine. It observes real gameplay facts and delegates
 * every durable transition to the profile-settings owner before publishing it.
 */
export class TutorialController {
  private currentProgress: TutorialProgress;
  private readonly persistence: TutorialPersistencePort;
  private readonly listeners = new Set<TutorialProgressListener>();
  private completedTransitions = 0;
  private cameraOrbited = false;
  private cameraZoomed = false;
  private readoutsReady = false;

  constructor(initialProgress: TutorialProgress, persistence: TutorialPersistencePort) {
    this.currentProgress = initialProgress;
    this.persistence = persistence;
  }

  get progress(): TutorialProgress {
    return this.currentProgress;
  }

  get transitionCount(): number {
    return this.completedTransitions;
  }

  get observerActive(): boolean {
    return this.currentProgress.status === 'active';
  }

  subscribe(listener: TutorialProgressListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): boolean {
    if (this.currentProgress.status !== 'unoffered') return false;
    return this.commit(createProgress('active', this.currentProgress.stepId));
  }

  skip(): boolean {
    if (this.currentProgress.status !== 'unoffered' && this.currentProgress.status !== 'active') {
      return false;
    }
    return this.commit(createProgress('skipped', this.currentProgress.stepId));
  }

  resume(): boolean {
    if (this.currentProgress.status !== 'skipped') return false;
    return this.commit(createProgress('active', this.currentProgress.stepId));
  }

  reset(): boolean {
    return this.commit(createProgress('active', 'focus-target'));
  }

  observeTargetFocus(hasTarget: boolean, targetIsFocus: boolean): boolean {
    if (!this.isCurrentStep('focus-target') || !hasTarget || !targetIsFocus) return false;
    return this.advance();
  }

  observeCameraOrbit(): boolean {
    if (!this.isCurrentStep('camera')) return false;
    this.cameraOrbited = true;
    return this.advanceCameraWhenReady();
  }

  observeCameraZoom(): boolean {
    if (!this.isCurrentStep('camera')) return false;
    this.cameraZoomed = true;
    return this.advanceCameraWhenReady();
  }

  observeReadouts(orbitValid: boolean, trajectoryComplete: boolean): boolean {
    if (!this.isCurrentStep('readouts')) return false;
    this.readoutsReady = orbitValid && trajectoryComplete;
    return false;
  }

  acknowledgeReadouts(): boolean {
    if (!this.isCurrentStep('readouts') || !this.readoutsReady) return false;
    return this.advance();
  }

  observeAttitudeThrust(attitudeIsNonManual: boolean, throttleActive: boolean): boolean {
    if (!this.isCurrentStep('attitude-thrust') || !attitudeIsNonManual || !throttleActive) {
      return false;
    }
    return this.advance();
  }

  observeThrustOff(throttleIsZero: boolean, completedBurnCount: number): boolean {
    if (!this.isCurrentStep('thrust-off') || !throttleIsZero || completedBurnCount <= 0) {
      return false;
    }
    return this.advance();
  }

  observeWarp(requestedWarpIsOne: boolean, throttleIsZero: boolean): boolean {
    if (!this.isCurrentStep('warp') || requestedWarpIsOne || !throttleIsZero) return false;
    return this.advance();
  }

  observeMap(isOpen: boolean): boolean {
    if (this.isCurrentStep('map-open') && isOpen) return this.advance();
    if (this.isCurrentStep('map-return') && !isOpen) return this.advance();
    return false;
  }

  observeBurnLog(isOpen: boolean, completedBurnCount: number): boolean {
    if (!this.isCurrentStep('burn-log') || !isOpen || completedBurnCount <= 0) return false;
    return this.advance();
  }

  observePerformance(
    panelIsOpen: boolean,
    hardwareWarningPresent: boolean,
    hardwareWarningAcknowledged: boolean,
  ): boolean {
    if (!this.isCurrentStep('performance')) return false;
    const completed = hardwareWarningPresent ? hardwareWarningAcknowledged : panelIsOpen;
    return completed ? this.advance() : false;
  }

  observeSaveSucceeded(): boolean {
    return this.isCurrentStep('save') ? this.advance() : false;
  }

  finish(): boolean {
    if (!this.isCurrentStep('return-to-play')) return false;
    return this.commit(createProgress('completed', 'return-to-play'));
  }

  private isCurrentStep(stepId: TutorialStepId): boolean {
    return this.currentProgress.status === 'active' && this.currentProgress.stepId === stepId;
  }

  private advanceCameraWhenReady(): boolean {
    return this.cameraOrbited && this.cameraZoomed ? this.advance() : false;
  }

  private advance(): boolean {
    const nextStep = NEXT_STEP[this.currentProgress.stepId];
    if (nextStep === undefined) return false;
    return this.commit(createProgress('active', nextStep));
  }

  private commit(next: TutorialProgress): boolean {
    let result: { readonly ok: boolean };
    try {
      result = this.persistence.updateTutorial(() => next);
    } catch {
      return false;
    }
    if (!result.ok) return false;

    this.currentProgress = next;
    this.completedTransitions += 1;
    this.clearStepFacts();
    for (const listener of this.listeners) listener(next);
    return true;
  }

  private clearStepFacts(): void {
    this.cameraOrbited = false;
    this.cameraZoomed = false;
    this.readoutsReady = false;
  }
}
