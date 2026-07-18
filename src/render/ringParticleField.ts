import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  RGBAFormat,
  ShaderMaterial,
  StaticDrawUsage,
  Vector3,
  type IUniform,
} from 'three';

import type { RingDefinition, RingParticleDefinition } from './ringCatalog.js';

const DENSITY_TEXTURE_WIDTH = 256;
const TWO_PI = Math.PI * 2;

interface ParticleUniforms extends Record<string, IUniform> {
  readonly uRingPatchOrigin: IUniform<Vector3>;
  readonly uRingRadialBasis: IUniform<Vector3>;
  readonly uRingTangentBasis: IUniform<Vector3>;
  readonly uRingPatchRadius: IUniform<number>;
  readonly uRingVerticalThickness: IUniform<number>;
  readonly uRingInnerRadius: IUniform<number>;
  readonly uRingOuterRadius: IUniform<number>;
  readonly uParentRadiusKm: IUniform<number>;
  readonly uParentMuKm3S2: IUniform<number>;
  readonly uRingReducedTimeSec: IUniform<number>;
  readonly uRingRepresentationBlend: IUniform<number>;
  readonly uRingDensityMap: IUniform<DataTexture>;
  readonly uRingBaseColor: IUniform<Color>;
}

const VERTEX_SHADER = /* glsl */ `
precision highp float;

#define RING_MINIMUM_ANGULAR_RADIUS 0.0012

attribute vec4 aRingParticle;

uniform vec3 uRingPatchOrigin;
uniform vec3 uRingRadialBasis;
uniform vec3 uRingTangentBasis;
uniform float uRingPatchRadius;
uniform float uRingVerticalThickness;
uniform float uRingInnerRadius;
uniform float uRingOuterRadius;
uniform float uParentRadiusKm;
uniform float uParentMuKm3S2;
uniform float uRingReducedTimeSec;

varying float vRingDensitySeed;
varying float vRingRadialUv;
varying float vRingIceVariation;

void main() {
  float radialOffset = ( aRingParticle.x * 2.0 - 1.0 ) * uRingPatchRadius;
  float centerRadius = max( uRingInnerRadius, length( uRingPatchOrigin.xz ) + radialOffset );
  float radiusKm = centerRadius * uParentRadiusKm;
  float angularVelocity = sqrt( uParentMuKm3S2 / ( radiusKm * radiusKm * radiusKm ) );
  float orbitalOffset = angularVelocity * uRingReducedTimeSec * centerRadius;
  float patchDiameter = uRingPatchRadius * 2.0;
  float tangentOffset = mod(
    aRingParticle.y * patchDiameter + orbitalOffset + uRingPatchRadius,
    patchDiameter
  ) - uRingPatchRadius;
  float verticalOffset = ( aRingParticle.z * 2.0 - 1.0 ) * uRingVerticalThickness;
  vec3 particleCenter = uRingPatchOrigin +
    uRingRadialBasis * radialOffset +
    uRingTangentBasis * tangentOffset +
    vec3( 0.0, verticalOffset, 0.0 );
  vec3 particleVertex = ( instanceMatrix * vec4( position, 1.0 ) ).xyz;

  vRingDensitySeed = aRingParticle.w;
  vRingRadialUv = clamp(
    ( centerRadius - uRingInnerRadius ) / max( 0.000001, uRingOuterRadius - uRingInnerRadius ),
    0.0,
    1.0
  );
  vRingIceVariation = aRingParticle.x * 0.35 + aRingParticle.z * 0.25;
  vec4 viewCenter = modelViewMatrix * vec4( particleCenter, 1.0 );
  vec3 viewOffset = mat3( modelViewMatrix ) * particleVertex;
  float physicalViewRadius = length( viewOffset );
  float minimumViewRadius = max( 0.0, -viewCenter.z ) * RING_MINIMUM_ANGULAR_RADIUS;
  if ( physicalViewRadius > 0.0 && physicalViewRadius < minimumViewRadius ) {
    viewOffset *= minimumViewRadius / physicalViewRadius;
  }
  gl_Position = projectionMatrix * ( viewCenter + vec4( viewOffset, 0.0 ) );
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uRingDensityMap;
uniform vec3 uRingBaseColor;
uniform float uRingRepresentationBlend;
varying float vRingDensitySeed;
varying float vRingRadialUv;
varying float vRingIceVariation;

void main() {
  vec4 profile = texture2D( uRingDensityMap, vec2( vRingRadialUv, 0.5 ) );
  if ( vRingDensitySeed > profile.a ) discard;
  vec3 color = mix( uRingBaseColor, profile.rgb, 0.55 );
  color *= 0.78 + vRingIceVariation * 0.28;
  gl_FragColor = vec4( color, clamp( uRingRepresentationBlend * 0.92, 0.0, 0.92 ) );
}
`;

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const normalized = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return normalized * normalized * (3 - 2 * normalized);
}

