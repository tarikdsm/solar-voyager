import { useComputed, type Signal } from '@preact/signals';

import type { StateVectorDisplaySignals } from './stateVectorSignals.js';

export interface StateVectorPanelProps {
  readonly display: StateVectorDisplaySignals;
  readonly pinnedToEcliptic: Signal<boolean>;
  readonly setPinnedToEcliptic: (pinned: boolean) => void;
  readonly viewportRef: (element: HTMLDivElement | null) => void;
}

function VectorReadout({
  className,
  label,
  symbol,
  value,
}: {
  readonly className: string;
  readonly label: string;
  readonly symbol: string;
  readonly value: StateVectorDisplaySignals[keyof StateVectorDisplaySignals];
}) {
  return (
    <div class={`state-vector-readout ${className}`}>
      <dt>
        <span class="state-vector-swatch" aria-hidden="true" />
        <span class="hud-visually-hidden">{label}</span>
        <var aria-hidden="true">{symbol}</var>
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Accessible DOM shell and sampled labels for the scissored WebGL instrument. */
export function StateVectorPanel({
  display,
  pinnedToEcliptic,
  setPinnedToEcliptic,
  viewportRef,
}: StateVectorPanelProps) {
  const orientationLabel = useComputed(() =>
    pinnedToEcliptic.value ? 'Ecliptic axes' : 'Camera-linked',
  );
  return (
    <section
      id="state-vector-panel"
      class="hud-panel state-vector-panel"
      aria-labelledby="state-vector-title"
    >
      <header>
        <span>
          <p class="hud-kicker">CM-relative vectors</p>
          <h2 id="state-vector-title">State frame</h2>
        </span>
        <button
          id="state-vector-orientation"
          type="button"
          aria-label="Pin state vectors to ecliptic axes"
          aria-pressed={pinnedToEcliptic}
          onClick={() => setPinnedToEcliptic(!pinnedToEcliptic.value)}
        >
          {orientationLabel}
        </button>
      </header>
      <div
        id="state-vector-viewport"
        class="state-vector-viewport"
        ref={viewportRef}
        aria-hidden="true"
      />
      <dl class="state-vector-readouts">
        <VectorReadout
          className="state-vector-velocity"
          label="CM-relative velocity"
          symbol="v"
          value={display.velocity}
        />
        <VectorReadout
          className="state-vector-acceleration"
          label="Proper acceleration"
          symbol="a"
          value={display.acceleration}
        />
        <VectorReadout
          className="state-vector-momentum"
          label="Relativistic linear momentum"
          symbol="p"
          value={display.momentum}
        />
        <VectorReadout
          className="state-vector-angular-momentum"
          label="Angular momentum"
          symbol="L"
          value={display.angularMomentum}
        />
      </dl>
      <footer>
        <output id="state-vector-gamma">{display.gamma}</output>
        <output id="state-vector-speed-fraction">{display.speedFraction}</output>
      </footer>
    </section>
  );
}
