/**
 * The photon-drive plume: a collimated emissive beam plus a nozzle glow (T0122).
 *
 * Plan §3.6 makes the exhaust *light*: a narrow beam whose length is
 * `4 · shipLength · throttle^0.7`, additive and bloom-friendly, answering the
 * throttle inside one frame and drawing nothing at all when coasting.
 *
 * Geometry, material and both attribute buffers are built once. Throttle reaches
 * the screen through **uniforms only** — no buffer upload, no allocation — and a
 * governor rung is one `setDrawRange` call over an index buffer that already
 * holds three tessellations of the same beam (design doc §3).
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Points,
  type PointsMaterial,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import {
  attachAdditivePointAttributes,
  createAdditivePointMaterial,
  disposeAdditivePoints,
  type AdditivePointAttributes,
} from './additivePointSprite.js';
import { beamIntensity, beamLengthShipLengths } from './plumeRadiance.js';
import {
  SHIP_NOZZLE_EXIT_RADIUS_M,
  SHIP_NOZZLE_EXIT_X_M,
  SHIP_NOZZLE_THROAT_RADIUS_M,
  SHIP_NOZZLE_THROAT_X_M,
} from './shipEffectAnchors.js';
import { SHIP_LENGTH_M, SHIP_MODEL_SCALE_KM_PER_UNIT } from './shipVisual.js';

const PROGRAM_CACHE_KEY = 'solar-voyager-plume-beam-v1';

/** Radial and axial resolution of the finest beam; the coarse LODs are subsets. */
const BEAM_RADIAL_SEGMENTS = 24;
const BEAM_AXIAL_SEGMENTS = 12;

/**
 * Radial segment counts the governor may select, finest first.
 *
 * Each is a divisor of {@link BEAM_RADIAL_SEGMENTS}, which is what lets all three
 * index ranges address the same vertex buffer.
 */
export const PLUME_BEAM_SEGMENT_LADDER: readonly number[] = Object.freeze([24, 12, 6]);

/** Axial ring counts paired with the ladder above. */
const BEAM_AXIAL_LADDER: readonly number[] = Object.freeze([12, 6, 3]);

/** Additive tint of the beam: a hot blue-white, warmer than the point sprite. */
export const PLUME_BEAM_COLOR = 0x9f_c8_ff;
export const PLUME_GLOW_COLOR = 0xff_e6_c2;

/** Beam radius at the tip, as a fraction of the throat radius. */
const BEAM_TIP_RADIUS_FRACTION = 0.18;

/** Where the cylindrical section ends and the cone falloff begins. */
const BEAM_TAPER_START = 0.25;

/** Nozzle glow diameter at full throttle, in model metres. */
const GLOW_MAX_DIAMETER_M = SHIP_NOZZLE_EXIT_RADIUS_M * 2.6;

/** Peak additive brightness of the glow sprite. */
const GLOW_MAX_INTENSITY = 3.2;

/** Peak additive brightness of the beam shell. */
const BEAM_MAX_INTENSITY = 2.4;

const VERTEX_DECLARATIONS = /* glsl */ `
uniform float uBeamLengthM;
uniform float uBeamRadiusM;
attribute float aAxial;
varying float vAxial;
varying vec3 vBeamNormal;
varying vec3 vBeamView;
`;

/**
 * Replaces `begin_vertex`, which is where three defines `transformed`.
 *
 * The lathe is authored as unit rings in the YZ plane at `x = 0`, so the whole
 * beam shape — length, taper, position along the nozzle axis — is a function of
 * `aAxial` and two uniforms. Throttle therefore costs one uniform write.
 */
const VERTEX_SHAPE_HOOK = /* glsl */ `
vAxial = aAxial;
float beamRadius = uBeamRadiusM * mix(
  1.0,
  ${BEAM_TIP_RADIUS_FRACTION.toFixed(3)},
  smoothstep(${BEAM_TAPER_START.toFixed(3)}, 1.0, aAxial)
);
vec3 transformed = vec3(
  -uBeamLengthM * aAxial,
  position.y * beamRadius,
  position.z * beamRadius
);
vBeamNormal = normalize(normalMatrix * vec3(0.0, position.y, position.z));
vBeamView = -(modelViewMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
uniform float uBeamIntensity;
varying float vAxial;
varying vec3 vBeamNormal;
varying vec3 vBeamView;
`;

/**
 * Replaces the opaque write with an additive, view-dependent shell.
 *
 * `edge` is the grazing term: a hollow tube of light reads as a solid column
 * only if its silhouette is brighter than its face. The axial term is
 * `(1 - s)^1.5`, so the beam fades out rather than ending in a disc.
 */
const FRAGMENT_EMISSION_HOOK = /* glsl */ `
float beamEdge = 1.0 - abs(dot(normalize(vBeamNormal), normalize(vBeamView)));
float beamAxial = pow(max(0.0, 1.0 - vAxial), 1.5);
float beamAlpha = beamAxial * mix(0.32, 1.0, beamEdge) * uBeamIntensity;
gl_FragColor = vec4(diffuse * beamAlpha, beamAlpha);
`;

