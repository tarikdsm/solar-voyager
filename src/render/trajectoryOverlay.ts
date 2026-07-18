import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  InterleavedBufferAttribute,
  Points,
  ShaderMaterial,
  type InstancedInterleavedBuffer,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import {
  writePredictionPointsInto,
  writeTrajectoryMarkersInto,
  writeTrajectorySegmentBodiesInto,
} from '../game/trajectoryPredictionModel.js';
import {
  PREDICTOR_MAX_POINTS,
  type PredictorSuccessMessage,
} from '../workers/predictorProtocol.js';
import { CameraRelativeSpaceScene, type PackedPolylineBinding } from './spaceScene.js';

const MAXIMUM_MARKER_COUNT = PREDICTOR_MAX_POINTS + 2;
const LINE_COMPONENT_COUNT = PREDICTOR_MAX_POINTS * 3;
const MARKER_COMPONENT_COUNT = MAXIMUM_MARKER_COUNT * 3;
const MARKER_SIZE_CSS_PX = 18;

const MARKER_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uPixelRatio;
attribute float aEventCode;
attribute float aBodyIndex;
attribute vec3 aColor;
varying float vEventCode;
varying float vBodyIndex;
varying vec3 vColor;

void main() {
  vEventCode = aEventCode;
  vBodyIndex = aBodyIndex;
  vColor = aColor;
  gl_PointSize = ${MARKER_SIZE_CSS_PX.toFixed(1)} * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const MARKER_FRAGMENT_SHADER = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying float vEventCode;
varying float vBodyIndex;
varying vec3 vColor;

void main() {
  #include <logdepthbuf_fragment>
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float alpha = 0.0;
  if (vEventCode < 1.5) {
    // SOI_RING
    float radius = length(point);
    alpha = smoothstep(0.92, 0.78, radius) * smoothstep(0.52, 0.66, radius);
  } else if (vEventCode < 2.5) {
    // APPROACH_DIAMOND
    float diamond = abs(point.x) + abs(point.y);
    alpha = 1.0 - smoothstep(0.72, 0.9, diamond);
  } else {
    // IMPACT_TRIANGLE
    float edge = max(-point.y - 0.72, abs(point.x) * 1.25 + point.y * 0.72 - 0.64);
    float triangle = 1.0 - smoothstep(-0.08, 0.03, edge);
    float warningCutout = step(0.09, abs(point.x)) + step(point.y, -0.3);
    alpha = triangle * clamp(warningCutout, 0.0, 1.0);
  }
  if (alpha <= 0.0) discard;
  float bodyVariation = 1.0 + vBodyIndex * 0.0;
  gl_FragColor = vec4(vColor * bodyVariation, alpha * 0.96);
}
`;

function hashBodyId(bodyId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < bodyId.length; index += 1) {
    hash ^= bodyId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** Setup-owned predicted path and batched event marker resources. */
export class TrajectoryOverlay {
  readonly line: Line2;
  readonly markers: Points<BufferGeometry, ShaderMaterial>;

  private readonly spaceScene: CameraRelativeSpaceScene;
  private readonly linePositionsKm = new Float64Array(LINE_COMPONENT_COUNT);
  private readonly lineBinding: PackedPolylineBinding;
  private readonly segmentBodyIndices = new Int32Array(PREDICTOR_MAX_POINTS - 1);
  private readonly segmentColorBuffer: InstancedInterleavedBuffer;
  private readonly segmentColorComponents: Float32Array;
  private readonly markerPositionsKm = new Float64Array(MARKER_COMPONENT_COUNT);
  private readonly markerCodes = new Float32Array(MAXIMUM_MARKER_COUNT);
  private readonly markerBodyIndices = new Float32Array(MAXIMUM_MARKER_COUNT);
  private readonly markerColors = new Float32Array(MARKER_COMPONENT_COUNT);
  private readonly markerCodeAttribute: BufferAttribute;
  private readonly markerBodyAttribute: BufferAttribute;
  private readonly markerColorAttribute: BufferAttribute;
  private readonly bodyPalette: Float32Array;
  private startTime = Number.NaN;
  private intervalSec = Number.NaN;

  constructor(spaceScene: CameraRelativeSpaceScene, bodyIds: readonly string[]) {
    if (bodyIds.length === 0) throw new RangeError('Trajectory overlay requires body IDs.');
    this.spaceScene = spaceScene;
    this.bodyPalette = new Float32Array(bodyIds.length * 3);
    const scratchColor = new Color();
    for (let bodyIndex = 0; bodyIndex < bodyIds.length; bodyIndex += 1) {
      const bodyId = bodyIds[bodyIndex];
      if (bodyId === undefined || bodyId.length === 0) {
        throw new RangeError('Trajectory body IDs must be nonempty.');
      }
      scratchColor.setHSL((hashBodyId(bodyId) % 360) / 360, 0.72, 0.62);
      const offset = bodyIndex * 3;
      this.bodyPalette[offset] = scratchColor.r;
      this.bodyPalette[offset + 1] = scratchColor.g;
      this.bodyPalette[offset + 2] = scratchColor.b;
    }

    const lineGeometry = new LineGeometry();
    lineGeometry.setPositions(new Float32Array(LINE_COMPONENT_COUNT));
    const setupColors = new Float32Array(LINE_COMPONENT_COUNT);
    setupColors.fill(1);
    lineGeometry.setColors(setupColors);
    const colorAttribute = lineGeometry.getAttribute('instanceColorStart');
    if (
      !(colorAttribute instanceof InterleavedBufferAttribute) ||
      !(colorAttribute.data.array instanceof Float32Array)
    ) {
      throw new Error('Trajectory Line2 requires one float32 color buffer.');
    }
    this.segmentColorBuffer = colorAttribute.data as InstancedInterleavedBuffer;
    this.segmentColorComponents = colorAttribute.data.array;

    const lineMaterial = new LineMaterial({
      color: 0xffffff,
      linewidth: 2.25,
      vertexColors: true,
      transparent: true,
      opacity: 0.82,
      depthTest: true,
      depthWrite: false,
    });
    lineMaterial.resolution.set(1, 1);
    this.line = new Line2(lineGeometry, lineMaterial);
    this.line.name = 'predicted-trajectory';
    this.line.visible = false;
    this.line.frustumCulled = true;
    this.lineBinding = spaceScene.bindPackedPolyline(this.line, this.linePositionsKm);

    const markerGeometry = new BufferGeometry();
    const markerPositionAttribute = new BufferAttribute(
      new Float32Array(MARKER_COMPONENT_COUNT),
      3,
    ).setUsage(DynamicDrawUsage);
    this.markerCodeAttribute = new BufferAttribute(this.markerCodes, 1).setUsage(DynamicDrawUsage);
    this.markerBodyAttribute = new BufferAttribute(this.markerBodyIndices, 1).setUsage(
      DynamicDrawUsage,
    );
    this.markerColorAttribute = new BufferAttribute(this.markerColors, 3).setUsage(
      DynamicDrawUsage,
    );
    markerGeometry.setAttribute('position', markerPositionAttribute);
    markerGeometry.setAttribute('aEventCode', this.markerCodeAttribute);
    markerGeometry.setAttribute('aBodyIndex', this.markerBodyAttribute);
    markerGeometry.setAttribute('aColor', this.markerColorAttribute);
    markerGeometry.setDrawRange(0, 0);
    markerGeometry.computeBoundingSphere();
    const markerMaterial = new ShaderMaterial({
      uniforms: { uPixelRatio: { value: 1 } },
      vertexShader: MARKER_VERTEX_SHADER,
      fragmentShader: MARKER_FRAGMENT_SHADER,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    this.markers = new Points(markerGeometry, markerMaterial);
    this.markers.name = 'trajectory-event-markers';
    this.markers.visible = false;
    this.markers.frustumCulled = true;
    spaceScene.bindPackedPointPositions(this.markers, this.markerPositionsKm);
  }

  get startTimeSec(): number {
    return this.startTime;
  }

  get sampleIntervalSec(): number {
    return this.intervalSec;
  }

  /** Applies one validated worker result without replacing setup-time resources. */
  applyPrediction(result: PredictorSuccessMessage, fallbackDominantBodyIndex: number): void {
    const pointCount = writePredictionPointsInto(this.linePositionsKm, result.points);
    if (pointCount < 2) throw new RangeError('Trajectory rendering requires at least two points.');
    const segmentCount = writeTrajectorySegmentBodiesInto(
      this.segmentBodyIndices,
      result.points,
      result.events,
      fallbackDominantBodyIndex,
    );
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const bodyIndex = this.segmentBodyIndices[segmentIndex] as number;
      const paletteOffset =
        bodyIndex >= 0 && bodyIndex * 3 + 2 < this.bodyPalette.length ? bodyIndex * 3 : -1;
      const red = paletteOffset < 0 ? 1 : (this.bodyPalette[paletteOffset] as number);
      const green = paletteOffset < 0 ? 1 : (this.bodyPalette[paletteOffset + 1] as number);
      const blue = paletteOffset < 0 ? 1 : (this.bodyPalette[paletteOffset + 2] as number);
      const colorOffset = segmentIndex * 6;
      this.segmentColorComponents[colorOffset] = red;
      this.segmentColorComponents[colorOffset + 1] = green;
      this.segmentColorComponents[colorOffset + 2] = blue;
      this.segmentColorComponents[colorOffset + 3] = red;
      this.segmentColorComponents[colorOffset + 4] = green;
      this.segmentColorComponents[colorOffset + 5] = blue;
    }
    this.segmentColorBuffer.needsUpdate = true;
    this.lineBinding.setPointCount(pointCount);

    const markerCount = writeTrajectoryMarkersInto(
      this.markerPositionsKm,
      this.markerCodes,
      this.markerBodyIndices,
      result.points,
      result.events,
    );
    for (let markerIndex = 0; markerIndex < markerCount; markerIndex += 1) {
      const bodyIndex = this.markerBodyIndices[markerIndex] as number;
      const paletteOffset =
        bodyIndex >= 0 && bodyIndex * 3 + 2 < this.bodyPalette.length ? bodyIndex * 3 : -1;
      const colorOffset = markerIndex * 3;
      this.markerColors[colorOffset] =
        paletteOffset < 0 ? 1 : (this.bodyPalette[paletteOffset] as number);
      this.markerColors[colorOffset + 1] =
        paletteOffset < 0 ? 0.8 : (this.bodyPalette[paletteOffset + 1] as number);
      this.markerColors[colorOffset + 2] =
        paletteOffset < 0 ? 0.2 : (this.bodyPalette[paletteOffset + 2] as number);
    }
    this.markerCodeAttribute.needsUpdate = true;
    this.markerBodyAttribute.needsUpdate = true;
    this.markerColorAttribute.needsUpdate = true;
    this.markers.geometry.setDrawRange(0, markerCount);

    this.startTime = result.points[0] as number;
    this.intervalSec = (result.points[4] as number) - this.startTime;
    this.line.visible = true;
    this.markers.visible = markerCount > 0;
  }

  setViewport(widthPx: number, heightPx: number, pixelRatio: number): void {
    if (
      !Number.isFinite(widthPx) ||
      widthPx <= 0 ||
      !Number.isFinite(heightPx) ||
      heightPx <= 0 ||
      !Number.isFinite(pixelRatio) ||
      pixelRatio <= 0
    ) {
      throw new RangeError('Trajectory viewport dimensions and pixel ratio must be positive.');
    }
    this.line.material.resolution.set(widthPx, heightPx);
    const pixelRatioUniform = this.markers.material.uniforms.uPixelRatio;
    if (pixelRatioUniform === undefined)
      throw new Error('Trajectory marker pixel ratio is absent.');
    pixelRatioUniform.value = pixelRatio;
  }

  hide(): void {
    this.startTime = Number.NaN;
    this.intervalSec = Number.NaN;
    this.lineBinding.setPointCount(0);
    this.markers.geometry.setDrawRange(0, 0);
    this.line.visible = false;
    this.markers.visible = false;
  }

  dispose(): void {
    this.spaceScene.unbindVisual(this.line);
    this.spaceScene.unbindVisual(this.markers);
    this.line.geometry.dispose();
    this.line.material.dispose();
    this.markers.geometry.dispose();
    this.markers.material.dispose();
  }
}
