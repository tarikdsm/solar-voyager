import {
  DoubleSide,
  Vector3,
  type IUniform,
  type MeshStandardMaterial,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import type { RingDefinition } from './ringCatalog.js';

const PROGRAM_CACHE_VERSION = 'v1';
const MAX_TRANSMISSION = 0.22;

interface RingUniforms extends Record<string, IUniform> {
  readonly uRingOpacityMap: IUniform<Texture>;
  readonly uRingSunDirection: IUniform<Vector3>;
  readonly uRingInnerRadius: IUniform<number>;
  readonly uRingOuterRadius: IUniform<number>;
  readonly uRingPolarRatio: IUniform<number>;
  readonly uRingRepresentationBlend: IUniform<number>;
}

export interface PreparedRingMaterials {
  readonly texture: Texture;
  readonly sunDirection: Vector3;
  readonly representationBlend: number;
  updateSunDirection(x: number, y: number, z: number): void;
  setRepresentationBlend(blend: number): void;
  dispose(): void;
}

const SURFACE_VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 vRingSurfacePosition;
`;

const SURFACE_VERTEX_ASSIGNMENTS = /* glsl */ `
vRingSurfacePosition = position;
`;

const SURFACE_FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec3 vRingSurfacePosition;
uniform sampler2D uRingOpacityMap;
uniform vec3 uRingSunDirection;
uniform float uRingInnerRadius;
uniform float uRingOuterRadius;

float ringPlaneIntersection( vec3 origin, vec3 direction ) {
  if ( abs( direction.y ) < 0.000001 ) return 0.0;
  float distanceToPlane = -origin.y / direction.y;
  if ( distanceToPlane <= 0.0 ) return 0.0;
  vec3 intersection = origin + direction * distanceToPlane;
  float ringRadius = length( intersection.xz );
  if ( ringRadius < uRingInnerRadius || ringRadius > uRingOuterRadius ) return 0.0;
  float radialUv = ( ringRadius - uRingInnerRadius ) /
    max( 0.000001, uRingOuterRadius - uRingInnerRadius );
  return texture2D( uRingOpacityMap, vec2( radialUv, 0.5 ) ).a;
}
`;

const SURFACE_RING_SHADOW = /* glsl */ `
float ringShadowOpacity = ringPlaneIntersection(
  vRingSurfacePosition,
  normalize( uRingSunDirection )
);
diffuseColor.rgb *= mix( 1.0, 0.35, ringShadowOpacity );
`;

const RING_VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 vRingLocalPosition;
`;

const RING_VERTEX_ASSIGNMENTS = /* glsl */ `
vRingLocalPosition = position;
`;

function glslFloat(value: number): string {
  const serialized = value.toFixed(8).replace(/0+$/u, '').replace(/\.$/u, '');
  return serialized.includes('.') ? serialized : `${serialized}.0`;
}

function arcFunction(definition: RingDefinition): string {
  if (definition.arcs.length === 0) {
    return /* glsl */ `
float ringArcGain( vec3 ringPosition ) {
  return 1.0;
}
`;
  }

  const contributions = definition.arcs
    .map((arc) => {
      const band = definition.bands.find((candidate) => candidate.name === arc.bandName);
      if (band === undefined) {
        throw new Error(`Ring arc "${arc.name}" references missing band "${arc.bandName}".`);
      }
      const center = (arc.centerDeg * Math.PI) / 180;
      const halfWidth = (arc.widthDeg * Math.PI) / 360;
      const identifier = arc.name.replace(/[^a-z0-9]/giu, '');
      return /* glsl */ `
  // ${arc.name}
  float ${identifier}Distance = abs(
    atan( sin( ringAngle - ${glslFloat(center)} ), cos( ringAngle - ${glslFloat(center)} ) )
  );
  float ${identifier}Radial = ringArcRadialMask(
    ringRadius,
    ${glslFloat(band.innerRadiusKm / definition.referenceRadiusKm)},
    ${glslFloat(band.outerRadiusKm / definition.referenceRadiusKm)}
  );
  gain = max( gain, mix( 1.0, ${glslFloat(arc.gain)},
    1.0 - smoothstep( ${glslFloat(halfWidth * 0.72)}, ${glslFloat(halfWidth)},
      ${identifier}Distance ) ) * ${identifier}Radial );`;
    })
    .join('\n');

  return /* glsl */ `
float ringArcRadialMask( float radius, float innerRadius, float outerRadius ) {
  float feather = max( ( outerRadius - innerRadius ) * 0.15, 0.000001 );
  return smoothstep( innerRadius, innerRadius + feather, radius ) *
    ( 1.0 - smoothstep( outerRadius - feather, outerRadius, radius ) );
}

float ringArcGain( vec3 ringPosition ) {
  float ringAngle = atan( ringPosition.z, ringPosition.x );
  float ringRadius = length( ringPosition.xz );
  float gain = 1.0;
${contributions}
  return gain;
}
`;
}

function ringFragmentDeclarations(definition: RingDefinition): string {
  return /* glsl */ `
#define RING_MAX_TRANSMISSION ${MAX_TRANSMISSION.toFixed(2)}
varying vec3 vRingLocalPosition;
uniform vec3 uRingSunDirection;
uniform float uRingPolarRatio;
uniform float uRingRepresentationBlend;

float ringPlanetOcclusion( vec3 origin, vec3 direction ) {
  vec3 scaledOrigin = vec3( origin.x, origin.y / uRingPolarRatio, origin.z );
  vec3 scaledDirection = vec3(
    direction.x,
    direction.y / uRingPolarRatio,
    direction.z
  );
  float quadraticA = dot( scaledDirection, scaledDirection );
  float quadraticB = 2.0 * dot( scaledOrigin, scaledDirection );
  float quadraticC = dot( scaledOrigin, scaledOrigin ) - 1.0;
  float discriminant = quadraticB * quadraticB - 4.0 * quadraticA * quadraticC;
  if ( discriminant <= 0.0 ) return 0.0;
  float nearest = ( -quadraticB - sqrt( discriminant ) ) / ( 2.0 * quadraticA );
  return nearest > 0.0 ? 1.0 : 0.0;
}
${arcFunction(definition)}
`;
}

const RING_LIGHTING = /* glsl */ `
float ringPlanetShadow = ringPlanetOcclusion(
  vRingLocalPosition,
  normalize( uRingSunDirection )
);
float ringBacklight = max(
  0.0,
  -uRingSunDirection.y * ( gl_FrontFacing ? 1.0 : -1.0 )
);
float ringDensityGain = ringArcGain( vRingLocalPosition );
diffuseColor.a = clamp( diffuseColor.a * ringDensityGain, 0.0, 1.0 );
diffuseColor.a *= 1.0 - 0.65 * uRingRepresentationBlend;
diffuseColor.rgb *= mix( 1.0, 0.18, ringPlanetShadow );
diffuseColor.rgb += diffuseColor.rgb * ringBacklight *
  RING_MAX_TRANSMISSION * ( 1.0 - diffuseColor.a );
`;

class PreparedRingMaterialsImpl implements PreparedRingMaterials {
  private disposed = false;

  constructor(
    private readonly uniforms: RingUniforms,
    readonly texture: Texture,
  ) {}

  get sunDirection(): Vector3 {
    return this.uniforms.uRingSunDirection.value;
  }

  get representationBlend(): number {
    return this.uniforms.uRingRepresentationBlend.value;
  }

  updateSunDirection(x: number, y: number, z: number): void {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      (x === 0 && y === 0 && z === 0)
    ) {
      throw new RangeError('Sun direction must be finite and non-zero.');
    }
    const length = Math.hypot(x, y, z);
    this.sunDirection.set(x / length, y / length, z / length);
  }

  setRepresentationBlend(blend: number): void {
    if (!Number.isFinite(blend)) throw new RangeError('Ring representation blend must be finite.');
    this.uniforms.uRingRepresentationBlend.value = Math.min(1, Math.max(0, blend));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }
}

function installSurfaceShader(material: MeshStandardMaterial, uniforms: RingUniforms): void {
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer): void => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SURFACE_VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SURFACE_VERTEX_ASSIGNMENTS}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SURFACE_FRAGMENT_DECLARATIONS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${SURFACE_RING_SHADOW}`);
  };
}

