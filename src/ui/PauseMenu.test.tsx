import { describe, expect, it } from 'vitest';

import { resolveFocusTrapStep } from './PauseMenu.js';

/**
 * The pause dialog's keyboard contract (T0112).
 *
 * The trap arithmetic is unit-tested here and the DOM half — focus on open, the
 * Tab cycle, `aria-modal` backed by `inert` on the HUD behind — in
 * `tools/tests/hudPresetsRegression.mjs`, because this repo's Vitest runs
 * without a DOM and the component uses hooks, so it cannot be called directly
 * the way `App.test.tsx` calls its hook-free views.
 *
 * These exist because the first implementation attached the Escape handler and
 * the Tab trap in a passive `useEffect` while focus moved in a layout effect, so
 * a Tab arriving in the gap escaped into the HUD behind the dialog — reproduced
 * four times out of four in the production build, and never in a slower
 * sequence. A timing bug that only shows up when the user is fast needs a test
 * that does not depend on timing.
 */

describe('pause focus trap - T0112', () => {
  it('leaves interior Tab presses to the browser', () => {
    expect(resolveFocusTrapStep(4, 1, false)).toEqual({ preventDefault: false, focusIndex: null });
    expect(resolveFocusTrapStep(4, 2, true)).toEqual({ preventDefault: false, focusIndex: null });
  });

  it('wraps forward off the last control and backward off the first', () => {
    expect(resolveFocusTrapStep(4, 3, false)).toEqual({ preventDefault: true, focusIndex: 0 });
    expect(resolveFocusTrapStep(4, 0, true)).toEqual({ preventDefault: true, focusIndex: 3 });
  });

  /**
   * The case that let Tab reach the tutorial overlay: focus was not in the trap
   * at all, so no wrap rule matched and the browser moved on to whatever came
   * next in the document.
   */
  it('pulls focus back in from outside the trap, in the direction of travel', () => {
    expect(resolveFocusTrapStep(4, -1, false)).toEqual({ preventDefault: true, focusIndex: 0 });
    expect(resolveFocusTrapStep(4, -1, true)).toEqual({ preventDefault: true, focusIndex: 3 });
    // An index past the end is the same kind of stale answer and is treated alike.
    expect(resolveFocusTrapStep(4, 9, false)).toEqual({ preventDefault: true, focusIndex: 0 });
  });

  it('does nothing when there is nothing to focus', () => {
    expect(resolveFocusTrapStep(0, -1, false)).toEqual({ preventDefault: false, focusIndex: null });
  });

  it('is a single-element cycle when only one control is focusable', () => {
    expect(resolveFocusTrapStep(1, 0, false)).toEqual({ preventDefault: true, focusIndex: 0 });
    expect(resolveFocusTrapStep(1, 0, true)).toEqual({ preventDefault: true, focusIndex: 0 });
  });
});
