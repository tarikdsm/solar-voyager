import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import type { SystemMapMode } from '../game/systemMapController.js';

export interface SystemMapSignals {
  readonly mode: Signal<SystemMapMode>;
  readonly focusBodyId: Signal<string>;
}

export interface SystemMapDisplaySignals {
  readonly open: ReadonlySignal<boolean>;
  readonly closed: ReadonlySignal<boolean>;
  readonly toggleLabel: ReadonlySignal<string>;
  readonly focusBodyLabel: ReadonlySignal<string>;
}

export interface SystemMapSignalStore {
  readonly signals: SystemMapSignals;
  readonly display: SystemMapDisplaySignals;
  publishMode(mode: SystemMapMode): boolean;
  publishFocus(bodyId: string): boolean;
}

/** Formats a canonical catalog id for accessible map labels. */
export function formatSystemMapBodyLabel(bodyId: string): string {
  return bodyId.replace(
    /(^|[-_])(\p{L})/gu,
    (_match, separator: string, letter: string) =>
      `${separator.length === 0 ? '' : ' '}${letter.toUpperCase()}`,
  );
}

class DefaultSystemMapSignalStore implements SystemMapSignalStore {
  private readonly bodyIds: readonly string[];
  readonly signals: SystemMapSignals;
  readonly display: SystemMapDisplaySignals;

  constructor(bodyIds: readonly string[], initialFocusId: string) {
    if (bodyIds.length === 0) throw new Error('System map body ids cannot be empty.');
    this.bodyIds = [...bodyIds];
    if (!this.hasBody(initialFocusId)) {
      throw new Error(`Unknown initial focus "${initialFocusId}" for system map signals.`);
    }
    this.signals = {
      mode: signal<SystemMapMode>('space'),
      focusBodyId: signal(initialFocusId),
    };
    this.display = {
      open: computed(() => this.signals.mode.value === 'system-map'),
      closed: computed(() => this.signals.mode.value !== 'system-map'),
      toggleLabel: computed(() =>
        this.signals.mode.value === 'system-map' ? 'Close system map' : 'Open system map',
      ),
      focusBodyLabel: computed(() => formatSystemMapBodyLabel(this.signals.focusBodyId.value)),
    };
  }

  publishMode(mode: SystemMapMode): boolean {
    if (mode === this.signals.mode.value) return false;
    this.signals.mode.value = mode;
    return true;
  }

  publishFocus(bodyId: string): boolean {
    if (bodyId === this.signals.focusBodyId.value || !this.hasBody(bodyId)) return false;
    this.signals.focusBodyId.value = bodyId;
    return true;
  }

  private hasBody(bodyId: string): boolean {
    for (let index = 0; index < this.bodyIds.length; index += 1) {
      if (this.bodyIds[index] === bodyId) return true;
    }
    return false;
  }
}

/** Creates the setup-owned signal adapter for the pure system-map controller. */
export function createSystemMapSignalStore(
  bodyIds: readonly string[],
  initialFocusId: string,
): SystemMapSignalStore {
  return new DefaultSystemMapSignalStore(bodyIds, initialFocusId);
}