function channel(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16);
}

function createDensityTexture(definition: RingDefinition): DataTexture {
  const pixels = new Uint8Array(DENSITY_TEXTURE_WIDTH * 4);
  const spanKm = definition.outerRadiusKm - definition.innerRadiusKm;
  const featherKm = (spanKm / DENSITY_TEXTURE_WIDTH) * 2;
  for (let index = 0; index < DENSITY_TEXTURE_WIDTH; index += 1) {
    const radiusKm = definition.innerRadiusKm + ((index + 0.5) / DENSITY_TEXTURE_WIDTH) * spanKm;
    let accumulatedDepth = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    for (const band of definition.bands) {
      const enter = smoothstep(
        band.innerRadiusKm - featherKm,
        band.innerRadiusKm + featherKm,
        radiusKm,
      );
      const leave =
        1 - smoothstep(band.outerRadiusKm - featherKm, band.outerRadiusKm + featherKm, radiusKm);
      const weight = Math.max(0, enter * leave) * band.opticalDepth;
      if (weight <= 0) continue;
      accumulatedDepth += weight;
      red += channel(band.color, 1) * weight;
      green += channel(band.color, 3) * weight;
      blue += channel(band.color, 5) * weight;
    }
    const offset = index * 4;
    if (accumulatedDepth > 0) {
      pixels[offset] = Math.round(red / accumulatedDepth);
      pixels[offset + 1] = Math.round(green / accumulatedDepth);
      pixels[offset + 2] = Math.round(blue / accumulatedDepth);
      pixels[offset + 3] = Math.round(
        255 * (1 - Math.exp(-accumulatedDepth * definition.exposure)),
      );
    }
  }
  pixels[3] = 0;
  pixels[pixels.length - 1] = 0;
  const texture = new DataTexture(pixels, DENSITY_TEXTURE_WIDTH, 1, RGBAFormat);
  texture.name = `${definition.bodyId}_ring_particle_density`;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function nextRandom(state: { value: number }): number {
  let value = state.value | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value;
  return (value >>> 0) / 4_294_967_296;
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive.`);
}

export class RingParticleField {
  readonly mesh: InstancedMesh<IcosahedronGeometry, ShaderMaterial>;

  private readonly uniforms: ParticleUniforms;
  private readonly particleDefinition: RingParticleDefinition;
  private readonly parentRadiusKm: number;
  private countCap: number;
  private blendValue = 0;
  private disposed = false;

  constructor(definition: RingDefinition, parentMuKm3S2: number, parentRadiusKm: number) {
    if (definition.particles === null) {
      throw new Error(`Ring system "${definition.bodyId}" has no particle policy.`);
    }
    assertPositive(parentMuKm3S2, 'Parent gravitational parameter');
    assertPositive(parentRadiusKm, 'Parent radius');
    this.particleDefinition = definition.particles;
    this.parentRadiusKm = parentRadiusKm;
    this.countCap = definition.particles.maxCount;

    const densityTexture = createDensityTexture(definition);
    this.uniforms = {
      uRingPatchOrigin: { value: new Vector3() },
      uRingRadialBasis: { value: new Vector3(1, 0, 0) },
      uRingTangentBasis: { value: new Vector3(0, 0, 1) },
      uRingPatchRadius: { value: definition.particles.patchRadiusKm / parentRadiusKm },
      uRingVerticalThickness: {
        value: definition.particles.verticalThicknessKm / parentRadiusKm,
      },
      uRingInnerRadius: { value: definition.innerRadiusRatio },
      uRingOuterRadius: { value: definition.outerRadiusRatio },
      uParentRadiusKm: { value: parentRadiusKm },
      uParentMuKm3S2: { value: parentMuKm3S2 },
      uRingReducedTimeSec: { value: 0 },
      uRingRepresentationBlend: { value: 0 },
      uRingDensityMap: { value: densityTexture },
      uRingBaseColor: { value: new Color(definition.baseColor) },
    };

    const geometry = new IcosahedronGeometry(1, 0);
    const seeds = new Float32Array(definition.particles.maxCount * 4);
    const material = new ShaderMaterial({
      name: `${definition.bodyId}_ring_particle_material`,
      uniforms: this.uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new InstancedMesh(geometry, material, definition.particles.maxCount);
    this.mesh.name = `${definition.bodyId}_ring_particles`;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.instanceMatrix.setUsage(StaticDrawUsage);

    const random = { value: definition.particles.seed || 1 };
    const transform = new Matrix4();
    const minSizeKm = definition.particles.minSizeM / 1000;
    const maxSizeKm = definition.particles.maxSizeM / 1000;
    for (let index = 0; index < definition.particles.maxCount; index += 1) {
      const offset = index * 4;
      seeds[offset] = nextRandom(random);
      seeds[offset + 1] = nextRandom(random);
      seeds[offset + 2] = nextRandom(random);
      seeds[offset + 3] = nextRandom(random);
      const sizeMix = nextRandom(random);
      const sizeKm = minSizeKm * Math.pow(maxSizeKm / minSizeKm, sizeMix);
      transform.makeScale(
        sizeKm / parentRadiusKm,
        sizeKm / parentRadiusKm,
        sizeKm / parentRadiusKm,
      );
      this.mesh.setMatrixAt(index, transform);
    }
    geometry.setAttribute('aRingParticle', new InstancedBufferAttribute(seeds, 4, false));
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get blend(): number {
    return this.blendValue;
  }

  update(
    cameraLocalX: number,
    cameraLocalY: number,
    cameraLocalZ: number,
    simTimeSec: number,
  ): number {
    if (
      !Number.isFinite(cameraLocalX) ||
      !Number.isFinite(cameraLocalY) ||
      !Number.isFinite(cameraLocalZ)
    ) {
      throw new RangeError('Ring particle camera coordinates must be finite.');
    }
    if (!Number.isFinite(simTimeSec)) {
      throw new RangeError('Ring particle simulation time must be finite.');
    }

    const radius = Math.hypot(cameraLocalX, cameraLocalZ);
    const patchRadius = this.uniforms.uRingPatchRadius.value;
    const radialEnter = smoothstep(
      this.uniforms.uRingInnerRadius.value - patchRadius,
      this.uniforms.uRingInnerRadius.value,
      radius,
    );
    const radialLeave =
      1 -
      smoothstep(
        this.uniforms.uRingOuterRadius.value,
        this.uniforms.uRingOuterRadius.value + patchRadius,
        radius,
      );
    const vertical = 1 - smoothstep(patchRadius * 0.25, patchRadius, Math.abs(cameraLocalY));
    this.blendValue = this.countCap === 0 ? 0 : radialEnter * radialLeave * vertical;
    this.mesh.count = this.blendValue > 0 ? this.countCap : 0;
    this.uniforms.uRingRepresentationBlend.value = this.blendValue;

    const safeRadius = Math.max(this.uniforms.uRingInnerRadius.value, radius);
    const inverseRadius = radius > 0 ? 1 / radius : 0;
    const radialX = radius > 0 ? cameraLocalX * inverseRadius : 1;
    const radialZ = radius > 0 ? cameraLocalZ * inverseRadius : 0;
    this.uniforms.uRingPatchOrigin.value.set(radialX * safeRadius, 0, radialZ * safeRadius);
    this.uniforms.uRingRadialBasis.value.set(radialX, 0, radialZ);
    this.uniforms.uRingTangentBasis.value.set(-radialZ, 0, radialX);

    const physicalRadiusKm = safeRadius * this.parentRadiusKm;
    const angularVelocity = Math.sqrt(
      this.uniforms.uParentMuKm3S2.value / Math.pow(physicalRadiusKm, 3),
    );
    const periodSec = TWO_PI / angularVelocity;
    this.uniforms.uRingReducedTimeSec.value = ((simTimeSec % periodSec) + periodSec) % periodSec;
    return this.blendValue;
  }

  setCountCap(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > this.particleDefinition.maxCount) {
      throw new RangeError(
        `Ring particle count cap must be an integer from 0 to ${String(this.particleDefinition.maxCount)}.`,
      );
    }
    this.countCap = count;
    if (count === 0) {
      this.blendValue = 0;
      this.uniforms.uRingRepresentationBlend.value = 0;
      this.mesh.count = 0;
    } else if (this.blendValue > 0) {
      this.mesh.count = count;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.uniforms.uRingDensityMap.value.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
