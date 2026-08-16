import type { PerspectiveCamera } from 'three';

import type { SimSnapshot } from '../sim/simulationSnapshot.js';
import {
  createRelativisticVisualState,
  writeRelativisticVisualState,
  type RelativisticVisualState,
} from './relativisticVisualState.js';

interface RelativisticDirectionPort {
  setRelativisticObserver(state: Readonly<RelativisticVisualState>): void;
}

interface RelativisticPostPort {
  updateObserver(state: Readonly<RelativisticVisualState>, camera: PerspectiveCamera): void;
}

export interface RelativisticVisualControllerOptions {
  readonly postPass: RelativisticPostPort;
  readonly spaceScene: RelativisticDirectionPort;
  readonly starfield: RelativisticDirectionPort;
  /**
   * T0126 — the panorama sphere and the constellation batch.
   *
   * They are fed the very same state object as the starfield, through the very
   * same port, because they run the very same GLSL aberration chunk. If any of
   * the three ever diverged, a high-beta view would shear the sky against its
   * own stars.
   */
  readonly milkyWaySky: RelativisticDirectionPort;
  readonly constellationLines: RelativisticDirectionPort;
}

/** Validates and distributes one preallocated render-only observer state. */
export class RelativisticVisualController {
  private readonly postPass: RelativisticPostPort;
  private readonly spaceScene: RelativisticDirectionPort;
  private readonly starfield: RelativisticDirectionPort;
  private readonly milkyWaySky: RelativisticDirectionPort;
  private readonly constellationLines: RelativisticDirectionPort;
  private readonly state = createRelativisticVisualState();
  private qualityEnabled = false;

  constructor(options: RelativisticVisualControllerOptions) {
    this.postPass = options.postPass;
    this.spaceScene = options.spaceScene;
    this.starfield = options.starfield;
    this.milkyWaySky = options.milkyWaySky;
    this.constellationLines = options.constellationLines;
  }

  setQualityEnabled(enabled: boolean): void {
    this.qualityEnabled = enabled;
  }

  update(snapshot: SimSnapshot, camera: PerspectiveCamera): void {
    writeRelativisticVisualState(this.state, snapshot, this.qualityEnabled);
    this.spaceScene.setRelativisticObserver(this.state);
    this.starfield.setRelativisticObserver(this.state);
    this.milkyWaySky.setRelativisticObserver(this.state);
    this.constellationLines.setRelativisticObserver(this.state);
    this.postPass.updateObserver(this.state, camera);
  }
}
