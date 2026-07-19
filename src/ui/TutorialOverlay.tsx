import { useEffect, useRef, useState } from 'preact/hooks';

import type { TutorialProgress, TutorialStepId } from '../game/settings.js';
import type { TutorialController } from '../game/tutorialController.js';

interface TutorialStepCopy {
  readonly heading: string;
  readonly instruction: string;
}

const STEP_COPY: Readonly<Record<TutorialStepId, TutorialStepCopy>> = Object.freeze({
  'focus-target': {
    heading: 'Choose a navigation target',
    instruction: 'Use the target selector, then make that real body the camera focus.',
  },
  camera: {
    heading: 'Orbit and zoom the camera',
    instruction: 'Drag and scroll, or use Shift + Arrow keys and Shift + Page Up or Page Down.',
  },
  readouts: {
    heading: 'Read the orbit and trajectory',
    instruction: 'Wait for a valid osculating orbit and completed trajectory prediction.',
  },
  'attitude-thrust': {
    heading: 'Hold attitude and apply thrust',
    instruction: 'Select Prograde or Retrograde hold, then raise the photon-drive throttle.',
  },
  'thrust-off': {
    heading: 'Complete the burn',
    instruction: 'Return throttle to zero. The real completed burn will be recorded.',
  },
  warp: {
    heading: 'Change time warp',
    instruction: 'With thrust off, select any time-warp tier other than 1×.',
  },
  'map-open': {
    heading: 'Open the system map',
    instruction: 'Open the live system map with its on-screen control.',
  },
  'map-return': {
    heading: 'Return to flight',
    instruction: 'Close the system map to return to the flight instruments.',
  },
  'burn-log': {
    heading: 'Inspect the burn log',
    instruction: 'Open Burn log and find the completed burn you just performed.',
  },
  performance: {
    heading: 'Open performance diagnostics',
    instruction:
      'Press F3 or open the performance panel. If acceleration is disabled, acknowledge its warning instead.',
  },
  save: {
    heading: 'Save the mission',
    instruction: 'Open Session & settings and complete a successful local save.',
  },
  'return-to-play': {
    heading: 'Tutorial complete',
    instruction: 'Your mission state is unchanged. Return to the controls when you are ready.',
  },
});

export interface TutorialOverlayViewProps {
  readonly controller: TutorialController;
  readonly focusHeading: (element: HTMLHeadingElement | null) => void;
  readonly progress: TutorialProgress;
  readonly readoutsReady: boolean;
}

/** Pure tutorial card view; terminal states intentionally produce no node. */
export function TutorialOverlayView({
  controller,
  focusHeading,
  progress,
  readoutsReady,
}: TutorialOverlayViewProps) {
  if (progress.status === 'skipped' || progress.status === 'completed') return null;

  if (progress.status === 'unoffered') {
    return (
      <aside
        id="tutorial-overlay"
        class="tutorial-overlay tutorial-offer"
        aria-labelledby="tutorial-title"
      >
        <header>
          <p class="tutorial-kicker">Optional flight training</p>
          <h2 id="tutorial-title">Learn orbital navigation</h2>
        </header>
        <p>
          Complete a guided first burn with the real simulation. You can skip now and resume from
          Session &amp; settings at any time.
        </p>
        <div class="tutorial-actions">
          <button type="button" class="tutorial-primary" onClick={() => controller.start()}>
            Start tutorial
          </button>
          <button type="button" onClick={() => controller.skip()}>
            Not now
          </button>
        </div>
      </aside>
    );
  }

  const copy = STEP_COPY[progress.stepId];
  const stepIndex = Object.keys(STEP_COPY).indexOf(progress.stepId) + 1;
  const contextualAction =
    progress.stepId === 'readouts' ? (
      <button
        type="button"
        class="tutorial-primary"
        disabled={!readoutsReady}
        onClick={() => controller.acknowledgeReadouts()}
      >
        I have read them
      </button>
    ) : progress.stepId === 'return-to-play' ? (
      <button type="button" class="tutorial-primary" onClick={() => controller.finish()}>
        Return to play
      </button>
    ) : null;

  return (
    <aside id="tutorial-overlay" class="tutorial-overlay" aria-labelledby="tutorial-step-title">
      <header>
        <p class="tutorial-kicker">Flight training · step {stepIndex} of 12</p>
        <h2 id="tutorial-step-title" tabIndex={-1} ref={focusHeading}>
          {copy.heading}
        </h2>
      </header>
      <p>{copy.instruction}</p>
      <div class="tutorial-actions">
        {contextualAction}
        <button type="button" onClick={() => controller.skip()}>
          Skip tutorial
        </button>
      </div>
    </aside>
  );
}

export interface TutorialOverlayProps {
  readonly controller: TutorialController;
}

/** Subscribes only while the card is mounted; App owns terminal-state unmounting. */
export function TutorialOverlay({ controller }: TutorialOverlayProps) {
  const [progress, setProgress] = useState(controller.progress);
  const [, setObservationRevision] = useState(0);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(
    () =>
      controller.subscribe((next) => {
        setProgress(next);
        setObservationRevision((current) => current + 1);
      }),
    [controller],
  );
  useEffect(() => {
    if (progress.status === 'active') heading.current?.focus();
  }, [progress.status, progress.stepId]);

  return (
    <TutorialOverlayView
      controller={controller}
      focusHeading={(element) => {
        heading.current = element;
      }}
      progress={progress}
      readoutsReady={controller.canAcknowledgeReadouts}
    />
  );
}
