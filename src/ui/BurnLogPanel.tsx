import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import { useRef } from 'preact/hooks';

import type { BurnLogRowSignalGraph, BurnLogSignalStore } from './burnLogSignals.js';

interface FocusableElement {
  focus(): void;
}

export interface BurnLogPanelKeyboardEvent {
  readonly code: string;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

export interface BurnLogCompletedSlot {
  readonly hidden: ReadonlySignal<boolean>;
  readonly handleKeyDown: (event: BurnLogPanelKeyboardEvent) => void;
  readonly setElement: (element: FocusableElement | null) => void;
}

export interface BurnLogPanelModel {
  readonly expanded: Signal<boolean>;
  readonly collapsed: ReadonlySignal<boolean>;
  readonly emptyHidden: ReadonlySignal<boolean>;
  readonly activeHidden: ReadonlySignal<boolean>;
  readonly summary: ReadonlySignal<string>;
  readonly completedSlots: readonly BurnLogCompletedSlot[];
  readonly setToggleElement: (element: FocusableElement | null) => void;
  readonly toggle: () => void;
}

class DefaultBurnLogPanelModel implements BurnLogPanelModel {
  readonly expanded = signal(false);
  readonly collapsed = computed(() => !this.expanded.value);
  readonly emptyHidden: ReadonlySignal<boolean>;
  readonly activeHidden: ReadonlySignal<boolean>;
  readonly summary: ReadonlySignal<string>;
  readonly completedSlots: readonly BurnLogCompletedSlot[];

  private toggleElement: FocusableElement | null = null;
  private readonly completedElements: Array<FocusableElement | null>;

  constructor(private readonly store: BurnLogSignalStore) {
    this.emptyHidden = computed(
      () => store.activeRow.visible.value || store.completedCount.value > 0,
    );
    this.activeHidden = computed(() => !store.activeRow.visible.value);
    this.summary = computed(() => {
      const count = store.completedCount.value;
      if (store.activeRow.visible.value) {
        return `1 active burn · ${String(count)} completed ${count === 1 ? 'burn' : 'burns'}`;
      }
      if (count === 0) return 'No burns recorded';
      return `${String(count)} completed ${count === 1 ? 'burn' : 'burns'}`;
    });

    this.completedElements = new Array<FocusableElement | null>(store.completedRows.length).fill(
      null,
    );
    const slots: BurnLogCompletedSlot[] = [];
    for (let index = 0; index < store.completedRows.length; index += 1) {
      const row = store.completedRows[index];
      if (row === undefined) throw new Error('burn log row graph is sparse');
      slots.push({
        hidden: computed(() => !row.visible.value),
        handleKeyDown: (event) => this.handleRowKeyDown(index, event),
        setElement: (element) => {
          this.completedElements[index] = element;
        },
      });
    }
    this.completedSlots = slots;
  }

  readonly setToggleElement = (element: FocusableElement | null): void => {
    this.toggleElement = element;
  };

  readonly toggle = (): void => {
    this.expanded.value = !this.expanded.value;
    if (!this.expanded.value) this.toggleElement?.focus();
  };

