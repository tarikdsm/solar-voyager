import { useComputed, type ReadonlySignal } from '@preact/signals';

import type { HudDisplaySignals, HudSignals } from './hudSignals.js';

/**
 * The Clean preset's whole HUD (T0112, spec §7).
 *
 * A reticle, one throttle/speed strip, a cruise status line and a warning line.
 * Everything else is opt-in through the preset ring. The strip stays mounted in
 * every preset — Pilot and Engineer add instruments, they do not take the flight
 * controls away.
 */

export function Reticle({ show }: { readonly show: ReadonlySignal<boolean> | boolean }) {
  const hidden = useComputed(() => (typeof show === 'boolean' ? !show : !show.value));
  return (
    <div id="hud-reticle" class="hud-reticle" hidden={hidden} aria-hidden="true">
      <svg viewBox="0 0 48 48" width="48" height="48" focusable="false">
        <circle class="hud-reticle-ring" cx="24" cy="24" r="9" />
        <path class="hud-reticle-tick" d="M24 2 V10 M24 38 V46 M2 24 H10 M38 24 H46" />
        <circle class="hud-reticle-center" cx="24" cy="24" r="1.4" />
      </svg>
    </div>
  );
}

export function ThrottleSpeedStrip({
  hud,
  hudState,
  showAltitude,
  showWarp,
}: {
  readonly hud: HudDisplaySignals;
  readonly hudState: HudSignals;
  readonly showAltitude: ReadonlySignal<boolean> | boolean;
  readonly showWarp: ReadonlySignal<boolean> | boolean;
}) {
  // The bar is a scaleX on a preallocated element, not a width: only transform
  // and opacity are allowed to animate (performance-spec §5).
  const fillStyle = useComputed(
    () => `transform:scaleX(${Math.max(0, Math.min(1, hudState.throttle.value)).toFixed(3)})`,
  );
  const altitudeHidden = useComputed(() =>
    typeof showAltitude === 'boolean' ? !showAltitude : !showAltitude.value,
  );
  const warpHidden = useComputed(() =>
    typeof showWarp === 'boolean' ? !showWarp : !showWarp.value,
  );
  return (
    <section id="flight-strip" class="flight-strip" aria-label="Throttle and speed">
      <div class="flight-strip-throttle">
        <span class="hud-kicker">Throttle</span>
        <div class="flight-strip-bar">
          <div class="flight-strip-bar-fill" style={fillStyle} />
        </div>
        <strong id="flight-strip-throttle-value">{hud.throttlePercent}</strong>
      </div>
      <div class="flight-strip-speed">
        <span class="hud-kicker">Speed</span>
        <strong id="flight-strip-speed-value">{hud.relativeSpeed}</strong>
      </div>
      <div class="flight-strip-altitude" hidden={altitudeHidden}>
        <span class="hud-kicker">Radar alt</span>
        <strong id="flight-strip-altitude-value">{hud.radarAltitude}</strong>
      </div>
      <div class="flight-strip-warp" hidden={warpHidden}>
        <span class="hud-kicker">Warp</span>
        <strong id="flight-strip-warp-value">{hud.effectiveWarp}</strong>
      </div>
    </section>
  );
}

/**
 * Cruise status placeholder.
 *
 * T0116 owns `CruiseDirector`; until it lands this reads `Standby`. It ships now
 * because Clean's layout has to reserve the row — a status line that appears
 * three tasks later is a layout regression waiting to happen, and the honest
 * placeholder is also the honest answer: there is no cruise system yet.
 */
export function CruiseStatus({ show }: { readonly show: ReadonlySignal<boolean> | boolean }) {
  const hidden = useComputed(() => (typeof show === 'boolean' ? !show : !show.value));
  return (
    <section id="cruise-status" class="cruise-status" aria-label="Cruise status" hidden={hidden}>
      <span class="hud-kicker">Cruise</span>
      <strong id="cruise-status-phase">Standby</strong>
      <span id="cruise-status-detail" class="cruise-status-detail">
        Guidance arrives with the cruise system
      </span>
    </section>
  );
}

export function FlightWarnings({
  hud,
  show,
}: {
  readonly hud: HudDisplaySignals;
  readonly show: ReadonlySignal<boolean> | boolean;
}) {
  const hidden = useComputed(() => (typeof show === 'boolean' ? !show : !show.value));
  // `aria-live="polite"`, not assertive: the impact overlay already announces the
  // one event that warrants interrupting a screen reader.
  const empty = useComputed(() => hud.flightWarning.value.length === 0);
  return (
    <p
      id="flight-warning"
      class="flight-warning"
      data-empty={empty}
      hidden={hidden}
      aria-live="polite"
    >
      {hud.flightWarning}
    </p>
  );
}

export function HudPresetIndicator({ label }: { readonly label: ReadonlySignal<string> }) {
  return (
    <p id="hud-preset-indicator" class="hud-preset-indicator" aria-live="polite">
      <span class="hud-kicker">HUD</span>
      <strong>{label}</strong>
    </p>
  );
}
