import type { Material } from 'three';

import { GasGiantAnimationState, isGasGiantId, type GasGiantId } from './gasGiantAnimationState.js';
import { prepareGasGiantMaterial, type PreparedGasGiantMaterial } from './gasGiantMaterial.js';
import type { ProceduralQuality } from './proceduralSunState.js';

export class GasGiantAnimation {
  readonly state: GasGiantAnimationState;
  private readonly prepared: PreparedGasGiantMaterial;

  constructor(id: GasGiantId, seed: number, material: Material) {
    this.state = new GasGiantAnimationState(id, seed);
    this.prepared = prepareGasGiantMaterial(material, this.state.uniforms);
  }

  update(simTimeSec: number): void {
    this.state.update(simTimeSec);
  }

  setQuality(quality: ProceduralQuality): void {
    this.state.setQuality(quality);
  }

  setEnabled(enabled: boolean): void {
    this.state.setEnabled(enabled);
  }

  dispose(): void {
    this.prepared.dispose();
  }
}

export function prepareGasGiantAnimation(
  id: string,
  seed: number,
  material: Material,
): GasGiantAnimation | null {
  return isGasGiantId(id) ? new GasGiantAnimation(id, seed, material) : null;
}
