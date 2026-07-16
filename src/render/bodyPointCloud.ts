import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Points,
  ShaderMaterial,
} from 'three';

const MAX_POINT_DIAMETER_PX = 1.5;

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor;
attribute float aSize;
attribute float aOpacity;
attribute float aIntensity;
varying vec3 vColor;
varying float vOpacity;
varying float vUnresolved;

void main() {
  vColor = aColor * aIntensity;
  vOpacity = aOpacity;
  vUnresolved = aSize < 1.5 ? 1.0 : 0.0;
  // WebGL rasterizes unresolved points at a one-pixel hardware footprint.
  gl_PointSize = max(aSize, 1.0001);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vOpacity;
varying float vUnresolved;

void main() {
  #include <logdepthbuf_fragment>
  float softEdge = 1.0;
  if (vUnresolved < 0.5) {
    vec2 centered = gl_PointCoord * 2.0 - 1.0;
    float radiusSquared = dot(centered, centered);
    if (radiusSquared > 1.0) discard;
    softEdge = 1.0 - smoothstep(0.65, 1.0, radiusSquared);
  }
  gl_FragColor = vec4(vColor, vOpacity * softEdge);
}
`;

/** One draw object containing every distant catalog body. */
export class BodyPointCloud {
  readonly points: Points<BufferGeometry, ShaderMaterial>;

  private readonly sizeValues: Float32Array;
  private readonly opacityValues: Float32Array;
  private readonly intensityValues: Float32Array;
  private readonly sizeAttribute: BufferAttribute;
  private readonly opacityAttribute: BufferAttribute;
  private readonly intensityAttribute: BufferAttribute;

  constructor(colors: Uint32Array) {
    if (colors.length === 0) {
      throw new RangeError('Body point cloud requires at least one color.');
    }

    const positions = new Float32Array(colors.length * 3);
    const colorValues = new Float32Array(colors.length * 3);
    this.sizeValues = new Float32Array(colors.length);
    this.opacityValues = new Float32Array(colors.length);
    this.intensityValues = new Float32Array(colors.length);
    this.sizeValues.fill(1);
    this.opacityValues.fill(1);
    this.intensityValues.fill(1);

    const scratchColor = new Color();
    for (let index = 0; index < colors.length; index += 1) {
      scratchColor.setHex(colors[index] ?? 0xffffff);
      const offset = index * 3;
      colorValues[offset] = scratchColor.r;
      colorValues[offset + 1] = scratchColor.g;
      colorValues[offset + 2] = scratchColor.b;
    }

    const geometry = new BufferGeometry();
    const positionAttribute = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
    const colorAttribute = new BufferAttribute(colorValues, 3);
    this.sizeAttribute = new BufferAttribute(this.sizeValues, 1).setUsage(DynamicDrawUsage);
    this.opacityAttribute = new BufferAttribute(this.opacityValues, 1).setUsage(DynamicDrawUsage);
    this.intensityAttribute = new BufferAttribute(this.intensityValues, 1).setUsage(
      DynamicDrawUsage,
    );
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('aColor', colorAttribute);
    geometry.setAttribute('aSize', this.sizeAttribute);
    geometry.setAttribute('aOpacity', this.opacityAttribute);
    geometry.setAttribute('aIntensity', this.intensityAttribute);

    const material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
  }

  writeAppearance(index: number, diameterPx: number, opacity: number, intensity: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.sizeValues.length) {
      throw new RangeError('Point-cloud body index is out of bounds.');
    }
    if (!Number.isFinite(diameterPx) || diameterPx < 0) {
      throw new RangeError('Point diameter must be finite and nonnegative.');
    }
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      throw new RangeError('Point opacity must be finite and within [0, 1].');
    }
    if (!Number.isFinite(intensity) || intensity < 0) {
      throw new RangeError('Point intensity must be finite and nonnegative.');
    }

    this.sizeValues[index] = Math.min(MAX_POINT_DIAMETER_PX, diameterPx);
    this.opacityValues[index] = opacity;
    this.intensityValues[index] = intensity;
  }

  commitAppearance(): void {
    this.sizeAttribute.needsUpdate = true;
    this.opacityAttribute.needsUpdate = true;
    this.intensityAttribute.needsUpdate = true;
  }
}
