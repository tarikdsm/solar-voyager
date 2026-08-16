import { useComputed, type ReadonlySignal, type Signal } from '@preact/signals';

import type {
  BodyLabelSlotSignals,
  HudDisplaySignals,
  WorldMarkerSignals,
  WorldMarkerSlotSignals,
} from './hudSignals.js';

interface PositionedSlot {
  readonly xPx: Signal<number>;
  readonly yPx: Signal<number>;
}

/**
 * The in-world marker layer (T0112, spec §7 "In-world markers").
 *
 * Elite-style navigation drawn in the DOM rather than the scene: the target
 * diamond with its distance, the prograde/retrograde pair, and body labels. Every
 * position arrives as a leaf signal from `HudSignalStore`, projected in `game/`
 * from float64 positions — nothing here knows about three.js, and nothing here
 * raycasts.
 *
 * Only `transform` and `opacity` animate, per the performance contract: a marker
 * that moves does not invalidate layout.
 */

/**
 * One signal carrying the whole inline style.
 *
 * Preact only accepts a signal for a *prop*, not for a nested style property, so
 * the declaration is built as text. It is also the cheaper shape: one string per
 * moved marker per sample instead of one object plus one string.
 */
function markerStyle(slot: PositionedSlot): ReadonlySignal<string> {
  return useComputed(
    () =>
      `transform:translate3d(${String(Math.round(slot.xPx.value))}px,${String(Math.round(slot.yPx.value))}px,0)`,
  );
}

function TargetMarker({
  markers,
  distance,
}: {
  readonly markers: WorldMarkerSignals;
  readonly distance: ReadonlySignal<string>;
}) {
  const slot = markers.target;
  const style = markerStyle(slot);
  const hidden = useComputed(() => !slot.visible.value);
  const state = useComputed(() =>
    slot.behind.value ? 'behind' : slot.offscreen.value ? 'offscreen' : 'onscreen',
  );
  return (
    <div
      id="world-marker-target"
      class="world-marker world-marker-target"
      data-state={state}
      style={style}
      hidden={hidden}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width="24" height="24" focusable="false">
        <path class="world-marker-diamond" d="M12 2 L22 12 L12 22 L2 12 Z" />
      </svg>
      <span class="world-marker-distance">{distance}</span>
    </div>
  );
}

function VelocityMarker({
  id,
  kind,
  slot,
}: {
  readonly id: string;
  readonly kind: 'prograde' | 'retrograde';
  readonly slot: WorldMarkerSlotSignals;
}) {
  const style = markerStyle(slot);
  const hidden = useComputed(() => !slot.visible.value);
  return (
    <div
      id={id}
      class={`world-marker world-marker-${kind}`}
      style={style}
      hidden={hidden}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" focusable="false">
        <circle class="world-marker-ring" cx="12" cy="12" r="7" />
        {kind === 'prograde' ? (
          <circle class="world-marker-pip" cx="12" cy="12" r="2.5" />
        ) : (
          <path class="world-marker-cross" d="M8 8 L16 16 M16 8 L8 16" />
        )}
      </svg>
    </div>
  );
}

function BodyLabel({ slot }: { readonly slot: BodyLabelSlotSignals }) {
  const style = markerStyle(slot);
  const hidden = useComputed(() => !slot.visible.value);
  return (
    <div class="world-body-label" style={style} hidden={hidden}>
      <span class="world-body-label-name">{slot.name}</span>
      <span class="world-body-label-distance">{slot.distance}</span>
    </div>
  );
}

export interface WorldMarkerLayerProps {
  readonly markers: WorldMarkerSignals;
  readonly hud: HudDisplaySignals;
  readonly showTarget: ReadonlySignal<boolean> | boolean;
  readonly showLabels: ReadonlySignal<boolean> | boolean;
}

/**
 * Always mounted; visibility rides on `hidden` rather than conditional mounting.
 *
 * Unmounting a marker layer on every preset change would tear down and rebuild a
 * dozen DOM nodes at 10 Hz worst case, and would lose the CSS transition. `hidden`
 * plus the leaf signals keeps the tree stable.
 */
export function WorldMarkerLayer({ markers, hud, showTarget, showLabels }: WorldMarkerLayerProps) {
  const targetHidden = useComputed(() =>
    typeof showTarget === 'boolean' ? !showTarget : !showTarget.value,
  );
  const labelsHidden = useComputed(() =>
    typeof showLabels === 'boolean' ? !showLabels : !showLabels.value,
  );
  return (
    <div id="world-marker-layer" class="world-marker-layer" aria-hidden="true">
      <div class="world-marker-group" hidden={targetHidden}>
        <TargetMarker markers={markers} distance={hud.targetDistance} />
        <VelocityMarker id="world-marker-prograde" kind="prograde" slot={markers.prograde} />
        <VelocityMarker id="world-marker-retrograde" kind="retrograde" slot={markers.retrograde} />
      </div>
      <div id="world-body-labels" class="world-marker-group" hidden={labelsHidden}>
        {markers.labels.map((slot, index) => (
          <BodyLabel key={index} slot={slot} />
        ))}
      </div>
    </div>
  );
}
