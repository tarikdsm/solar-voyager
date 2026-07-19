import { describe, expect, it } from 'vitest';

import type { TutorialProgress } from './settings.js';
import { TutorialController, type TutorialPersistencePort } from './tutorialController.js';

class TutorialMemoryPort implements TutorialPersistencePort {
  progress: TutorialProgress;
  writes = 0;
  fail = false;

  constructor(progress: TutorialProgress) {
    this.progress = progress;
  }

  updateTutorial(update: (current: TutorialProgress) => TutorialProgress): {
    readonly ok: boolean;
  } {
    this.writes += 1;
    if (this.fail) return { ok: false };
    this.progress = update(this.progress);
    return { ok: true };
  }
}

function progress(
  status: TutorialProgress['status'] = 'active',
  stepId: TutorialProgress['stepId'] = 'focus-target',
): TutorialProgress {
  return Object.freeze({ status, stepId });
}

function setup(initial = progress()): {
  readonly controller: TutorialController;
  readonly port: TutorialMemoryPort;
} {
  const port = new TutorialMemoryPort(initial);
  return { controller: new TutorialController(initial, port), port };
}

describe('TutorialController', () => {
  it('completes the accelerated-hardware route only from real ordered observations', () => {
    const { controller, port } = setup();
    const published: TutorialProgress[] = [];
    controller.subscribe((next) => published.push(next));

    expect(controller.observeTargetFocus(true, true)).toBe(true);
    expect(controller.progress.stepId).toBe('camera');

    expect(controller.observeCameraOrbit()).toBe(false);
    expect(controller.observeCameraZoom()).toBe(true);
    expect(controller.progress.stepId).toBe('readouts');

    expect(controller.observeReadouts(true, true)).toBe(false);
    expect(controller.acknowledgeReadouts()).toBe(true);
    expect(controller.progress.stepId).toBe('attitude-thrust');

    expect(controller.observeAttitudeThrust(true, true)).toBe(true);
    expect(controller.observeThrustOff(true, 1)).toBe(true);
    expect(controller.observeWarp(false, true)).toBe(true);
    expect(controller.observeMap(true)).toBe(true);
    expect(controller.observeMap(false)).toBe(true);
    expect(controller.observeBurnLog(true, 1)).toBe(true);
    expect(controller.observePerformance(true, false, false)).toBe(true);
    expect(controller.observeSaveSucceeded()).toBe(true);
    expect(controller.finish()).toBe(true);

    expect(controller.progress).toEqual(progress('completed', 'return-to-play'));
    expect(port.progress).toEqual(controller.progress);
    expect(controller.transitionCount).toBe(12);
    expect(published).toHaveLength(12);
    expect(controller.observerActive).toBe(false);
  });

  it('uses hardware-warning acknowledgement instead of the performance panel when present', () => {
    const { controller } = setup(progress('active', 'performance'));

    expect(controller.observePerformance(true, true, false)).toBe(false);
    expect(controller.progress.stepId).toBe('performance');
    expect(controller.observePerformance(false, true, true)).toBe(true);
    expect(controller.progress.stepId).toBe('save');
  });

  it('ignores incomplete and out-of-order observations without persisting or publishing', () => {
    const { controller, port } = setup();
    let publications = 0;
    controller.subscribe(() => {
      publications += 1;
    });

    expect(controller.observeCameraOrbit()).toBe(false);
    expect(controller.observeReadouts(true, true)).toBe(false);
    expect(controller.observeTargetFocus(true, false)).toBe(false);
    expect(controller.observeTargetFocus(false, true)).toBe(false);
    expect(controller.observeAttitudeThrust(true, true)).toBe(false);
    expect(controller.observeMap(true)).toBe(false);
    expect(controller.finish()).toBe(false);

    expect(controller.progress).toEqual(progress());
    expect(port.writes).toBe(0);
    expect(publications).toBe(0);
  });

  it('does not publish a transition rejected by persistence and can retry it', () => {
    const { controller, port } = setup();
    const published: TutorialProgress[] = [];
    controller.subscribe((next) => published.push(next));
    port.fail = true;

    expect(controller.observeTargetFocus(true, true)).toBe(false);
    expect(controller.progress).toEqual(progress());
    expect(published).toEqual([]);

    port.fail = false;
    expect(controller.observeTargetFocus(true, true)).toBe(true);
    expect(controller.progress.stepId).toBe('camera');
    expect(published).toHaveLength(1);
  });

  it('treats a persistence exception as an atomic rejection', () => {
    const initial = progress();
    const controller = new TutorialController(initial, {
      updateTutorial: () => {
        throw new Error('quota exceeded');
      },
    });

    expect(controller.observeTargetFocus(true, true)).toBe(false);
    expect(controller.progress).toBe(initial);
    expect(controller.transitionCount).toBe(0);
  });

  it('starts an unoffered tutorial and skips while preserving the current step', () => {
    const { controller } = setup(progress('unoffered'));

    expect(controller.start()).toBe(true);
    expect(controller.progress).toEqual(progress('active'));
    expect(controller.observerActive).toBe(true);
    expect(controller.observeTargetFocus(true, true)).toBe(true);
    expect(controller.skip()).toBe(true);
    expect(controller.progress).toEqual(progress('skipped', 'camera'));
    expect(controller.observerActive).toBe(false);
  });

  it('resumes skipped progress and reset restarts every status from focus-target', () => {
    const { controller } = setup(progress('skipped', 'warp'));

    expect(controller.resume()).toBe(true);
    expect(controller.progress).toEqual(progress('active', 'warp'));
    expect(controller.reset()).toBe(true);
    expect(controller.progress).toEqual(progress('active', 'focus-target'));

    expect(controller.skip()).toBe(true);
    expect(controller.reset()).toBe(true);
    expect(controller.progress).toEqual(progress('active', 'focus-target'));
  });

  it('makes thrust-off resumable from current throttle and burn history', () => {
    const { controller } = setup(progress('active', 'thrust-off'));

    expect(controller.observeThrustOff(true, 0)).toBe(false);
    expect(controller.observeThrustOff(false, 1)).toBe(false);
    expect(controller.observeThrustOff(true, 1)).toBe(true);
    expect(controller.progress.stepId).toBe('warp');
  });

  it('makes map-return resumable from the current closed map state', () => {
    const { controller } = setup(progress('active', 'map-return'));

    expect(controller.observeMap(false)).toBe(true);
    expect(controller.progress.stepId).toBe('burn-log');
  });

  it('makes burn-log resumable when the real panel is open with any completed burn', () => {
    const { controller } = setup(progress('active', 'burn-log'));

    expect(controller.observeBurnLog(true, 0)).toBe(false);
    expect(controller.observeBurnLog(false, 4)).toBe(false);
    expect(controller.observeBurnLog(true, 4)).toBe(true);
    expect(controller.progress.stepId).toBe('performance');
  });

  it('requires a non-1x warp while throttle is off on a resumed warp step', () => {
    const { controller } = setup(progress('active', 'warp'));

    expect(controller.observeWarp(false, false)).toBe(false);
    expect(controller.observeWarp(true, true)).toBe(false);
    expect(controller.observeWarp(false, true)).toBe(true);
    expect(controller.progress.stepId).toBe('map-open');
  });

  it('requires valid readouts before acknowledgement even after resume', () => {
    const { controller } = setup(progress('active', 'readouts'));
    let readinessPublications = 0;
    controller.subscribe(() => {
      readinessPublications += 1;
    });

    expect(controller.canAcknowledgeReadouts).toBe(false);
    expect(controller.acknowledgeReadouts()).toBe(false);
    expect(controller.observeReadouts(true, false)).toBe(false);
    expect(controller.canAcknowledgeReadouts).toBe(false);
    expect(controller.acknowledgeReadouts()).toBe(false);
    expect(controller.observeReadouts(true, true)).toBe(false);
    expect(controller.canAcknowledgeReadouts).toBe(true);
    expect(readinessPublications).toBe(1);
    expect(controller.acknowledgeReadouts()).toBe(true);
    expect(controller.canAcknowledgeReadouts).toBe(false);
  });

  it('stops all observation and control transitions in terminal states', () => {
    for (const terminal of ['skipped', 'completed'] as const) {
      const { controller, port } = setup(progress(terminal, 'save'));
      expect(controller.observerActive).toBe(false);

      expect(controller.observeTargetFocus(true, true)).toBe(false);
      expect(controller.observeCameraOrbit()).toBe(false);
      expect(controller.observeCameraZoom()).toBe(false);
      expect(controller.observeReadouts(true, true)).toBe(false);
      expect(controller.acknowledgeReadouts()).toBe(false);
      expect(controller.observeAttitudeThrust(true, true)).toBe(false);
      expect(controller.observeThrustOff(true, 2)).toBe(false);
      expect(controller.observeWarp(false, true)).toBe(false);
      expect(controller.observeMap(true)).toBe(false);
      expect(controller.observeBurnLog(true, 2)).toBe(false);
      expect(controller.observePerformance(true, false, false)).toBe(false);
      expect(controller.observeSaveSucceeded()).toBe(false);
      expect(controller.finish()).toBe(false);
      expect(controller.skip()).toBe(false);
      expect(controller.start()).toBe(false);

      expect(port.writes).toBe(0);
      expect(controller.transitionCount).toBe(0);
    }
  });

  it('unsubscribes a stable listener without affecting other listeners', () => {
    const { controller } = setup();
    let first = 0;
    let second = 0;
    const unsubscribe = controller.subscribe(() => {
      first += 1;
    });
    controller.subscribe(() => {
      second += 1;
    });

    unsubscribe();
    unsubscribe();
    controller.observeTargetFocus(true, true);

    expect(first).toBe(0);
    expect(second).toBe(1);
  });
});