  private handleRowKeyDown(index: number, event: BurnLogPanelKeyboardEvent): void {
    const count = this.store.completedCount.value;
    let destination = index;
    switch (event.code) {
      case 'ArrowDown':
        destination = Math.min(count - 1, index + 1);
        break;
      case 'ArrowUp':
        destination = Math.max(0, index - 1);
        break;
      case 'Home':
        destination = 0;
        break;
      case 'End':
        destination = count - 1;
        break;
      case 'Escape':
        event.preventDefault();
        this.expanded.value = false;
        this.toggleElement?.focus();
        return;
      default:
        return;
    }
    event.preventDefault();
    if (destination === index || destination < 0 || destination >= count) return;
    this.completedElements[destination]?.focus();
  }
}

export function BurnMetrics({
  active,
  row,
}: {
  readonly active: boolean;
  readonly row: BurnLogRowSignalGraph;
}) {
  return (
    <dl class="burn-log-metrics">
      <div>
        <dt>Start (mission UTC)</dt>
        <dd>{row.display.startUtc}</dd>
      </div>
      <div>
        <dt>{active ? 'Current (mission UTC)' : 'End (mission UTC)'}</dt>
        <dd>{row.display.endUtc}</dd>
      </div>
      <div>
        <dt>Start (ship MET)</dt>
        <dd>{row.display.startMet}</dd>
      </div>
      <div>
        <dt>{active ? 'Current (ship MET)' : 'End (ship MET)'}</dt>
        <dd>{row.display.endMet}</dd>
      </div>
      <div>
        <dt>Energy</dt>
        <dd>{row.display.energy}</dd>
      </div>
      <div>
        <dt>Proper Δv</dt>
        <dd>{row.display.properDeltaV}</dd>
      </div>
      <div>
        <dt>Peak power</dt>
        <dd>{row.display.peakPower}</dd>
      </div>
      <div>
        <dt>Dominant body</dt>
        <dd>{row.display.dominantBody}</dd>
      </div>
      <div>
        <dt>Prograde</dt>
        <dd>{row.display.progradeDeltaV}</dd>
      </div>
      <div>
        <dt>Normal</dt>
        <dd>{row.display.normalDeltaV}</dd>
      </div>
      <div>
        <dt>Radial</dt>
        <dd>{row.display.radialDeltaV}</dd>
      </div>
    </dl>
  );
}

export function BurnLogPanelView({
  model,
  store,
}: {
  readonly model: BurnLogPanelModel;
  readonly store: BurnLogSignalStore;
}) {
  return (
    <>
      <button
        ref={model.setToggleElement}
        id="burn-log-toggle"
        class="burn-log-toggle"
        type="button"
        aria-controls="burn-log-panel"
        aria-expanded={model.expanded}
        onClick={model.toggle}
      >
        Burn log
      </button>
      <section
        id="burn-log-panel"
        class="hud-panel burn-log-panel"
        aria-labelledby="burn-log-title"
        hidden={model.collapsed}
      >
        <header>
          <span>
            <p class="hud-kicker">Photon-drive ledger</p>
            <h2 id="burn-log-title">Burn log</h2>
          </span>
          <p id="burn-log-summary" aria-live="polite">
            {model.summary}
          </p>
        </header>
        <p id="burn-log-empty" class="burn-log-empty" hidden={model.emptyHidden}>
          No burns recorded. Apply throttle to begin a burn.
        </p>
        <article id="burn-log-active" class="burn-log-active" hidden={model.activeHidden}>
          <h3>
            <span aria-hidden="true">●</span> Active burn
          </h3>
          <BurnMetrics active row={store.activeRow} />
        </article>
        <section class="burn-log-completed" aria-labelledby="burn-log-completed-title">
          <h3 id="burn-log-completed-title">Completed burns · newest first</h3>
          <ol class="burn-log-completed-list" aria-label="Completed burns, newest first">
            {store.completedRows.map((row, index) => {
              const slot = model.completedSlots[index];
              if (slot === undefined) throw new Error('burn log panel slot is sparse');
              return (
                <li key={index} data-burn-slot={index} hidden={slot.hidden}>
                  <button
                    ref={slot.setElement}
                    type="button"
                    class="burn-log-row-button"
                    data-burn-row={index}
                    onKeyDown={slot.handleKeyDown}
                  >
                    <span>Completed burn {index + 1}</span>
                    <span>{row.display.startUtc}</span>
                  </button>
                  <BurnMetrics active={false} row={row} />
                </li>
              );
            })}
          </ol>
        </section>
      </section>
    </>
  );
}

/** Renders the setup-mounted, fixed-capacity burn history panel. */
export function BurnLogPanel({ store }: { readonly store: BurnLogSignalStore }) {
  const modelRef = useRef<BurnLogPanelModel | null>(null);
  if (modelRef.current === null) modelRef.current = createBurnLogPanelModel(store);
  return <BurnLogPanelView store={store} model={modelRef.current} />;
}

/** Creates the panel's setup-owned focus and expansion model. */
export function createBurnLogPanelModel(store: BurnLogSignalStore): BurnLogPanelModel {
  return new DefaultBurnLogPanelModel(store);
}
