import {
  AdditiveBlending,
  Material,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';

import {
  prepareProceduralSunMaterial,
  type PreparedProceduralSunMaterial,
} from './proceduralSunMaterial.js';
import { ProceduralSunState, type ProceduralSunQuality } from './proceduralSunState.js';
import type { CameraRelativeSpaceScene } from './spaceScene.js';

export const SUN_BILLBOARD_DIAMETER_IN_RADII = 8;

export interface ProceduralSunMaterialPort {
  prepareMaterial(material: Material): void;
}

const BILLBOARD_VERTEX_SHADER = /* glsl */ `
varying vec2 vSunBillboardUv;
uniform float uSunBillboardDiameterKm;

void main() {
  vSunBillboardUv = uv;
  vec4 sunCenterView = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
  sunCenterView.xy += position.xy * uSunBillboardDiameterKm;
  gl_Position = projectionMatrix * sunCenterView;
}
`;

const BILLBOARD_FRAGMENT_SHADER = /* glsl */ `
varying vec2 vSunBillboardUv;
uniform float uSunEnabled;
uniform float uSunOctaves;
uniform vec2 uSunSeed;
uniform vec4 uSunTimePhases;

float sunCorona( vec2 point ) {
  float radius = length( point );
  float outsideDisc = smoothstep( 0.98, 1.03, radius );
  float outerFalloff = 1.0 - smoothstep( 1.0, 4.0, radius );
  float angle = atan( point.y, point.x );
  float seedPhase = ( uSunSeed.x * 17.0 + uSunSeed.y * 31.0 ) * 6.2831853;
  float rays = 0.72 + 0.10 * sin( angle * 11.0 + seedPhase + uSunTimePhases.w );
  if ( uSunOctaves > 1.5 ) {
    rays += 0.07 * sin( angle * 23.0 - seedPhase * 0.7 - uSunTimePhases.z );
  }
  if ( uSunOctaves > 2.5 ) {
    rays += 0.04 * sin( angle * 47.0 + seedPhase * 1.3 + uSunTimePhases.w );
  }
  if ( uSunOctaves > 3.5 ) {
    rays += 0.025 * sin( angle * 89.0 - seedPhase * 1.9 + uSunTimePhases.z );
  }
  return outsideDisc * outerFalloff * outerFalloff * max( 0.2, rays );
}

float sunProminenceArc( vec2 point, float angle, float height, float width ) {
  mat2 rotation = mat2( cos( angle ), -sin( angle ), sin( angle ), cos( angle ) );
  vec2 local = rotation * point;
  vec2 center = vec2( 0.0, 1.0 + height * 0.45 );
  vec2 scaled = ( local - center ) / vec2( 0.45 + height * 0.25, height );
  float ring = abs( length( scaled ) - 1.0 );
  return 1.0 - smoothstep( width, width * 2.0, ring );
}

float sunArcActivity( float phaseOffset ) {
  vec2 phaseDirection = vec2( cos( phaseOffset ), sin( phaseOffset ) );
  float periodicValue = dot( uSunTimePhases.zw, phaseDirection ) * 0.5 + 0.5;
  return smoothstep( 0.48, 0.82, periodicValue );
}

void main() {
  if ( uSunEnabled < 0.5 ) discard;
  vec2 point = ( vSunBillboardUv - vec2( 0.5 ) ) * 8.0;
  float radius = length( point );
  float seedAngle = ( uSunSeed.x * 19.0 + uSunSeed.y * 43.0 ) * 6.2831853;
  float limbMask = smoothstep( 1.0, 1.03, radius ) *
    ( 1.0 - smoothstep( 1.52, 1.55, radius ) );
  float arc0 = sunProminenceArc( point, seedAngle, 0.34, 0.055 ) *
    sunArcActivity( seedAngle + 0.2 );
  float arc1 = sunProminenceArc( point, seedAngle + 2.17, 0.48, 0.045 ) *
    sunArcActivity( seedAngle + 2.5 );
  float arc2 = sunProminenceArc( point, seedAngle + 4.51, 0.28, 0.065 ) *
    sunArcActivity( seedAngle + 4.9 );
  float prominences = max( arc0, max( arc1, arc2 ) ) * limbMask;
  float corona = sunCorona( point );
  vec3 color = corona * vec3( 1.8, 0.75, 0.18 ) +
    prominences * vec3( 3.8, 0.65, 0.08 );
  float alpha = clamp( corona * 0.45 + prominences, 0.0, 1.0 );
  if ( alpha < 0.002 ) discard;
  gl_FragColor = vec4( color, alpha );
}
`;

function assertPackedPosition(positionsKm: Float64Array, componentOffset: number): void {
  if (positionsKm.length === 0 || positionsKm.length % 3 !== 0) {
    throw new RangeError('Procedural Sun packed positions must contain xyz triples.');
  }
  for (let index = 0; index < positionsKm.length; index += 1) {
    if (!Number.isFinite(positionsKm[index])) {
      throw new RangeError('Procedural Sun packed positions must be finite.');
    }
  }
  if (
    !Number.isInteger(componentOffset) ||
    componentOffset < 0 ||
    componentOffset % 3 !== 0 ||
    componentOffset + 2 >= positionsKm.length
  ) {
    throw new RangeError('Procedural Sun offset must address one xyz triple.');
  }
}

/** Owns the shared photosphere state and one setup-time off-limb billboard. */
export class ProceduralSun implements ProceduralSunMaterialPort {
  readonly billboard: Mesh<PlaneGeometry, ShaderMaterial>;
  readonly seed: number;

  private readonly state: ProceduralSunState;
  private readonly preparedMaterials: PreparedProceduralSunMaterial[] = [];
  private disposed = false;

  constructor(
    private readonly spaceScene: CameraRelativeSpaceScene,
    positionsKm: Float64Array,
    componentOffset: number,
    solarRadiusKm: number,
    seed: number,
  ) {
    assertPackedPosition(positionsKm, componentOffset);
    if (!Number.isFinite(solarRadiusKm) || solarRadiusKm <= 0) {
      throw new RangeError('Procedural Sun radius must be positive and finite.');
    }

    this.state = new ProceduralSunState(seed);
    this.seed = seed;
    const geometry = new PlaneGeometry(1, 1);
    geometry.computeBoundingSphere();
    if (geometry.boundingSphere === null) {
      throw new Error('Procedural Sun billboard requires a bounding sphere.');
    }
    geometry.boundingSphere.radius = (solarRadiusKm * SUN_BILLBOARD_DIAMETER_IN_RADII) / 2;
    const material = new ShaderMaterial({
      uniforms: {
        ...this.state.uniforms,
        uSunBillboardDiameterKm: {
          value: solarRadiusKm * SUN_BILLBOARD_DIAMETER_IN_RADII,
        },
      },
      vertexShader: BILLBOARD_VERTEX_SHADER,
      fragmentShader: BILLBOARD_FRAGMENT_SHADER,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: true,
    });
    material.name = 'sun-procedural-billboard';
    this.billboard = new Mesh(geometry, material);
    this.billboard.name = 'sun-glare';
    this.billboard.frustumCulled = true;
    this.spaceScene.bindPackedVisual(this.billboard, positionsKm, componentOffset);
  }

  prepareMaterial(material: Material): void {
    if (this.disposed) throw new Error('Procedural Sun is disposed.');
    if (!(material instanceof MeshLambertMaterial) && !(material instanceof MeshStandardMaterial)) {
      throw new TypeError('Procedural Sun requires a Lambert or Standard material.');
    }
    this.preparedMaterials.push(prepareProceduralSunMaterial(material, this.state.uniforms));
  }

  update(simTimeSec: number): void {
    this.state.update(simTimeSec);
  }

  setQuality(quality: ProceduralSunQuality): void {
    this.state.setQuality(quality);
  }

  setEnabled(enabled: boolean): void {
    this.state.setEnabled(enabled);
    this.billboard.visible = enabled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let index = 0; index < this.preparedMaterials.length; index += 1) {
      this.preparedMaterials[index]?.dispose();
    }
    this.spaceScene.unbindVisual(this.billboard);
    this.billboard.geometry.dispose();
    this.billboard.material.dispose();
  }
}
