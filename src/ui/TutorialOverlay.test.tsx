import { describe, expect, it, vi } from 'vitest';

import type { TutorialProgress, TutorialStepId } from '../game/settings.js';
import type { TutorialController } from '../game/tutorialController.js';
import { TutorialOverlayView } from './TutorialOverlay.js';

function progress(status: TutorialProgress['status'], stepId: TutorialStepId): TutorialProgress {
  return { status, stepId };
}

function controller(overrides: Partial<TutorialController> = {}): TutorialController {
  return {
    acknowledgeReadouts: vi.fn(() => true),
    finish: vi.fn(() => true),
    progress: progress('active', 'focus-target'),
    skip: vi.fn(() => true),
    start: vi.fn(() => true),
    ...overrides,
  } as unknown as TutorialController;
}

function serialized(stepId: TutorialStepId): string {
  return JSON.stringify(
    TutorialOverlayView({
      controller: controller(),
      focusHeading: () => undefined,
      progress: progress('active', stepId),
      readoutsReady: true,
    }),
  );
}

describe('TutorialOverlay', () => {
  it('renders the opt-in offer with explicit start and not-now actions', () => {
    const tutorial = controller();
    const view = TutorialOverlayView({
      controller: tutorial,
      focusHeading: () => undefined,
      progress: progress('unoffered', 'focus-target'),
      readoutsReady: false,
    });
    const text = JSON.stringify(view);

    expect(text).toContain('Start tutorial');
    expect(text).toContain('Not now');
    const buttons = view?.props.children[2].props.children;
    buttons[0].props.onClick();
    buttons[1].props.onClick();
    expect(tutorial.start).toHaveBeenCalledOnce();
    expect(tutorial.skip).toHaveBeenCalledOnce();
  });

  it('describes every real-control step', () => {
    const expected: Readonly<Record<TutorialStepId, string>> = {
      'focus-target': 'Choose a navigation target',
      camera: 'Orbit and zoom the camera',
      readouts: 'Read the orbit and trajectory',
      'attitude-thrust': 'Hold attitude and apply thrust',
      'thrust-off': 'Complete the burn',
      warp: 'Change time warp',
      'map-open': 'Open the system map',
      'map-return': 'Return to flight',
      'burn-log': 'Inspect the burn log',
      performance: 'Open performance diagnostics',
      save: 'Save the mission',
      'return-to-play': 'Tutorial complete',
    };

    for (const [stepId, heading] of Object.entries(expected)) {
      expect(serialized(stepId as TutorialStepId)).toContain(heading);
    }
  });

  it('keeps readout acknowledgement disabled until real readouts are ready', () => {
    const tutorial = controller();
    const disabled = TutorialOverlayView({
      controller: tutorial,
      focusHeading: () => undefined,
      progress: progress('active', 'readouts'),
      readoutsReady: false,
    });
    const enabled = TutorialOverlayView({
      controller: tutorial,
      focusHeading: () => undefined,
      progress: progress('active', 'readouts'),
      readoutsReady: true,
    });
    const disabledAction = disabled?.props.children[2].props.children[0];
    const enabledAction = enabled?.props.children[2].props.children[0];

    expect(disabledAction.props.disabled).toBe(true);
    expect(enabledAction.props.disabled).toBe(false);
    enabledAction.props.onClick();
    expect(tutorial.acknowledgeReadouts).toHaveBeenCalledOnce();
  });

  it('focuses a non-editable heading and provides skip throughout active guidance', () => {
    const focusHeading = vi.fn();
    const tutorial = controller();
    const view = TutorialOverlayView({
      controller: tutorial,
      focusHeading,
      progress: progress('active', 'warp'),
      readoutsReady: false,
    });
    const heading = view?.props.children[0].props.children[1];
    const skip = view?.props.children[2].props.children.at(-1);

    expect(heading.props.tabIndex).toBe(-1);
    heading.ref({ focus: focusHeading });
    expect(focusHeading).toHaveBeenCalledWith({ focus: focusHeading });
    skip.props.onClick();
    expect(tutorial.skip).toHaveBeenCalledOnce();
  });

  it('finishes explicitly and emits no terminal UI', () => {
    const tutorial = controller();
    const view = TutorialOverlayView({
      controller: tutorial,
      focusHeading: () => undefined,
      progress: progress('active', 'return-to-play'),
      readoutsReady: false,
    });
    const finish = view?.props.children[2].props.children[0];
    finish.props.onClick();

    expect(tutorial.finish).toHaveBeenCalledOnce();
    expect(
      TutorialOverlayView({
        controller: tutorial,
        focusHeading: () => undefined,
        progress: progress('completed', 'return-to-play'),
        readoutsReady: false,
      }),
    ).toBeNull();
    expect(
      TutorialOverlayView({
        controller: tutorial,
        focusHeading: () => undefined,
        progress: progress('skipped', 'camera'),
        readoutsReady: false,
      }),
    ).toBeNull();
  });
});
