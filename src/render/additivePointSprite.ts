/**
 * Shared additive world-space point sprites for the ship's VFX (T0122).
 *
 * The nozzle glow and the sixteen RCS puffs want the same thing: a soft round
 * blob of light at an authored model-space anchor, sized in *world* units so it
 * grows as the camera closes, with one draw call for the whole set.
 *
 * three's `PointsMaterial` already does world-space sizing (`sizeAttenuation`)
 * and already carries the log-depth chunks the renderer's
 * `logarithmicDepthBuffer` needs. What it does not do is per-point size or
 * per-point brightness, so both are added through the `onBeforeCompile` hook
 * pattern this repo already uses for gas giants and Earth's atmosphere. Nothing
 * here is created after setup: the texture, geometry, attributes and material
 * are all built once, and the frame path only writes into the typed arrays.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  ClampToEdgeWrapping,
  DataTexture,
  DynamicDrawUsage,
  LinearFilter,
  Points,
  PointsMaterial,
  RGBAFormat,
  type BufferGeometry,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';

const PROGRAM_CACHE_KEY = 'solar-voyager-ship-vfx-point-v1';
const SPRITE_TEXTURE_SIZE = 32;

/** `attribute` block and `varying` shared by both shader stages. */
const VERTEX_DECLARATIONS = /* glsl */ `
attribute float aPuffSize;
attribute float aPuffIntensity;
varying float vPuffIntensity;
`;

/**
 * Per-point world diameter, applied after three's own size attenuation.
 *
 * `gl_PointSize` at this marker is already `size * scale / -mvPosition.z`, so
 * multiplying by `aPuffSize` makes the attribute a diameter in the same units as
 * the view-space position — kilometres, in this renderer.
 */
const VERTEX_SIZE_HOOK = /* glsl */ `
vPuffIntensity = aPuffIntensity;
gl_PointSize *= aPuffSize;
#include <logdepthbuf_vertex>
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying float vPuffIntensity;
`;

/** After the map, so brightness multiplies the authored radial falloff. */
const FRAGMENT_INTENSITY_HOOK = /* glsl */ `
#include <map_particle_fragment>
diffuseColor.rgb *= vPuffIntensity;
`;

function replaceMarker(source: string, marker: string, replacement: string): string {
  if (!source.includes(marker)) {
    throw new Error(`Ship VFX point shader requires ${marker}.`);
  }
  return source.replace(marker, replacement);
}

/**
 * A 32x32 radial falloff, built once.
 *
 * `(1 - r²)²` rather than a Gaussian: it reaches exactly zero at the sprite edge,
 * so an additive blob has no square seam, and it stays cheap enough that the
 * texture is smaller than one glTF accessor.
 */
export function createRadialSpriteTexture(): Texture {
  const texels = new Uint8Array(SPRITE_TEXTURE_SIZE * SPRITE_TEXTURE_SIZE * 4);
  const center = (SPRITE_TEXTURE_SIZE - 1) / 2;
  for (let y = 0; y < SPRITE_TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < SPRITE_TEXTURE_SIZE; x += 1) {
      const dx = (x - center) / (SPRITE_TEXTURE_SIZE / 2);
      const dy = (y - center) / (SPRITE_TEXTURE_SIZE / 2);
      const radiusSquared = dx * dx + dy * dy;
      const falloff = radiusSquared >= 1 ? 0 : (1 - radiusSquared) * (1 - radiusSquared);
      const value = Math.round(255 * falloff);
      const offset = (y * SPRITE_TEXTURE_SIZE + x) * 4;
      texels[offset] = 255;
      texels[offset + 1] = 255;
      texels[offset + 2] = 255;
      texels[offset + 3] = value;
    }
  }
  const texture = new DataTexture(texels, SPRITE_TEXTURE_SIZE, SPRITE_TEXTURE_SIZE, RGBAFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * `PointsMaterial` extended with per-point size and brightness.
 *
 * `size` stays at 1 so `aPuffSize` alone carries the world diameter; `depthTest`
 * stays on so the hull and the planets occlude the sprites, and `depthWrite`
 * stays off because they are additive (design doc §4).
 */
export function createAdditivePointMaterial(map: Texture, color: number): PointsMaterial {
  const material = new PointsMaterial({
    blending: AdditiveBlending,
    color,
    depthTest: true,
    depthWrite: false,
    map,
    size: 1,
    sizeAttenuation: true,
    transparent: true,
  });
  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey;
  material.onBeforeCompile = function compileAdditivePoint(
    shader: WebGLProgramParametersWithUniforms,
    renderer: Parameters<typeof material.onBeforeCompile>[1],
  ): void {
    previousCompile.call(material, shader, renderer);
    shader.vertexShader = replaceMarker(
      replaceMarker(
        shader.vertexShader,
        '#include <common>',
        `#include <common>\n${VERTEX_DECLARATIONS}`,
      ),
      '#include <logdepthbuf_vertex>',
      VERTEX_SIZE_HOOK,
    );
    shader.fragmentShader = replaceMarker(
      replaceMarker(
        shader.fragmentShader,
        '#include <common>',
        `#include <common>\n${FRAGMENT_DECLARATIONS}`,
      ),
      '#include <map_particle_fragment>',
      FRAGMENT_INTENSITY_HOOK,
    );
  };
  material.customProgramCacheKey = (): string =>
    `${previousCacheKey.call(material)}|${PROGRAM_CACHE_KEY}`;
  return material;
}

/** The pair of dynamic attributes `createAdditivePointMaterial` reads. */
export interface AdditivePointAttributes {
  readonly sizes: Float32Array;
  readonly intensities: Float32Array;
  readonly sizeAttribute: BufferAttribute;
  readonly intensityAttribute: BufferAttribute;
}

/** Attaches `aPuffSize`/`aPuffIntensity` to a geometry that already has positions. */
export function attachAdditivePointAttributes(
  geometry: BufferGeometry,
  count: number,
): AdditivePointAttributes {
  if (!Number.isInteger(count) || count <= 0) {
    throw new RangeError('Additive point sprite count must be a positive integer.');
  }
  const sizes = new Float32Array(count);
  const intensities = new Float32Array(count);
  const sizeAttribute = new BufferAttribute(sizes, 1).setUsage(DynamicDrawUsage);
  const intensityAttribute = new BufferAttribute(intensities, 1).setUsage(DynamicDrawUsage);
  geometry.setAttribute('aPuffSize', sizeAttribute);
  geometry.setAttribute('aPuffIntensity', intensityAttribute);
  return { sizes, intensities, sizeAttribute, intensityAttribute };
}

/** Disposes a point-sprite set built by the helpers above. */
export function disposeAdditivePoints(points: Points<BufferGeometry, PointsMaterial>): void {
  points.geometry.dispose();
  points.material.map?.dispose();
  points.material.dispose();
}
