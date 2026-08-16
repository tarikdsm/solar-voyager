import { describe, expect, it } from 'vitest';

import type { InputAction, InputFrame } from '../input/inputEngine.js';
import { HudInputRouter } from './hudInputRouter.js';

function frameWith(counts: Partial<Record<InputAction, number>>): InputFrame {
  return {
    lookYawRad: 0,
    lookPitchRad: 0,
    axes: { pitch: 0, yaw: 0, roll: 0, throttle: 0 },
    pressed: (action) => (counts[action] ?? 0) > 0,
    pressCount: (action) => counts[action] ?? 0,
    held: () => false,
  };
}

function recordingRouter() {
  const calls: string[] = [];
  const router = new HudInputRouter({
    cyclePreset: () => calls.push('cycle'),
    toggleBodyLabels: () => calls.push('labels'),
  });
  return { calls, router };
}

describe('HUD input router - T0112', () => {
  it('ignores a frame with no HUD presses', () => {
    const { calls, router } = recordingRouter();
    router.apply(frameWith({ throttleIncrease: 3 }));
    expect(calls).toEqual([]);
  });

  /**
   * Press *count*, not the boolean. Two taps between polls are two ring steps,
   * exactly as the warp ladder already treats its keys — otherwise a fast double
   * tap would silently lose one.
   */
  it('steps the ring once per press in the frame', () => {
    const { calls, router } = recordingRouter();
    router.apply(frameWith({ hudPresetCycle: 2 }));
    expect(calls).toEqual(['cycle', 'cycle']);
  });

  it('toggles labels on odd press counts and leaves them alone on even ones', () => {
    const { calls, router } = recordingRouter();
    router.apply(frameWith({ hudBodyLabelsToggle: 1 }));
    expect(calls).toEqual(['labels']);
    // A toggle is idempotent in pairs: two presses between polls are a no-op, not
    // two flips that happen to land back where they started.
    router.apply(frameWith({ hudBodyLabelsToggle: 2 }));
    expect(calls).toEqual(['labels']);
    router.apply(frameWith({ hudBodyLabelsToggle: 3 }));
    expect(calls).toEqual(['labels', 'labels']);
  });

  it('routes both actions from one frame', () => {
    const { calls, router } = recordingRouter();
    router.apply(frameWith({ hudPresetCycle: 1, hudBodyLabelsToggle: 1 }));
    expect(calls).toEqual(['cycle', 'labels']);
  });
});
