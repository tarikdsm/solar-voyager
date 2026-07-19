import {
  MeshStandardMaterial,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import type { GasGiantUniforms } from './gasGiantAnimationState.js';

const PROGRAM_CACHE_KEY = 'solar-voyager-gas-giant-v1';

export interface PreparedGasGiantMaterial {
  dispose(): void;
}

const FRAGMENT_DECLARATIONS = /* glsl */ `
uniform float uGasEnabled;
uniform float uGasOctaves;
uniform vec2 uGasSeed;
uniform vec4 uGasBandPhases;
uniform vec4 uGasStormPhase;
uniform vec4 uGasSpot;
uniform vec4 uGasWarp;

float gasHash31( vec3 cell ) {
  vec3 seedOffset = vec3(
    uGasSeed.x,
    uGasSeed.y,
    uGasSeed.x + uGasSeed.y
  ) * 4096.0;
  vec3 hashPosition = fract( ( cell + seedOffset ) * 0.1031 );
  hashPosition += dot( hashPosition, hashPosition.yzx + 33.33 );
  return fract( ( hashPosition.x + hashPosition.y ) * hashPosition.z );
}

float gasValueNoise( vec3 position ) {
  vec3 cell = floor( position );
  vec3 local = fract( position );
  vec3 fade = local * local * ( vec3( 3.0 ) - 2.0 * local );
  float x00 = mix(
    gasHash31( cell ),
    gasHash31( cell + vec3( 1.0, 0.0, 0.0 ) ),
    fade.x
  );
  float x10 = mix(
    gasHash31( cell + vec3( 0.0, 1.0, 0.0 ) ),
    gasHash31( cell + vec3( 1.0, 1.0, 0.0 ) ),
    fade.x
  );
  float x01 = mix(
    gasHash31( cell + vec3( 0.0, 0.0, 1.0 ) ),
    gasHash31( cell + vec3( 1.0, 0.0, 1.0 ) ),
    fade.x
  );
  float x11 = mix(
    gasHash31( cell + vec3( 0.0, 1.0, 1.0 ) ),
    gasHash31( cell + vec3( 1.0, 1.0, 1.0 ) ),
    fade.x
  );
  return mix( mix( x00, x10, fade.y ), mix( x01, x11, fade.y ), fade.z );
}

float gasFbm( vec3 position ) {
  float value = gasValueNoise( position ) * 0.5333333;
  if ( uGasOctaves > 1.5 ) {
    value += gasValueNoise( position * 2.03 + vec3( 17.0 ) ) * 0.2666667;
  }
  if ( uGasOctaves > 2.5 ) {
    value += gasValueNoise( position * 4.11 + vec3( 41.0 ) ) * 0.1333333;
  }
  if ( uGasOctaves > 3.5 ) {
    value += gasValueNoise( position * 8.23 + vec3( 73.0 ) ) * 0.0666667;
  }
  return value;
}

vec3 gasSphericalDirection( vec2 uv ) {
  float longitude = uv.x * 6.28318530718;
  float latitude = ( uv.y - 0.5 ) * 3.14159265359;
  float cosLatitude = cos( latitude );
  return vec3(
    cos( longitude ) * cosLatitude,
    sin( latitude ),
    sin( longitude ) * cosLatitude
  );
}

float gasWrappedOffset( float fromPhase, float toPhase ) {
  return fract( toPhase - fromPhase + 0.5 ) - 0.5;
}

float gasMixWrapped( float fromPhase, float toPhase, float amount ) {
  return fract( fromPhase + gasWrappedOffset( fromPhase, toPhase ) * amount );
}

float gasBandPhase( float latitude ) {
  float zone = clamp( ( latitude + 1.0 ) * 2.0, 0.0, 3.9999 );
  if ( zone < 1.0 ) {
    return gasMixWrapped( uGasBandPhases.x, uGasBandPhases.y, smoothstep( 0.35, 0.65, zone ) );
  }
  if ( zone < 2.0 ) {
    return gasMixWrapped( uGasBandPhases.y, uGasBandPhases.z, smoothstep( 0.35, 0.65, zone - 1.0 ) );
  }
  if ( zone < 3.0 ) {
    return gasMixWrapped( uGasBandPhases.z, uGasBandPhases.w, smoothstep( 0.35, 0.65, zone - 2.0 ) );
  }
  return uGasBandPhases.w;
}

vec2 gasRotateSpotUv( vec2 uv ) {
  if ( uGasSpot.z <= 0.0 || uGasSpot.w <= 0.0 ) return uv;
  float wrappedU = gasWrappedOffset( uGasSpot.x, uv.x );
  vec2 normalizedDelta = vec2(
    wrappedU / uGasSpot.z,
    ( uv.y - uGasSpot.y ) / uGasSpot.w
  );
  float distanceFromCenter = length( normalizedDelta );
  float spotMask = 1.0 - smoothstep( 0.68, 1.0, distanceFromCenter );
  if ( spotMask <= 0.0 ) return uv;
  float cosine = uGasStormPhase.x;
  float sine = uGasStormPhase.y;
  vec2 rotatedDelta = mat2( cosine, -sine, sine, cosine ) * normalizedDelta;
  vec2 targetUv = vec2(
    uGasSpot.x + rotatedDelta.x * uGasSpot.z,
    uGasSpot.y + rotatedDelta.y * uGasSpot.w
  );
  return vec2(
    fract( uv.x + gasWrappedOffset( uv.x, targetUv.x ) * spotMask ),
    mix( uv.y, targetUv.y, spotMask )
  );
}

vec2 gasAnimateUv( vec2 authoredUv ) {
  vec2 spotUv = gasRotateSpotUv( authoredUv );
  float latitude = spotUv.y * 2.0 - 1.0;
  float bandPhase = gasBandPhase( latitude );
  vec3 direction = gasSphericalDirection( spotUv );
  vec3 motion = vec3( uGasStormPhase.zw, uGasWarp.w ) * 0.5;
  float firstWarp = gasFbm( direction * uGasWarp.z + motion );
  float secondWarp = gasFbm( direction.yzx * ( uGasWarp.z * 0.73 ) - motion.zxy );
  vec2 gasWarp = vec2(
    ( firstWarp - 0.5 ) * uGasWarp.x * 2.0,
    ( secondWarp - 0.5 ) * uGasWarp.y * 2.0
  );
  gasWarp.x = clamp( gasWarp.x, -0.006, 0.006 );
  gasWarp.y = clamp( gasWarp.y, -0.002, 0.002 );
  return vec2(
    fract( spotUv.x + bandPhase + gasWarp.x ),
    clamp( spotUv.y + gasWarp.y, 0.0001, 0.9999 )
  );
}

float gasStormShimmer( vec2 animatedUv ) {
  vec3 direction = gasSphericalDirection( animatedUv );
  vec3 motion = vec3( uGasStormPhase.zw, uGasWarp.w );
  float shimmerNoise = gasFbm( direction * ( uGasWarp.z * 2.0 ) + motion );
  float shimmerSignal = smoothstep( 0.32, 0.68, shimmerNoise ) * 2.0 - 1.0;
  float gasShimmer = 1.0 + shimmerSignal * 0.015;
  return clamp( gasShimmer, 0.985, 1.015 );
}
`;

const MAP_WRAPPER = /* glsl */ `
vec2 gasAnimatedUv = vMapUv;
float gasShimmer = 1.0;
if ( uGasEnabled > 0.5 ) {
  gasAnimatedUv = gasAnimateUv( vMapUv );
  gasShimmer = gasStormShimmer( gasAnimatedUv );
}
#define vMapUv gasAnimatedUv
#include <map_fragment>
diffuseColor.rgb *= clamp( gasShimmer, 0.985, 1.015 );
#undef vMapUv
`;

function injectAfter(source: string, marker: string, addition: string): string {
  if (!source.includes(marker)) throw new Error(`Gas-giant shader requires ${marker}.`);
  return source.replace(marker, `${marker}\n${addition}`);
}

function replaceMarker(source: string, marker: string, replacement: string): string {
  if (!source.includes(marker)) throw new Error(`Gas-giant shader requires ${marker}.`);
  return source.replace(marker, replacement);
}

/** Extends one authored gas-giant surface without replacing its material or map. */
export function prepareGasGiantMaterial(
  material: Material,
  uniforms: GasGiantUniforms,
): PreparedGasGiantMaterial {
  if (
    !(material instanceof MeshStandardMaterial) ||
    material.name !== 'mat_surface' ||
    material.map === null
  ) {
    throw new TypeError('Gas-giant animation requires a mapped mat_surface Standard material.');
  }

  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;
  const compileExtension = (
    shader: WebGLProgramParametersWithUniforms,
    renderer: Parameters<typeof material.onBeforeCompile>[1],
  ): void => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = replaceMarker(
      injectAfter(shader.fragmentShader, '#include <common>', FRAGMENT_DECLARATIONS),
      '#include <map_fragment>',
      MAP_WRAPPER,
    );
  };
  const cacheKeyExtension = (): string => `${previousCacheKey.call(material)}|${PROGRAM_CACHE_KEY}`;

  material.onBeforeCompile = compileExtension;
  material.customProgramCacheKey = cacheKeyExtension;
  material.needsUpdate = true;

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (material.onBeforeCompile === compileExtension) {
        material.onBeforeCompile = previousCompile;
      }
      if (material.customProgramCacheKey === cacheKeyExtension) {
        material.customProgramCacheKey = previousCacheKey;
      }
      material.needsUpdate = true;
    },
  };
}
