import type { ReadonlyVec3 } from '../core/vec3.js';
import { PerspectiveCamera, Scene, type Object3D } from 'three';

export const SPACE_NEAR_KM = 0.001;
export const SPACE_FAR_KM = 1e10;

function assertFinitePosition(label: string, positionKm: ReadonlyVec3): void {
  if (
    !Number.isFinite(positionKm.x) ||
    !Number.isFinite(positionKm.y) ||
    !Number.isFinite(positionKm.z)
  ) {
    throw new RangeError(`${label} must contain finite kilometre coordinates.`);
  }
}

/**
 * Owns the single float64-to-render-coordinate boundary for space visuals.
 * Physics positions remain in caller-owned objects and are never accumulated
 * through the lower-precision render representation.
 */
export class CameraRelativeSpaceScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(75, 1, SPACE_NEAR_KM, SPACE_FAR_KM);

  private readonly visuals: Object3D[] = [];
  private readonly positionsKm: ReadonlyVec3[] = [];
  private readonly boundVisuals = new Set<Object3D>();

  constructor() {
    this.camera.position.set(0, 0, 0);
    this.camera.matrixAutoUpdate = false;
    this.camera.updateMatrix();
  }

  /** Binds a setup-time visual to a caller-owned float64 physics position. */
  bindVisual(visual: Object3D, positionKm: ReadonlyVec3): void {
    assertFinitePosition('visual position', positionKm);

    if (this.boundVisuals.has(visual)) {
      throw new Error('Visual is already bound to this space scene.');
    }

    this.boundVisuals.add(visual);
    this.visuals.push(visual);
    this.positionsKm.push(positionKm);
    visual.matrixAutoUpdate = false;
    this.scene.add(visual);
  }

  /** Recomputes render coordinates from float64 inputs without frame allocations. */
  updateCameraRelative(cameraPositionKm: ReadonlyVec3): void {
    assertFinitePosition('camera position', cameraPositionKm);

    for (let index = 0; index < this.visuals.length; index += 1) {
      const visual = this.visuals[index];
      const positionKm = this.positionsKm[index];

      if (visual === undefined || positionKm === undefined) {
        throw new Error('Space scene binding arrays are out of sync.');
      }

      assertFinitePosition('visual position', positionKm);

      visual.position.set(
        Math.fround(positionKm.x - cameraPositionKm.x),
        Math.fround(positionKm.y - cameraPositionKm.y),
        Math.fround(positionKm.z - cameraPositionKm.z),
      );
      visual.updateMatrix();
    }
  }
}
