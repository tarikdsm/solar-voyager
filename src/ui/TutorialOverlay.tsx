import { TUTORIAL_STEP_IDS, type TutorialProgress } from '../game/settings.js';
import type { TutorialController } from '../game/tutorialController.js';

const STEP_HEADINGS = Object.freeze([
  'Focus a target',
  'Orbit/zoom · Shift + Arrows/Page Up/Down',
  'Read orbit/trajectory data',
  'Choose attitude, raise throttle',
  'Throttle to zero',
  'Change warp from 1×',
  'Open the system map',
  'Close the system map',
  'Open Burn log',
  'Performance (F3)',
  'Save the session',
  'Return to play',
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
  const attempt = (ok: boolean): void => {
    if (!ok) globalThis.alert('Tutorial could not be saved.');
  };

  if (progress.status === 'unoffered') {
    return (
      <aside
        id="tutorial-overlay"
        class="main-menu tutorial-overlay"
        aria-labelledby="tutorial-title"
      >
        <header>
          <h2 id="tutorial-title">Optional navigation tutorial</h2>
        </header>
        <div class="main-menu-actions">
          <button
            type="button"
            class="main-menu-primary"
            onClick={() => attempt(controller.start())}
          >
            Start tutorial
          </button>
          <button type="button" onClick={() => attempt(controller.skip())}>
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
        <button type="button" onClick={() => attempt(controller.skip())}>
          Skip tutorial
        </button>
      </div>
    </aside>
  );
}
