import { useComputed, type ReadonlySignal } from '@preact/signals';
import type { ComponentChildren } from 'preact';

import { formatSystemMapBodyLabel } from './systemMapSignals.js';

/**
 * The "set as cruise target" affordance (T0117, spec §7).
 *
 * Mounted twice — inside the space HUD's cruise section and inside the system
 * map panel — because the acceptance asks for the affordance in both views and
 * because a control that exists in only one of them teaches the player that
 * targeting belongs to that view. One component, one write path: both instances
 * call the same `TargetSelectionController`.
 *
 * Clicking a body already targets it in both views. This is the labelled,
 * keyboard-reachable, screen-reader-legible equivalent — and the mount point
 * T0119 inherits: pass its "Engage cruise" button as `children` and it lands
 * beside this one, inside the same `.cruise-target-control` row.
 */

export interface CruiseTargetControlProps {
  /** Disambiguates the two mounts' element ids; also a CSS/state hook. */
  readonly view: 'hud' | 'map';
  /** Body the button would commit; empty string disables it. */
  readonly selectedBodyId: ReadonlySignal<string>;
  /** Already-formatted name of the target the simulation currently carries. */
  readonly targetLabel: ReadonlySignal<string>;
  readonly onSetCruiseTarget: (bodyId: string) => void;
  /** T0119's slot. */
  readonly children?: ComponentChildren;
}

export function CruiseTargetControl({
  view,
  selectedBodyId,
  targetLabel,
  onSetCruiseTarget,
  children,
}: CruiseTargetControlProps) {
  // The body is named in the button itself rather than in a separate legend, so
  // the accessible name is complete without the surrounding text.
  const label = useComputed(() => {
    const bodyId = selectedBodyId.value;
    return bodyId.length === 0
      ? 'Set as cruise target'
      : `Set ${formatSystemMapBodyLabel(bodyId)} as cruise target`;
  });
  const disabled = useComputed(() => selectedBodyId.value.length === 0);
  return (
    <div class="cruise-target-control" data-view={view}>
      <p class="cruise-target-current">
        <span class="hud-kicker">Cruise target</span>
        <strong id={`${view}-cruise-target`}>{targetLabel}</strong>
      </p>
      <button
        id={`${view}-set-cruise-target`}
        class="cruise-target-button"
        type="button"
        disabled={disabled}
        onClick={() => {
          // `peek`, not `value`: reading inside the handler must not subscribe
          // the click callback to the signal.
          const bodyId = selectedBodyId.peek();
          if (bodyId.length > 0) onSetCruiseTarget(bodyId);
        }}
      >
        {label}
      </button>
      {children}
    </div>
  );
}
