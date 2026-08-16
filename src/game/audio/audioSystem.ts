import type { SimSnapshot } from '../../sim/simulationSnapshot.js';
import type { CameraMode } from '../cameraDirector.js';
import type { AudioSettings } from '../settings.js';

import { AudioDirector, type AudioBodyClass, type AudioMixState } from './audioDirector.js';
import { WebAudioEngine } from './audioEngine.js';

export interface AudioSystemOptions {
  /** Audio class per body, indexed like `SimSnapshot.bodyIds`. */
  readonly bodyClasses: readonly AudioBodyClass[];
  readonly levels: AudioSettings;
  /** Browser adapter, supplied by `bootstrap/composition.ts`. */
  readonly createContext: () => AudioContext;
}

/**
 * The audio subsystem as one handle: decide, then apply.
 *
 * The two halves stay separate classes on purpose (`AudioDirector` is pure and
 * Node-testable, `WebAudioEngine` owns the browser), and this is the seam that
 * joins them so the frame loop holds one field and calls one method. T0145,
 * T0146 and T0150 attach to this object rather than to either half.
 *
 * Design: `docs/superpowers/specs/2026-08-16-audio-engine-design.md` section 1.
 */
export class AudioSystem {
  readonly director: AudioDirector;
  readonly engine: WebAudioEngine;

  constructor(options: AudioSystemOptions) {
    this.director = new AudioDirector({
      bodyClasses: options.bodyClasses,
      levels: options.levels,
    });
    this.engine = new WebAudioEngine({ createContext: options.createContext });
  }

  /** Live decision output; the same object every frame. */
  get mix(): AudioMixState {
    return this.director.state;
  }

  /** Applies persisted mixer levels (profile `audio` block). */
  setLevels(levels: AudioSettings): void {
    this.director.setLevels(levels);
  }

  /** First user gesture. Idempotent — composition may call it from either listener. */
  unlock(): void {
    this.engine.unlock();
  }

  setPageHidden(hidden: boolean): void {
    this.engine.setPageHidden(hidden);
  }

  /**
   * One frame: decide from the snapshot, then move the graph towards the decision.
   *
   * The director runs whether or not a gesture has happened, so the decisions are
   * live (and observable through the diagnostic) while the output is correctly
   * silent. `wallDtSec` is the wall delta, never the sim delta — see
   * `AudioDirector.update`.
   */
  update(snapshot: SimSnapshot, cameraMode: CameraMode, paused: boolean, wallDtSec: number): void {
    this.director.update(snapshot, cameraMode, paused, wallDtSec);
    this.engine.apply(this.director.state);
  }

  dispose(): void {
    this.engine.dispose();
  }
}
