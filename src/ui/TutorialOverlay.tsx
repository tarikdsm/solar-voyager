import { TUTORIAL_STEP_IDS, type TutorialProgress } from '../game/settings.js';
import type { TutorialController } from '../game/tutorialController.js';

const STEP_HEADINGS = Object.freeze([
  'Select and focus a target',
  'Orbit/zoom · Shift + Arrows/Page Up/Down',
  'Wait for orbit/trajectory data',
  'Prograde/Retrograde, then raise throttle',
  'Set throttle to zero',
  'Choose warp other than 1×',
  'Open the system map',
  'Close the system map',
  'Open Burn log',
  'Performance diagnostics (F3)',
  'Save in Session & settings',
  'Tutorial complete · return to play',
] as const);

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
        class="main-menu tutorial-overlay"
        aria-labelledby="tutorial-title"
      >
        <header>
          <h2 id="tutorial-title">Optional orbital navigation tutorial</h2>
        </header>
        <div class="main-menu-actions">
          <button type="button" class="main-menu-primary" onClick={() => controller.start()}>
            Start tutorial
          </button>
          <button type="button" onClick={() => controller.skip()}>
            Not now
          </button>
        </div>
      </aside>
    );
  }

  const stepIndex = TUTORIAL_STEP_IDS.indexOf(progress.stepId);
  const heading = STEP_HEADINGS[stepIndex] ?? STEP_HEADINGS[0];
  const contextualAction =
    progress.stepId === 'readouts' ? (
      <button
        type="button"
        class="main-menu-primary"
        disabled={!readoutsReady}
        onClick={() => controller.acknowledgeReadouts()}
      >
        I have read them
      </button>
    ) : progress.stepId === 'return-to-play' ? (
      <button type="button" class="main-menu-primary" onClick={() => controller.finish()}>
        Return to play
      </button>
    ) : null;

  return (
    <aside
      id="tutorial-overlay"
      class="main-menu tutorial-overlay"
      aria-labelledby="tutorial-step-title"
    >
      <header>
        <p class="hud-kicker">Step {stepIndex + 1}/12</p>
        <h2 id="tutorial-step-title" tabIndex={-1} ref={focusHeading}>
          {heading}
        </h2>
      </header>
      <div class="main-menu-actions">
        {contextualAction}
        <button type="button" onClick={() => controller.skip()}>
          Skip tutorial
        </button>
      </div>
    </aside>
  );
}
