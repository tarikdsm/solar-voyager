import {
  MeshLambertMaterial,
  MeshStandardMaterial,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import type { ProceduralSunUniforms } from './proceduralSunState.js';

const PROGRAM_CACHE_KEY = 'solar-voyager-procedural-sun-v1';

type ProceduralSunMaterial = MeshLambertMaterial | MeshStandardMaterial;

export interface PreparedProceduralSunMaterial {
  dispose(): void;
}

const VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 vSunObjectDirection;
varying vec3 vSunViewNormal;
varying vec3 vSunViewPosition;
`;

const VERTEX_ASSIGNMENTS = /* glsl */ `
vSunObjectDirection = normalize( position );
vSunViewNormal = normalize( normalMatrix * normal );
vSunViewPosition = -( modelViewMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec3 vSunObjectDirection;
varying vec3 vSunViewNormal;
varying vec3 vSunViewPosition;
uniform float uSunEnabled;
uniform float uSunOctaves;
uniform vec2 uSunSeed;
uniform vec4 uSunTimePhases;

float sunHash31( vec3 cell ) {
  vec3 seedOffset = vec3(
    uSunSeed.x,
    uSunSeed.y,
    uSunSeed.x + uSunSeed.y
  ) * 4096.0;
  vec3 hashPosition = fract( ( cell + seedOffset ) * 0.1031 );
  hashPosition += dot( hashPosition, hashPosition.yzx + 33.33 );
  return fract( ( hashPosition.x + hashPosition.y ) * hashPosition.z );
}

float sunValueNoise( vec3 position ) {
  vec3 cell = floor( position );
  vec3 local = fract( position );
  vec3 fade = local * local * ( vec3( 3.0 ) - 2.0 * local );
  float x00 = mix(
    sunHash31( cell ),
    sunHash31( cell + vec3( 1.0, 0.0, 0.0 ) ),
    fade.x
  );
  float x10 = mix(
    sunHash31( cell + vec3( 0.0, 1.0, 0.0 ) ),
    sunHash31( cell + vec3( 1.0, 1.0, 0.0 ) ),
    fade.x
  );
  float x01 = mix(
    sunHash31( cell + vec3( 0.0, 0.0, 1.0 ) ),
    sunHash31( cell + vec3( 1.0, 0.0, 1.0 ) ),
    fade.x
  );
  float x11 = mix(
    sunHash31( cell + vec3( 0.0, 1.0, 1.0 ) ),
    sunHash31( cell + vec3( 1.0, 1.0, 1.0 ) ),
    fade.x
  );
  return mix( mix( x00, x10, fade.y ), mix( x01, x11, fade.y ), fade.z );
}

float sunFbm( vec3 position ) {
  float value = sunValueNoise( position ) * 0.5333333;
  if ( uSunOctaves > 1.5 ) {
    value += sunValueNoise( position * 2.03 + vec3( 17.0 ) ) * 0.2666667;
  }
  if ( uSunOctaves > 2.5 ) {
    value += sunValueNoise( position * 4.11 + vec3( 41.0 ) ) * 0.1333333;
  }
  if ( uSunOctaves > 3.5 ) {
    value += sunValueNoise( position * 8.23 + vec3( 73.0 ) ) * 0.0666667;
  }
  return value;
}

float sunDomainWarpedFbm( vec3 direction ) {
  vec3 motion = vec3( uSunTimePhases.xy, uSunTimePhases.z ) * 0.35;
  float warp = sunFbm( direction * 32.0 + motion );
  return sunFbm( direction * 256.0 + vec3( warp * 3.0 ) - motion.yzx );
}
`;

const FRAGMENT_OUTPUT = /* glsl */ `
if ( uSunEnabled > 0.5 ) {
  float sunGranulation = sunDomainWarpedFbm( normalize( vSunObjectDirection ) );
  float sunMu = clamp(
    dot( normalize( vSunViewNormal ), normalize( vSunViewPosition ) ),
    0.0,
    1.0
  );
  float sunOneMinusMu = 1.0 - sunMu;
  float sunLimb = 1.0 - 0.52 * sunOneMinusMu -
    0.16 * sunOneMinusMu * sunOneMinusMu;
  float sunContrast = mix(
    0.88,
    1.12,
    smoothstep( 0.30, 0.70, sunGranulation )
  );
  sunContrast = mix( 1.0, sunContrast, smoothstep( 0.0, 0.35, sunMu ) );
  vec3 sunLane = vec3( 1.6, 0.65, 0.105 );
  vec3 sunCell = vec3( 2.8, 1.52, 0.36 );
  vec3 sunHdrColor = mix( sunLane, sunCell, sunGranulation ) * sunLimb * sunContrast;
  outgoingLight = sunHdrColor;
}
`;

function injectAfter(source: string, marker: string, addition: string): string {
  if (!source.includes(marker)) {
    throw new Error(`Procedural Sun shader requires ${marker}.`);
  }
  return source.replace(marker, `${marker}\n${addition}`);
}

function injectBefore(source: string, marker: string, addition: string): string {
  if (!source.includes(marker)) {
    throw new Error(`Procedural Sun shader requires ${marker}.`);
  }
  return source.replace(marker, `${addition}\n${marker}`);
}

/** Extends one lit Three material while retaining its authored fallback path. */
export function prepareProceduralSunMaterial(
  material: ProceduralSunMaterial,
  uniforms: ProceduralSunUniforms,
): PreparedProceduralSunMaterial {
  if (!(material instanceof MeshLambertMaterial) && !(material instanceof MeshStandardMaterial)) {
    throw new TypeError('Procedural Sun requires a Lambert or Standard material.');
  }

  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;
  const compileExtension = (
    shader: WebGLProgramParametersWithUniforms,
    renderer: Parameters<typeof material.onBeforeCompile>[1],
  ): void => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectAfter(
      injectAfter(shader.vertexShader, '#include <common>', VERTEX_DECLARATIONS),
      '#include <begin_vertex>',
      VERTEX_ASSIGNMENTS,
    );
    shader.fragmentShader = injectBefore(
      injectAfter(shader.fragmentShader, '#include <common>', FRAGMENT_DECLARATIONS),
      '#include <opaque_fragment>',
      FRAGMENT_OUTPUT,
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
