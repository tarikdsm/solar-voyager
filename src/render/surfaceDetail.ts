import {
  Vector2,
  type IUniform,
  type MeshStandardMaterial,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import type { LoadedSurfaceDetail } from './bodyAssetLoader.js';

const DETAIL_START_RADII = 5;
const DETAIL_FULL_RADII = 1.2;
const PROCEDURAL_START_RADII = 1.5;
const PROGRAM_CACHE_KEY = 'solar-voyager-surface-detail-v1';

interface SurfaceDetailUniforms extends Record<string, IUniform> {
  readonly uSurfaceDetailAlbedo: IUniform<Texture>;
  readonly uSurfaceDetailNormal: IUniform<Texture>;
  readonly uSurfaceDetailBlend: IUniform<number>;
  readonly uSurfaceProceduralBlend: IUniform<number>;
  readonly uSurfaceTilesPerEquator: IUniform<number>;
  readonly uSurfaceDetailSeed: IUniform<Vector2>;
}

export interface PreparedSurfaceDetail {
  readonly blend: number;
  readonly proceduralBlend: number;
  setDistance(distanceKm: number, radiusKm: number): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

function assertPhysicalDistance(distanceKm: number, radiusKm: number): number {
  if (
    !Number.isFinite(distanceKm) ||
    distanceKm < 0 ||
    !Number.isFinite(radiusKm) ||
    radiusKm <= 0
  ) {
    throw new RangeError('Surface-detail distance and radius must be finite and physical.');
  }
  return distanceKm / radiusKm;
}

function cubicBlend(ratio: number, startRadii: number, fullRadii: number): number {
  const linear = Math.min(1, Math.max(0, (startRadii - ratio) / (startRadii - fullRadii)));
  return linear * linear * (3 - 2 * linear);
}

export function surfaceDetailBlend(distanceKm: number, radiusKm: number): number {
  return cubicBlend(
    assertPhysicalDistance(distanceKm, radiusKm),
    DETAIL_START_RADII,
    DETAIL_FULL_RADII,
  );
}

export function surfaceDetailProceduralBlend(distanceKm: number, radiusKm: number): number {
  return cubicBlend(
    assertPhysicalDistance(distanceKm, radiusKm),
    PROCEDURAL_START_RADII,
    DETAIL_FULL_RADII,
  );
}

const VERTEX_DECLARATIONS = /* glsl */ `
varying vec2 vSurfaceDetailUv;
varying vec3 vSurfaceDetailDirection;
`;

const VERTEX_ASSIGNMENTS = /* glsl */ `
vSurfaceDetailUv = uv;
vSurfaceDetailDirection = normalize( position );
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec2 vSurfaceDetailUv;
varying vec3 vSurfaceDetailDirection;
uniform sampler2D uSurfaceDetailAlbedo;
uniform sampler2D uSurfaceDetailNormal;
uniform float uSurfaceDetailBlend;
uniform float uSurfaceProceduralBlend;
uniform float uSurfaceTilesPerEquator;
uniform vec2 uSurfaceDetailSeed;

vec3 surfaceDetailHash3( vec3 position ) {
  position = fract( position * vec3( 0.1031, 0.1030, 0.0973 ) );
  position += dot( position, position.yxz + 33.33 );
  return fract( ( position.xxy + position.yxx ) * position.zyx );
}

vec3 surfaceDetailNoise3( vec3 position ) {
  vec3 cell = floor( position ) + vec3(
    uSurfaceDetailSeed.x * 13.13 + uSurfaceDetailSeed.y * 37.17,
    uSurfaceDetailSeed.x * 29.31 + uSurfaceDetailSeed.y * 11.73,
    uSurfaceDetailSeed.x * 47.19 + uSurfaceDetailSeed.y * 23.57
  );
  vec3 local = fract( position );
  local = local * local * ( vec3( 3.0 ) - 2.0 * local );
  vec3 n000 = surfaceDetailHash3( cell );
  vec3 n100 = surfaceDetailHash3( cell + vec3( 1.0, 0.0, 0.0 ) );
  vec3 n010 = surfaceDetailHash3( cell + vec3( 0.0, 1.0, 0.0 ) );
  vec3 n110 = surfaceDetailHash3( cell + vec3( 1.0, 1.0, 0.0 ) );
  vec3 n001 = surfaceDetailHash3( cell + vec3( 0.0, 0.0, 1.0 ) );
  vec3 n101 = surfaceDetailHash3( cell + vec3( 1.0, 0.0, 1.0 ) );
  vec3 n011 = surfaceDetailHash3( cell + vec3( 0.0, 1.0, 1.0 ) );
  vec3 n111 = surfaceDetailHash3( cell + vec3( 1.0, 1.0, 1.0 ) );
  vec3 nx00 = mix( n000, n100, local.x );
  vec3 nx10 = mix( n010, n110, local.x );
  vec3 nx01 = mix( n001, n101, local.x );
  vec3 nx11 = mix( n011, n111, local.x );
  return mix( mix( nx00, nx10, local.y ), mix( nx01, nx11, local.y ), local.z );
}

vec3 surfaceDetailFbm3( vec3 position ) {
  return surfaceDetailNoise3( position ) * 0.6666667 +
    surfaceDetailNoise3( position * 2.03 + vec3( 17.0 ) ) * 0.3333333;
}

mat3 surfaceDetailTangentFrame( vec3 eyePosition, vec3 surfaceNormal, vec2 surfaceUv ) {
  vec3 q0 = dFdx( eyePosition );
  vec3 q1 = dFdy( eyePosition );
  vec2 st0 = dFdx( surfaceUv );
  vec2 st1 = dFdy( surfaceUv );
  vec3 q1Perpendicular = cross( q1, surfaceNormal );
  vec3 q0Perpendicular = cross( surfaceNormal, q0 );
  vec3 tangent = q1Perpendicular * st0.x + q0Perpendicular * st1.x;
  vec3 bitangent = q1Perpendicular * st0.y + q0Perpendicular * st1.y;
  float determinant = max( dot( tangent, tangent ), dot( bitangent, bitangent ) );
  float scale = determinant == 0.0 ? 0.0 : inversesqrt( determinant );
  return mat3( tangent * scale, bitangent * scale, surfaceNormal );
}
`;

const PROCEDURAL_DETAIL = /* glsl */ `
vec3 surfaceDetailProceduralNoise = vec3( 0.5 );
if ( uSurfaceDetailBlend > 0.0 && uSurfaceProceduralBlend > 0.0 ) {
  surfaceDetailProceduralNoise = surfaceDetailFbm3(
    normalize( vSurfaceDetailDirection ) * 96.0
  );
}
`;

const ALBEDO_DETAIL = /* glsl */ `
if ( uSurfaceDetailBlend > 0.0 ) {
  vec2 surfaceDetailMacroUv = vSurfaceDetailUv * uSurfaceTilesPerEquator;
  vec2 surfaceDetailMicroUv =
    mat2( 0.8829, 0.4695, -0.4695, 0.8829 ) *
    ( vSurfaceDetailUv * ( uSurfaceTilesPerEquator * 7.73 ) ) + vec2( 0.371, 0.619 );
  vec3 surfaceDetailMacroAlbedo = texture2D( uSurfaceDetailAlbedo, surfaceDetailMacroUv ).rgb;
  vec3 surfaceDetailMicroAlbedo = texture2D( uSurfaceDetailAlbedo, surfaceDetailMicroUv ).rgb;
  vec3 surfaceDetailVariation = mix( surfaceDetailMacroAlbedo, surfaceDetailMicroAlbedo, 0.35 ) - vec3( 0.21404114 );
  diffuseColor.rgb *= vec3( 1.0 ) + surfaceDetailVariation * ( 0.12 * uSurfaceDetailBlend );
}
`;

const NORMAL_DETAIL = /* glsl */ `
if ( uSurfaceDetailBlend > 0.0 ) {
  vec2 surfaceDetailMacroUv = vSurfaceDetailUv * uSurfaceTilesPerEquator;
  vec2 surfaceDetailMicroUv =
    mat2( 0.8829, 0.4695, -0.4695, 0.8829 ) *
    ( vSurfaceDetailUv * ( uSurfaceTilesPerEquator * 7.73 ) ) + vec2( 0.371, 0.619 );
  vec3 surfaceDetailMacroNormal = texture2D( uSurfaceDetailNormal, surfaceDetailMacroUv ).xyz * 2.0 - 1.0;
  vec3 surfaceDetailMicroNormal = texture2D( uSurfaceDetailNormal, surfaceDetailMicroUv ).xyz * 2.0 - 1.0;
  vec2 surfaceDetailNormalXy = surfaceDetailMacroNormal.xy * 0.08 + surfaceDetailMicroNormal.xy * 0.03;
  if ( uSurfaceProceduralBlend > 0.0 ) {
    surfaceDetailNormalXy += ( surfaceDetailProceduralNoise.xy - vec2( 0.5 ) ) *
      ( 0.12 * uSurfaceProceduralBlend );
  }
  surfaceDetailNormalXy *= uSurfaceDetailBlend;
  vec3 surfaceDetailTangentNormal = normalize( vec3(
    surfaceDetailNormalXy,
    sqrt( max( 0.05, 1.0 - min( 0.95, dot( surfaceDetailNormalXy, surfaceDetailNormalXy ) ) ) )
  ) );
  #ifdef USE_NORMALMAP_TANGENTSPACE
    normal = normalize(
      normal + tbn * vec3( surfaceDetailTangentNormal.xy, 0.0 )
    );
  #else
    mat3 surfaceDetailFrame = surfaceDetailTangentFrame(
      -vViewPosition,
      normal,
      vSurfaceDetailUv
    );
    normal = normalize( surfaceDetailFrame * surfaceDetailTangentNormal );
  #endif
}
`;

const ROUGHNESS_DETAIL = /* glsl */ `
if ( uSurfaceDetailBlend > 0.0 && uSurfaceProceduralBlend > 0.0 ) {
  roughnessFactor = clamp(
    roughnessFactor + ( surfaceDetailProceduralNoise.z - 0.5 ) *
      ( 0.16 * uSurfaceProceduralBlend ),
    0.04,
    1.0
  );
}
`;

class PreparedSurfaceDetailImpl implements PreparedSurfaceDetail {
  private enabled = true;
  private detailBlend = 0;
  private proceduralBlendValue = 0;
  private disposed = false;

  constructor(
    private readonly uniforms: SurfaceDetailUniforms,
    private readonly albedo: Texture,
    private readonly normal: Texture,
  ) {}

  get blend(): number {
    return this.enabled ? this.detailBlend : 0;
  }

  get proceduralBlend(): number {
    return this.enabled ? this.proceduralBlendValue : 0;
  }

  setDistance(distanceKm: number, radiusKm: number): void {
    this.detailBlend = surfaceDetailBlend(distanceKm, radiusKm);
    this.proceduralBlendValue = surfaceDetailProceduralBlend(distanceKm, radiusKm);
    this.applyBlends();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.applyBlends();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.albedo.dispose();
    this.normal.dispose();
  }

  private applyBlends(): void {
    this.uniforms.uSurfaceDetailBlend.value = this.enabled ? this.detailBlend : 0;
    this.uniforms.uSurfaceProceduralBlend.value = this.enabled ? this.proceduralBlendValue : 0;
  }
}

export function prepareSurfaceDetail(
  material: MeshStandardMaterial,
  detail: LoadedSurfaceDetail,
): PreparedSurfaceDetail {
  const uniforms: SurfaceDetailUniforms = {
    uSurfaceDetailAlbedo: { value: detail.albedo },
    uSurfaceDetailNormal: { value: detail.normal },
    uSurfaceDetailBlend: { value: 0 },
    uSurfaceProceduralBlend: { value: 0 },
    uSurfaceTilesPerEquator: { value: detail.tilesPerEquator },
    uSurfaceDetailSeed: {
      value: new Vector2(
        (detail.seed & 0xffff) / 0xffff,
        Math.floor(detail.seed / 65_536) / 0xffff,
      ),
    },
  };
  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer): void => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_ASSIGNMENTS}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARATIONS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${ALBEDO_DETAIL}`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${NORMAL_DETAIL}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `${PROCEDURAL_DETAIL}\n#include <roughnessmap_fragment>\n${ROUGHNESS_DETAIL}`,
      );
  };
  material.customProgramCacheKey = (): string => `${previousCacheKey()}|${PROGRAM_CACHE_KEY}`;
  material.needsUpdate = true;
  return new PreparedSurfaceDetailImpl(uniforms, detail.albedo, detail.normal);
}