function replaceMarker(source: string, marker: string, replacement: string): string {
  if (!source.includes(marker)) throw new Error(`Plume beam shader requires ${marker}.`);
  return source.replace(marker, replacement);
}

interface BeamLod {
  readonly indexOffset: number;
  readonly indexCount: number;
  readonly radialSegments: number;
}

/**
 * Builds the lathe once, with three complete tessellations in one index buffer.
 *
 * The coarse ring/column sets are strict subsets of the fine one — 24/12/6
 * columns and 12/6/3 rings — so all three ranges index the same 312 vertices and
 * a governor step never touches a buffer.
 */
function createBeamGeometry(): { geometry: BufferGeometry; lods: readonly BeamLod[] } {
  const ringCount = BEAM_AXIAL_SEGMENTS + 1;
  const vertexCount = ringCount * BEAM_RADIAL_SEGMENTS;
  const positions = new Float32Array(vertexCount * 3);
  const axials = new Float32Array(vertexCount);
  for (let ring = 0; ring < ringCount; ring += 1) {
    const axial = ring / BEAM_AXIAL_SEGMENTS;
    for (let column = 0; column < BEAM_RADIAL_SEGMENTS; column += 1) {
      const angle = (column / BEAM_RADIAL_SEGMENTS) * Math.PI * 2;
      const index = ring * BEAM_RADIAL_SEGMENTS + column;
      positions[index * 3] = 0;
      positions[index * 3 + 1] = Math.cos(angle);
      positions[index * 3 + 2] = Math.sin(angle);
      axials[index] = axial;
    }
  }

  const indices: number[] = [];
  const lods: BeamLod[] = [];
  for (let lod = 0; lod < PLUME_BEAM_SEGMENT_LADDER.length; lod += 1) {
    const radialSegments = PLUME_BEAM_SEGMENT_LADDER[lod] as number;
    const axialSegments = BEAM_AXIAL_LADDER[lod] as number;
    const columnStride = BEAM_RADIAL_SEGMENTS / radialSegments;
    const ringStride = BEAM_AXIAL_SEGMENTS / axialSegments;
    const indexOffset = indices.length;
    for (let step = 0; step < axialSegments; step += 1) {
      const nearRing = step * ringStride;
      const farRing = nearRing + ringStride;
      for (let column = 0; column < radialSegments; column += 1) {
        const left = column * columnStride;
        const right = ((column + 1) % radialSegments) * columnStride;
        const a = nearRing * BEAM_RADIAL_SEGMENTS + left;
        const b = nearRing * BEAM_RADIAL_SEGMENTS + right;
        const c = farRing * BEAM_RADIAL_SEGMENTS + right;
        const d = farRing * BEAM_RADIAL_SEGMENTS + left;
        indices.push(a, b, c, a, c, d);
      }
    }
    lods.push({ indexOffset, indexCount: indices.length - indexOffset, radialSegments });
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aAxial', new BufferAttribute(axials, 1));
  geometry.setIndex(new BufferAttribute(new Uint16Array(indices), 1));
  const firstLod = lods[0];
  if (firstLod === undefined) throw new Error('Plume beam needs at least one tessellation.');
  geometry.setDrawRange(firstLod.indexOffset, firstLod.indexCount);
  // The beam is a metre-scale attachment on a 26 m hull that is itself culled by
  // the ship's tier ladder; a bounding sphere that has to track a shader-driven
  // length would be a second source of truth for no gain.
  geometry.boundingSphere = null;
  return { geometry, lods };
}

export interface PlumeBeamUniforms {
  readonly uBeamLengthM: { value: number };
  readonly uBeamRadiusM: { value: number };
  readonly uBeamIntensity: { value: number };
}

/** Additive emissive beam plus its nozzle glow, both anchored to `engine_nozzle`. */
export class PlumeVisual {
  readonly beam: Mesh<BufferGeometry, MeshBasicMaterial>;
  readonly glow: Points<BufferGeometry, PointsMaterial>;

  private readonly uniforms: PlumeBeamUniforms = {
    uBeamLengthM: { value: 0 },
    uBeamRadiusM: { value: SHIP_NOZZLE_THROAT_RADIUS_M },
    uBeamIntensity: { value: 0 },
  };
  private readonly lods: readonly BeamLod[];
  private readonly glowAttributes: AdditivePointAttributes;
  private currentThrottle = 0;
  private currentLod = 0;

  constructor(spriteTexture: Texture) {
    const { geometry, lods } = createBeamGeometry();
    this.lods = lods;

    const material = new MeshBasicMaterial({
      blending: AdditiveBlending,
      color: PLUME_BEAM_COLOR,
      depthTest: true,
      depthWrite: false,
      // Both shells of the tube blend, so the column has a bright core and the
      // grazing term still lifts the silhouette (design doc §3).
      side: DoubleSide,
      // three renders a transparent double-sided material in TWO passes (back
      // faces, then front) to get the sorting right. Additive blending is
      // order-independent, so that second pass buys nothing and costs a draw
      // call — which is the difference between the beam costing one and two.
      forceSinglePass: true,
      transparent: true,
    });
    const previousCompile = material.onBeforeCompile;
    const previousCacheKey = material.customProgramCacheKey;
    material.onBeforeCompile = (
      shader: WebGLProgramParametersWithUniforms,
      renderer: Parameters<typeof material.onBeforeCompile>[1],
    ): void => {
      previousCompile.call(material, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = replaceMarker(
        replaceMarker(
          shader.vertexShader,
          '#include <common>',
          `#include <common>\n${VERTEX_DECLARATIONS}`,
        ),
        '#include <begin_vertex>',
        VERTEX_SHAPE_HOOK,
      );
      shader.fragmentShader = replaceMarker(
        replaceMarker(
          shader.fragmentShader,
          '#include <common>',
          `#include <common>\n${FRAGMENT_DECLARATIONS}`,
        ),
        '#include <opaque_fragment>',
        FRAGMENT_EMISSION_HOOK,
      );
    };
    material.customProgramCacheKey = (): string =>
      `${previousCacheKey.call(material)}|${PROGRAM_CACHE_KEY}`;

    this.beam = new Mesh(geometry, material);
    this.beam.position.set(SHIP_NOZZLE_THROAT_X_M, 0, 0);
    this.beam.frustumCulled = false;
    this.beam.matrixAutoUpdate = false;
    this.beam.updateMatrix();
    this.beam.renderOrder = 2;
    this.beam.visible = false;

    const glowGeometry = new BufferGeometry();
    glowGeometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([SHIP_NOZZLE_EXIT_X_M, 0, 0]), 3),
    );
    this.glowAttributes = attachAdditivePointAttributes(glowGeometry, 1);
    this.glow = new Points(
      glowGeometry,
      createAdditivePointMaterial(spriteTexture, PLUME_GLOW_COLOR),
    );
    this.glow.frustumCulled = false;
    this.glow.matrixAutoUpdate = false;
    this.glow.updateMatrix();
    this.glow.renderOrder = 2;
    this.glow.visible = false;
  }

  /**
   * Publishes one frame's throttle. Allocation-free, uniform writes only.
   *
   * Zero throttle hides both objects outright rather than drawing a zero-length
   * beam: "nothing when coasting" is the acceptance criterion, and a hidden
   * object costs no draw call.
   */
  setThrottle(throttle: number): void {
    const safeThrottle = Number.isFinite(throttle) ? Math.max(0, Math.min(1, throttle)) : 0;
    this.currentThrottle = safeThrottle;
    const lengthM = beamLengthShipLengths(safeThrottle) * SHIP_LENGTH_M;
    const intensity = beamIntensity(safeThrottle);
    this.uniforms.uBeamLengthM.value = lengthM;
    this.uniforms.uBeamIntensity.value = intensity * BEAM_MAX_INTENSITY;
    const burning = safeThrottle > 0;
    this.beam.visible = burning;
    this.glow.visible = burning;
    this.glowAttributes.sizes[0] =
      GLOW_MAX_DIAMETER_M * SHIP_MODEL_SCALE_KM_PER_UNIT * (0.45 + 0.55 * intensity);
    this.glowAttributes.intensities[0] = intensity * GLOW_MAX_INTENSITY;
    this.glowAttributes.sizeAttribute.needsUpdate = true;
    this.glowAttributes.intensityAttribute.needsUpdate = true;
  }

  /**
   * Selects a tessellation by radial segment count (the governor's rung).
   *
   * Values that are not on {@link PLUME_BEAM_SEGMENT_LADDER} snap down to the
   * next coarser rung, so a future profile cannot silently ask for geometry that
   * does not exist.
   */
  setBeamSegments(radialSegments: number): void {
    if (!Number.isFinite(radialSegments)) {
      throw new RangeError('Plume beam segment count must be finite.');
    }
    let selected = this.lods.length - 1;
    for (let index = 0; index < this.lods.length; index += 1) {
      const lod = this.lods[index];
      if (lod !== undefined && radialSegments >= lod.radialSegments) {
        selected = index;
        break;
      }
    }
    if (selected === this.currentLod) return;
    const lod = this.lods[selected];
    if (lod === undefined) throw new RangeError('Plume beam tessellation is missing.');
    this.currentLod = selected;
    this.beam.geometry.setDrawRange(lod.indexOffset, lod.indexCount);
  }

  get throttle(): number {
    return this.currentThrottle;
  }

  /** Beam length in model metres, for diagnostics and the browser gate. */
  get beamLengthM(): number {
    return this.uniforms.uBeamLengthM.value;
  }

  get beamIntensity(): number {
    return this.uniforms.uBeamIntensity.value;
  }

  /** Radial segments currently drawn, so the governor rung is observable. */
  get beamSegments(): number {
    return this.lods[this.currentLod]?.radialSegments ?? 0;
  }

  get burning(): boolean {
    return this.beam.visible;
  }

  dispose(): void {
    this.beam.geometry.dispose();
    this.beam.material.dispose();
    disposeAdditivePoints(this.glow);
  }
}