function installRingShader(
  material: MeshStandardMaterial,
  uniforms: RingUniforms,
  definition: RingDefinition,
): void {
  const declarations = ringFragmentDeclarations(definition);
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer): void => {
    previousCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${RING_VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${RING_VERTEX_ASSIGNMENTS}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${declarations}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${RING_LIGHTING}`);
  };
}

export function prepareRingMaterials(
  surface: MeshStandardMaterial,
  rings: MeshStandardMaterial,
  definition: RingDefinition,
  polarRatio: number,
): PreparedRingMaterials {
  if (!Number.isFinite(polarRatio) || polarRatio <= 0 || polarRatio > 1) {
    throw new RangeError('Ring planet polar ratio must be finite and in the interval (0, 1].');
  }
  if (rings.map === null) throw new Error('Ring material requires an opacity-bearing color map.');

  const texture = rings.map;
  const uniforms: RingUniforms = {
    uRingOpacityMap: { value: texture },
    uRingSunDirection: { value: new Vector3(1, 0, 0) },
    uRingInnerRadius: { value: definition.innerRadiusRatio },
    uRingOuterRadius: { value: definition.outerRadiusRatio },
    uRingPolarRatio: { value: polarRatio },
    uRingRepresentationBlend: { value: 0 },
  };

  installSurfaceShader(surface, uniforms);
  installRingShader(rings, uniforms, definition);

  const cacheSuffix = `solar-voyager-rings-${definition.bodyId}-${PROGRAM_CACHE_VERSION}`;
  const previousSurfaceCacheKey = surface.customProgramCacheKey.bind(surface);
  const previousRingCacheKey = rings.customProgramCacheKey.bind(rings);
  surface.customProgramCacheKey = (): string => `${previousSurfaceCacheKey()}|${cacheSuffix}`;
  rings.customProgramCacheKey = (): string => `${previousRingCacheKey()}|${cacheSuffix}`;
  rings.side = DoubleSide;
  rings.transparent = true;
  rings.depthWrite = false;
  surface.needsUpdate = true;
  rings.needsUpdate = true;

  return new PreparedRingMaterialsImpl(uniforms, texture);
}
