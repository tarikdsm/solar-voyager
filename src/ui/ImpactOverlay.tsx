import { useComputed } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';

import type { ImpactDisplaySignals } from './impactSignals.js';

/** Actions the freeze overlay offers; both replace the simulation core. */
export interface ImpactOverlayActions {
  onRestore(): void;
  onRespawn(): void;
}

/**
 * ADR-036 freeze overlay: what was hit, how hard, when, and the two ways out.
 *
 * Deliberately minimal — T0112 owns the HUD rebuild and will re-home this. It
 * stays mounted and toggles `hidden` so the signal graph never rebuilds the
 * subtree, matching `TrajectoryImpactWarning`.
 */
export function ImpactOverlay({
  actions,
  display,
}: {
  readonly actions: ImpactOverlayActions;
  readonly display: ImpactDisplaySignals;
}) {
  // Read as a plain value, not a bound signal: focus has to land *after* Preact
  // has removed `hidden`, and a signal subscription fires synchronously on
  // assignment, while the element is still unfocusable. Visibility changes once
  // per crash, so re-rendering this subtree on it costs nothing. The readouts
  // below stay signal-bound, and `restoreEnabled` in particular must, since the
  // restore ring ticks every 10 s.
  const isVisible = display.visible.value;
  const restoreDisabled = useComputed(() => !display.restoreEnabled.value);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    // Move focus into the overlay when it appears, so a keyboard player is not
    // left with focus on a warp button that no longer does anything.
    if (isVisible) heading.current?.focus();
  }, [isVisible]);

  return (
    <section
      id="impact-overlay"
      class="impact-overlay"
      role="alertdialog"
      aria-labelledby="impact-title"
      aria-describedby="impact-summary"
      aria-hidden={!isVisible}
      hidden={!isVisible}
      data-visible={String(isVisible)}
    >
      <h2 id="impact-title" tabIndex={-1} ref={heading}>
        Surface contact
      </h2>
      <dl id="impact-summary" class="impact-summary">
        <div class="impact-row">
          <dt>Body</dt>
          <dd id="impact-body">{display.body}</dd>
        </div>
        <div class="impact-row">
          <dt>Impact speed</dt>
          <dd id="impact-speed">{display.speed}</dd>
        </div>
        <div class="impact-row">
          <dt>Mission time</dt>
          <dd id="impact-mission-time">{display.missionElapsedTime}</dd>
        </div>
        <div class="impact-row">
          <dt>Mission UTC</dt>
          <dd id="impact-utc">{display.coordinateUtc}</dd>
        </div>
      </dl>
      <p class="impact-note">Simulation is frozen. Choose how to continue.</p>
      <div class="impact-actions">
        <button
          type="button"
          id="impact-restore"
          disabled={restoreDisabled}
          onClick={() => actions.onRestore()}
        >
          {display.restoreLabel}
        </button>
        <button type="button" id="impact-respawn" onClick={() => actions.onRespawn()}>
          Respawn in orbit
        </button>
      </div>
    </section>
  );
}
