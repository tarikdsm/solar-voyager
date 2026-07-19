import { TUTORIAL_STEP_IDS, type TutorialProgress, type TutorialStepId } from './settings.js';

export interface TutorialPersistencePort {
  updateTutorial(update: (current: TutorialProgress) => TutorialProgress): { readonly ok: boolean };
}

export type TutorialProgressListener = (progress: TutorialProgress) => void;

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

  get canAcknowledgeReadouts(): boolean {
    return this.isCurrentStep('readouts') && this.readoutsReady;
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
    return this.completeStep('focus-target', hasTarget && targetIsFocus);
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
    const nextReady = orbitValid && trajectoryComplete;
    if (nextReady === this.readoutsReady) return false;
    this.readoutsReady = nextReady;
    this.publishCurrent();
    return false;
  }

  acknowledgeReadouts(): boolean {
    if (!this.isCurrentStep('readouts') || !this.readoutsReady) return false;
    return this.advance();
  }

  observeAttitudeThrust(attitudeIsNonManual: boolean, throttleActive: boolean): boolean {
    return this.completeStep('attitude-thrust', attitudeIsNonManual && throttleActive);
  }

  observeThrustOff(throttleIsZero: boolean, completedBurnCount: number): boolean {
    return this.completeStep('thrust-off', throttleIsZero && completedBurnCount > 0);
  }

  observeWarp(requestedWarpIsOne: boolean, throttleIsZero: boolean): boolean {
    return this.completeStep('warp', !requestedWarpIsOne && throttleIsZero);
  }

  observeMap(isOpen: boolean): boolean {
    return this.completeStep(isOpen ? 'map-open' : 'map-return', true);
  }

  observeBurnLog(isOpen: boolean, completedBurnCount: number): boolean {
    return this.completeStep('burn-log', isOpen && completedBurnCount > 0);
  }

  observePerformance(
    panelIsOpen: boolean,
    hardwareWarningPresent: boolean,
    hardwareWarningAcknowledged: boolean,
  ): boolean {
    return this.completeStep(
      'performance',
      hardwareWarningPresent ? hardwareWarningAcknowledged : panelIsOpen,
    );
  }

  observeSaveSucceeded(): boolean {
    return this.completeStep('save', true);
  }

  finish(): boolean {
    if (!this.isCurrentStep('return-to-play')) return false;
    return this.commit(createProgress('completed', 'return-to-play'));
  }

  private isCurrentStep(stepId: TutorialStepId): boolean {
    return this.currentProgress.status === 'active' && this.currentProgress.stepId === stepId;
  }

  private advanceCameraWhenReady(): boolean {
    return this.completeStep('camera', this.cameraOrbited && this.cameraZoomed);
  }

  private completeStep(stepId: TutorialStepId, condition: boolean): boolean {
    return condition && this.isCurrentStep(stepId) ? this.advance() : false;
  }

  private advance(): boolean {
    const nextStep = TUTORIAL_STEP_IDS[TUTORIAL_STEP_IDS.indexOf(this.currentProgress.stepId) + 1];
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
    this.publishCurrent();
    return true;
  }

  private publishCurrent(): void {
    for (const listener of this.listeners) listener(this.currentProgress);
  }

  private clearStepFacts(): void {
    this.cameraOrbited = false;
    this.cameraZoomed = false;
    this.readoutsReady = false;
  }
}
