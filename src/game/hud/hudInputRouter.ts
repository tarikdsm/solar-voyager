import type { InputFrame } from '../input/inputEngine.js';

/**
 * Turns one {@link InputFrame} into HUD intent (T0112).
 *
 * The sibling of `flight/flightInputRouter.ts`, and separate from it for the
 * same reason that module exists: exactly one place knows how a polled frame
 * maps onto a subsystem's API. The flight router must not learn about the HUD,
 * and `main.ts` must not grow a second `frame.pressed(...)` switch.
 *
 * Allocation-free, and safe to call on a paused frame: nothing here touches the
 * simulation, and the preset key is deliberately live while paused so the pause
 * menu can be read at any instrumentation level.
 */
export interface HudInputPorts {
  cyclePreset(): void;
  toggleBodyLabels(): void;
}

export class HudInputRouter {
  constructor(private readonly ports: HudInputPorts) {}

  apply(frame: InputFrame): void {
    // Press *count*, not the boolean: two taps between polls are two steps of
    // the ring, exactly as the warp ladder already treats its keys.
    const presetPresses = frame.pressCount('hudPresetCycle');
    for (let press = 0; press < presetPresses; press += 1) this.ports.cyclePreset();
    // A toggle is idempotent in pairs, so an even number of presses is a no-op
    // and only the parity matters.
    if ((frame.pressCount('hudBodyLabelsToggle') & 1) === 1) this.ports.toggleBodyLabels();
  }
}
