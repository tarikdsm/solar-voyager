import {
  AdditiveBlending,
  AmbientLight,
  DataTexture,
  DirectionalLight,
  LinearFilter,
  RGBAFormat,
  Sprite,
  SpriteMaterial,
} from 'three';

import { AU_KM } from '../core/constants.js';
import type { CameraRelativeSpaceScene } from './spaceScene.js';

export const AMBIENT_LIGHT_INTENSITY = 0.02;
export const GLARE_TEXTURE_SIZE = 64;
export const SUN_GLARE_DIAMETER_IN_RADII = 8;

const SUN_GLARE_OPACITY = 0.25;
const SUN_GLARE_RED = 8;
const SUN_GLARE_GREEN = 4;
const SUN_GLARE_BLUE = 2;

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

function createGlareTexture(): DataTexture {
  const data = new Uint8Array(GLARE_TEXTURE_SIZE * GLARE_TEXTURE_SIZE * 4);
  const radiusPx = GLARE_TEXTURE_SIZE / 2 - 1;
  for (let y = 0; y < GLARE_TEXTURE_SIZE; y += 1) {
    const normalizedY = (y - GLARE_TEXTURE_SIZE / 2) / radiusPx;
    for (let x = 0; x < GLARE_TEXTURE_SIZE; x += 1) {
      const normalizedX = (x - GLARE_TEXTURE_SIZE / 2) / radiusPx;
      const radius = Math.sqrt(normalizedX * normalizedX + normalizedY * normalizedY);
      const falloff = Math.max(0, 1 - radius);
      const offset = (y * GLARE_TEXTURE_SIZE + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(255 * falloff * falloff * falloff);
    }
  }
  const texture = new DataTexture(data, GLARE_TEXTURE_SIZE, GLARE_TEXTURE_SIZE, RGBAFormat);
  texture.name = 'sun-glare-radial';
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Owns the one-light solar model and its setup-time HDR glare billboard. */
export class SolarLighting {
  readonly ambientLight = new AmbientLight(0xffffff, AMBIENT_LIGHT_INTENSITY);
  readonly directionalLight = new DirectionalLight(0xffffff, Math.PI);
  readonly glare: Sprite;

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

    const glareTexture = createGlareTexture();
    const glareMaterial = new SpriteMaterial({
      map: glareTexture,
      transparent: true,
      opacity: SUN_GLARE_OPACITY,
      blending: AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: true,
    });
    glareMaterial.color.setRGB(SUN_GLARE_RED, SUN_GLARE_GREEN, SUN_GLARE_BLUE);
    this.glare = new Sprite(glareMaterial);
    this.glare.name = 'sun-glare';
    const glareDiameterKm = solarRadiusKm * SUN_GLARE_DIAMETER_IN_RADII;
    this.glare.scale.set(glareDiameterKm, glareDiameterKm, 1);
    this.spaceScene.bindPackedVisual(this.glare, positionsKm, sunPositionOffset);

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
      this.glare,
    );
    this.glare.material.map?.dispose();
    this.glare.material.dispose();
  }
}
