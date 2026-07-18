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
}

/** Validates and distributes one preallocated render-only observer state. */
export class RelativisticVisualController {
  private readonly postPass: RelativisticPostPort;
  private readonly spaceScene: RelativisticDirectionPort;
  private readonly starfield: RelativisticDirectionPort;
  private readonly state = createRelativisticVisualState();
  private qualityEnabled = false;

  constructor(options: RelativisticVisualControllerOptions) {
    this.postPass = options.postPass;
    this.spaceScene = options.spaceScene;
    this.starfield = options.starfield;
  }

  setQualityEnabled(enabled: boolean): void {
    this.qualityEnabled = enabled;
  }

  update(snapshot: SimSnapshot, camera: PerspectiveCamera): void {
    writeRelativisticVisualState(this.state, snapshot, this.qualityEnabled);
    this.spaceScene.setRelativisticObserver(this.state);
    this.starfield.setRelativisticObserver(this.state);
    this.postPass.updateObserver(this.state, camera);
  }
}
