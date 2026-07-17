import { AmbientLight, DirectionalLight } from 'three';

import { AU_KM } from '../core/constants.js';
import type { CameraRelativeSpaceScene } from './spaceScene.js';

export const AMBIENT_LIGHT_INTENSITY = 0.02;

function assertPackedPositions(positionsKm: Float64Array): void {
  if (positionsKm.length === 0 || positionsKm.length % 3 !== 0) {
    throw new RangeError('Solar lighting packed positions must contain xyz triples.');
  }
  for (let index = 0; index < positionsKm.length; index += 1) {
    if (!Number.isFinite(positionsKm[index])) {
      throw new RangeError('Solar lighting packed positions must be finite.');
    }
  }
}

function assertPositionOffset(positionsKm: Float64Array, componentOffset: number): void {
  if (
    !Number.isInteger(componentOffset) ||
    componentOffset < 0 ||
    componentOffset % 3 !== 0 ||
    componentOffset + 2 >= positionsKm.length
  ) {
    throw new RangeError('Solar lighting offset must address one xyz triple.');
  }
}

/** Owns the allocation-free ambient and inverse-square directional solar lights. */
export class SolarLighting {
  readonly ambientLight = new AmbientLight(0xffffff, AMBIENT_LIGHT_INTENSITY);
  readonly directionalLight = new DirectionalLight(0xffffff, Math.PI);

  private focusPositionOffset: number;

  constructor(
    private readonly spaceScene: CameraRelativeSpaceScene,
    private readonly positionsKm: Float64Array,
    private readonly sunPositionOffset: number,
    focusPositionOffset: number,
    private readonly solarRadiusKm: number,
  ) {
    assertPackedPositions(positionsKm);
    assertPositionOffset(positionsKm, sunPositionOffset);
    assertPositionOffset(positionsKm, focusPositionOffset);
    if (!Number.isFinite(solarRadiusKm) || solarRadiusKm <= 0) {
      throw new RangeError('Solar radius must be positive and finite.');
    }
    this.focusPositionOffset = focusPositionOffset;

    this.ambientLight.matrixAutoUpdate = false;
    this.ambientLight.updateMatrix();
    this.directionalLight.matrixAutoUpdate = false;
    this.directionalLight.target.matrixAutoUpdate = false;
    this.directionalLight.target.updateMatrix();
    this.spaceScene.scene.add(
      this.ambientLight,
      this.directionalLight,
      this.directionalLight.target,
    );

    this.update();
  }

  setFocusPositionOffset(componentOffset: number): void {
    assertPositionOffset(this.positionsKm, componentOffset);
    this.focusPositionOffset = componentOffset;
  }

  /** Updates existing light scalars and matrices without allocating. */
  update(): void {
    const sunX = this.positionsKm[this.sunPositionOffset] as number;
    const sunY = this.positionsKm[this.sunPositionOffset + 1] as number;
    const sunZ = this.positionsKm[this.sunPositionOffset + 2] as number;
    const focusX = this.positionsKm[this.focusPositionOffset] as number;
    const focusY = this.positionsKm[this.focusPositionOffset + 1] as number;
    const focusZ = this.positionsKm[this.focusPositionOffset + 2] as number;
    const directionX = sunX - focusX;
    const directionY = sunY - focusY;
    const directionZ = sunZ - focusZ;
    const distanceKm = Math.sqrt(
      directionX * directionX + directionY * directionY + directionZ * directionZ,
    );

    if (distanceKm > 0) {
      const inverseDistance = 1 / distanceKm;
      this.directionalLight.position.set(
        directionX * inverseDistance,
        directionY * inverseDistance,
        directionZ * inverseDistance,
      );
      this.directionalLight.updateMatrix();
    }

    const finiteDistanceKm = Math.max(distanceKm, this.solarRadiusKm);
    const relativeDistance = AU_KM / finiteDistanceKm;
    this.directionalLight.intensity = Math.PI * relativeDistance * relativeDistance;
  }

  dispose(): void {
    this.spaceScene.scene.remove(
      this.ambientLight,
      this.directionalLight,
      this.directionalLight.target,
    );
  }
}
