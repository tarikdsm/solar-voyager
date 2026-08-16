import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import {
  HUD_SURFACES,
  formatHudPreset,
  hudPresetShows,
  nextHudPreset,
  type HudPreset,
  type HudSurface,
} from '../game/hud/hudPresets.js';

/**
 * Leaf signals for the preset ring (T0112).
 *
 * Not part of `HudSignalStore`: the preset is persisted profile state, not
 * sampled simulation state, so it has no business on the 10 Hz snapshot path.
 * Keeping it separate also means changing the preset re-renders exactly the
 * surfaces whose `shows` signal flipped, instead of the whole HUD.
 */
export interface HudPresetSignals {
  readonly preset: Signal<HudPreset>;
  readonly bodyLabels: Signal<boolean>;
  /**
   * Whole-HUD suppression, independent of the preset (T0125).
   *
   * Cinematic mode hides the instrument surfaces without changing which preset
   * the player is on, so cycling back out restores exactly what was there. The
   * frame loop assigns this every frame from the camera mode; an unchanged value
   * is a no-op in `@preact/signals`, so it costs nothing.
   */
  readonly hudHidden: Signal<boolean>;
}

export interface HudPresetDisplaySignals {
  readonly presetLabel: ReadonlySignal<string>;
  readonly bodyLabelsLabel: ReadonlySignal<string>;
}

export interface HudPresetStore {
  readonly signals: HudPresetSignals;
  readonly display: HudPresetDisplaySignals;
  /** Per-surface visibility, memoised so each surface subscribes to one leaf. */
  shows(surface: HudSurface): ReadonlySignal<boolean>;
  setPreset(preset: HudPreset): void;
  /** Steps the ring and returns the new preset, for the caller to persist. */
  cyclePreset(): HudPreset;
  setBodyLabels(enabled: boolean): void;
  toggleBodyLabels(): boolean;
  setHudHidden(hidden: boolean): void;
}

class SignalHudPresetStore implements HudPresetStore {
  readonly signals: HudPresetSignals;
  readonly display: HudPresetDisplaySignals;
  private readonly surfaceSignals = new Map<HudSurface, ReadonlySignal<boolean>>();

  constructor(preset: HudPreset, bodyLabels: boolean) {
    this.signals = {
      preset: signal(preset),
      bodyLabels: signal(bodyLabels),
      hudHidden: signal(false),
    };
    this.display = {
      presetLabel: computed(() => formatHudPreset(this.signals.preset.value)),
      bodyLabelsLabel: computed(() => (this.signals.bodyLabels.value ? 'Labels on' : 'Labels off')),
    };
    // Built eagerly: the set is fixed and tiny, and a lazily-created computed
    // inside a render pass would be a new subscription every time a surface
    // appeared, which is exactly the churn signals exist to avoid.
    for (const surface of HUD_SURFACES) {
      this.surfaceSignals.set(
        surface,
        computed(() => hudPresetShows(this.signals.preset.value, surface)),
      );
    }
  }

  shows(surface: HudSurface): ReadonlySignal<boolean> {
    const existing = this.surfaceSignals.get(surface);
    if (existing === undefined) throw new RangeError(`unknown HUD surface: ${surface}`);
    return existing;
  }

  setPreset(preset: HudPreset): void {
    this.signals.preset.value = preset;
  }

  cyclePreset(): HudPreset {
    const next = nextHudPreset(this.signals.preset.value);
    this.signals.preset.value = next;
    return next;
  }

  setBodyLabels(enabled: boolean): void {
    this.signals.bodyLabels.value = enabled;
  }

  toggleBodyLabels(): boolean {
    const next = !this.signals.bodyLabels.value;
    this.signals.bodyLabels.value = next;
    return next;
  }

  setHudHidden(hidden: boolean): void {
    this.signals.hudHidden.value = hidden;
  }
}

/** Creates the setup-time preset store, seeded from the persisted profile. */
export function createHudPresetStore(preset: HudPreset, bodyLabels: boolean): HudPresetStore {
  return new SignalHudPresetStore(preset, bodyLabels);
}
