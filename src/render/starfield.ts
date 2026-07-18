import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  LessEqualDepth,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { RelativisticVisualState } from './relativisticVisualState.js';
import { STAR_STRIDE_FLOATS, type StarCatalog } from './starCatalog.js';

export const STARFIELD_RADIUS_KM = 1e9;
export const STAR_MIN_SIZE_CSS_PX = 1;
export const STAR_MAX_SIZE_CSS_PX = 4;

const vertexShader = /* glsl */ `
  uniform float uRadiusKm;
  uniform float uPixelRatio;
  uniform vec3 uObserverBeta;
  uniform float uObserverGamma;
  uniform float uRelativisticActivation;

  attribute vec3 aColor;
  attribute float aSizeCssPx;
  attribute float aOpacity;

  varying vec3 vStarColor;
  varying float vStarOpacity;
  varying float vPointSizePx;

  vec3 aberrateDirection(vec3 direction) {
    float betaSquared = dot(uObserverBeta, uObserverBeta);
    if (uRelativisticActivation == 0.0 || betaSquared == 0.0) return direction;

    // physics-spec.md section 6.1: observer-frame source direction.
    float betaDotDirection = dot(uObserverBeta, direction);
    float boostCoefficient =
      ((uObserverGamma - 1.0) / betaSquared) * betaDotDirection + uObserverGamma;
    vec3 observedDirection =
      (direction + boostCoefficient * uObserverBeta) /
      (uObserverGamma * (1.0 + betaDotDirection));
    return normalize(mix(direction, observedDirection, uRelativisticActivation));
  }

  void main() {
    vec3 observedDirection = aberrateDirection(normalize(position));
    vec4 viewPosition = modelViewMatrix * vec4(observedDirection * uRadiusKm, 1.0);
    vec4 clipPosition = projectionMatrix * viewPosition;
    #ifdef USE_REVERSED_DEPTH_BUFFER
      clipPosition.z = 0.0;
    #else
      clipPosition.z = clipPosition.w;
    #endif
    gl_Position = clipPosition;

    vPointSizePx = aSizeCssPx * uPixelRatio;
    gl_PointSize = vPointSizePx;
    vStarColor = aColor;
    vStarOpacity = aOpacity;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vStarColor;
  varying float vStarOpacity;
  varying float vPointSizePx;

  void main() {
    float pointSpread = 1.0;
    if (vPointSizePx > 1.5) {
      float radialDistance = length(gl_PointCoord - vec2(0.5)) * 2.0;
      pointSpread = 1.0 - smoothstep(0.65, 1.0, radialDistance);
      if (pointSpread <= 0.0) discard;
    }
    gl_FragColor = vec4(vStarColor, vStarOpacity * pointSpread);
  }
`;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function magnitudeToStarSizeCssPx(visualMagnitude: number): number {
  const flux = 10 ** (-0.4 * visualMagnitude);
  return clamp(
    STAR_MIN_SIZE_CSS_PX,
    STAR_MAX_SIZE_CSS_PX,
    STAR_MIN_SIZE_CSS_PX + 1.5 * flux ** 0.25,
  );
}

export function magnitudeToStarOpacity(visualMagnitude: number): number {
  return clamp(0, 1, 10 ** (-0.4 * (visualMagnitude - 1)));
}

function assertPixelRatio(pixelRatio: number): void {
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new RangeError(`starfield pixel ratio must be positive and finite: ${pixelRatio}`);
  }
}

export function createMagnitudeOrderedStarIndices(catalog: StarCatalog): Uint16Array | Uint32Array {
  const indices =
    catalog.starCount <= 0xffff
      ? new Uint16Array(catalog.starCount)
      : new Uint32Array(catalog.starCount);
  for (let index = 0; index < catalog.starCount; index += 1) indices[index] = index;
  indices.sort((left, right) => {
    const leftMagnitude = catalog.data[left * STAR_STRIDE_FLOATS + 3] ?? Number.POSITIVE_INFINITY;
    const rightMagnitude = catalog.data[right * STAR_STRIDE_FLOATS + 3] ?? Number.POSITIVE_INFINITY;
    return leftMagnitude === rightMagnitude ? left - right : leftMagnitude - rightMagnitude;
  });
  return indices;
}

/** Setup-only ownership boundary for the complete static star catalog draw. */
export class Starfield {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  private readonly starCount: number;

  constructor(catalog: StarCatalog, pixelRatio: number) {
    assertPixelRatio(pixelRatio);
    this.starCount = catalog.starCount;

    const catalogBuffer = new InterleavedBuffer(catalog.data, STAR_STRIDE_FLOATS);
    const sizes = new Float32Array(catalog.starCount);
    const opacities = new Float32Array(catalog.starCount);
    for (let starIndex = 0; starIndex < catalog.starCount; starIndex += 1) {
      const magnitude = catalog.data[starIndex * STAR_STRIDE_FLOATS + 3] as number;
      sizes[starIndex] = magnitudeToStarSizeCssPx(magnitude);
      opacities[starIndex] = magnitudeToStarOpacity(magnitude);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new InterleavedBufferAttribute(catalogBuffer, 3, 0));
    geometry.setAttribute('aMagnitude', new InterleavedBufferAttribute(catalogBuffer, 1, 3));
    geometry.setAttribute('aColor', new InterleavedBufferAttribute(catalogBuffer, 3, 4));
    geometry.setAttribute('aSizeCssPx', new BufferAttribute(sizes, 1));
    geometry.setAttribute('aOpacity', new BufferAttribute(opacities, 1));
    geometry.setIndex(new BufferAttribute(createMagnitudeOrderedStarIndices(catalog), 1));
    geometry.setDrawRange(0, catalog.starCount);

    const material = new ShaderMaterial({
      name: 'SolarVoyagerStarfield',
      uniforms: {
        uRadiusKm: { value: STARFIELD_RADIUS_KM },
        uPixelRatio: { value: pixelRatio },
        uObserverBeta: { value: new Vector3() },
        uObserverGamma: { value: 1 },
        uRelativisticActivation: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: true,
      depthFunc: LessEqualDepth,
      depthWrite: false,
      toneMapped: false,
    });

    this.points = new Points(geometry, material);
    this.points.name = 'starfield';
    this.points.matrixAutoUpdate = false;
    this.points.frustumCulled = false;
    this.points.updateMatrix();
  }

  setPixelRatio(pixelRatio: number): void {
    assertPixelRatio(pixelRatio);
    const uniform = this.points.material.uniforms.uPixelRatio;
    if (uniform !== undefined) uniform.value = pixelRatio;
  }

  setRelativisticObserver(state: Readonly<RelativisticVisualState>): void {
    const uniforms = this.points.material.uniforms;
    const beta = uniforms.uObserverBeta?.value as Vector3 | undefined;
    if (beta !== undefined) beta.set(state.betaX, state.betaY, state.betaZ);
    if (uniforms.uObserverGamma !== undefined) uniforms.uObserverGamma.value = state.gamma;
    if (uniforms.uRelativisticActivation !== undefined) {
      uniforms.uRelativisticActivation.value = state.activation;
    }
  }

  setCountCap(countCap: number): void {
    if (!Number.isInteger(countCap) || countCap <= 0) {
      throw new RangeError(`starfield count cap must be a positive integer: ${countCap}`);
    }
    this.points.geometry.setDrawRange(0, Math.min(this.starCount, countCap));
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
