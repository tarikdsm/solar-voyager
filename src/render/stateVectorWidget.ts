import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  DynamicDrawUsage,
  Euler,
  Group,
  InterleavedBufferAttribute,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector4,
  type WebGLRenderer,
  type InstancedInterleavedBuffer,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import type { SimSnapshot } from '../sim/simulationSnapshot.js';
import { STATE_VECTOR_COMPONENT_COUNT, writeStateVectorEndpointsInto } from './stateVectorModel.js';

const VECTOR_COUNT = 4;
const VECTOR_COLORS = Object.freeze([0x5eead4, 0xfbbf24, 0xf472b6, 0xa78bfa]);
const VECTOR_WIDTHS = Object.freeze([3.2, 2.2, 1.35, 2.2]);
const VECTOR_COLOR_COMPONENTS = Object.freeze([
  Object.freeze([0.3686, 0.9176, 0.8314]),
  Object.freeze([0.9843, 0.749, 0.1412]),
  Object.freeze([0.9569, 0.4471, 0.7137]),
  Object.freeze([0.6549, 0.5451, 0.9804]),
]);

const GLOW_VERTEX_SHADER = `
attribute vec4 glowColor;
varying vec4 vGlowColor;
uniform float pointSize;

void main() {
  vGlowColor = glowColor;
  gl_PointSize = pointSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GLOW_FRAGMENT_SHADER = `
varying vec4 vGlowColor;

void main() {
  float radial = length(gl_PointCoord - vec2(0.5));
  float alpha = (1.0 - smoothstep(0.08, 0.5, radial)) * vGlowColor.a;
  gl_FragColor = vec4(vGlowColor.rgb, alpha);
}
`;

export interface StateVectorRendererPort {
  autoClear: boolean;
  getViewport(target: Vector4): Vector4;
  getScissor(target: Vector4): Vector4;
  getScissorTest(): boolean;
  setViewport(x: number, y: number, width: number, height: number): void;
  setScissor(x: number, y: number, width: number, height: number): void;
  setScissorTest(enabled: boolean): void;
  clearDepth(): void;
  render(scene: Scene, camera: Camera): void;
}

interface MutableLineResources {
  readonly geometry: LineGeometry;
  readonly material: LineMaterial;
  readonly line: Line2;
  readonly segmentBuffer: InstancedInterleavedBuffer;
  readonly segmentComponents: Float32Array;
}

function createGridGeometry(): BufferGeometry {
  const circleCount = 3;
  const circleSegments = 48;
  const rayCount = 12;
  const componentCount = (circleCount * circleSegments + rayCount) * 2 * 3;
  const positions = new Float32Array(componentCount);
  let offset = 0;
  for (let circleIndex = 1; circleIndex <= circleCount; circleIndex += 1) {
    const radius = (0.9 * circleIndex) / circleCount;
    for (let segmentIndex = 0; segmentIndex < circleSegments; segmentIndex += 1) {
      const angleA = (segmentIndex / circleSegments) * Math.PI * 2;
      const angleB = ((segmentIndex + 1) / circleSegments) * Math.PI * 2;
      positions[offset] = radius * Math.cos(angleA);
      positions[offset + 1] = radius * Math.sin(angleA);
      positions[offset + 2] = -0.025;
      positions[offset + 3] = radius * Math.cos(angleB);
      positions[offset + 4] = radius * Math.sin(angleB);
      positions[offset + 5] = -0.025;
      offset += 6;
    }
  }
  for (let rayIndex = 0; rayIndex < rayCount; rayIndex += 1) {
    const angle = (rayIndex / rayCount) * Math.PI * 2;
    positions[offset] = 0;
    positions[offset + 1] = 0;
    positions[offset + 2] = -0.025;
    positions[offset + 3] = 0.9 * Math.cos(angle);
    positions[offset + 4] = 0.9 * Math.sin(angle);
    positions[offset + 5] = -0.025;
    offset += 6;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return geometry;
}

function createAxesGeometry(): BufferGeometry {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  const colors = new Float32Array([
    0.35, 0.08, 0.08, 0.9, 0.18, 0.18, 0.08, 0.35, 0.12, 0.2, 0.9, 0.32, 0.08, 0.18, 0.35, 0.18,
    0.48, 0.95,
  ]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

function createVectorLine(color: number, linewidth: number): MutableLineResources {
  const geometry = new LineGeometry();
  geometry.setPositions(new Float32Array(6));
  const startAttribute = geometry.getAttribute('instanceStart');
  if (
    !(startAttribute instanceof InterleavedBufferAttribute) ||
    !(startAttribute.data.array instanceof Float32Array)
  ) {
    throw new Error('State-vector Line2 requires one float32 interleaved segment buffer.');
  }
  const material = new LineMaterial({
    color,
    linewidth,
    transparent: true,
    opacity: 0.92,
    depthTest: false,
    depthWrite: false,
  });
  material.resolution.set(1, 1);
  const line = new Line2(geometry, material);
  line.frustumCulled = false;
  line.matrixAutoUpdate = false;
  line.updateMatrix();
  return {
    geometry,
    material,
    line,
    segmentBuffer: startAttribute.data as InstancedInterleavedBuffer,
    segmentComponents: startAttribute.data.array,
  };
}

/** Owns the setup-time resources and allocation-free hot path for the inset instrument. */
export class StateVectorWidget {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1.12, 1.12, 1.12, -1.12, 0.1, 10);
  readonly orientationRoot = new Group();
  readonly endpointComponents = new Float32Array(STATE_VECTOR_COMPONENT_COUNT);
  readonly vectorLines: readonly Line2[];
  readonly disposableGeometries: readonly BufferGeometry[];
  readonly disposableMaterials: readonly Material[];

  visibleMask = 0;
  lastRenderMs = 0;

  private readonly vectorResources: readonly MutableLineResources[];
  private readonly tipColors = new Float32Array(VECTOR_COUNT * 4);
  private readonly tipPositionAttribute: BufferAttribute;
  private readonly tipColorAttribute: BufferAttribute;
  private readonly fixedOrientation = new Quaternion().setFromEuler(new Euler(-0.55, 0.62, 0));
  private readonly previousViewport = new Vector4();
  private readonly previousScissor = new Vector4();
  private pinnedToEcliptic = false;
  private viewportX = 0;
  private viewportY = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;

  constructor() {
    this.scene.name = 'state-vector-widget';
    const backdropGeometry = new PlaneGeometry(2.24, 2.24);
    const backdropMaterial = new MeshBasicMaterial({
      color: 0x061426,
      depthTest: false,
      depthWrite: false,
    });
    const backdrop = new Mesh(backdropGeometry, backdropMaterial);
    backdrop.name = 'state-vector-backdrop';
    backdrop.position.z = -0.4;
    backdrop.renderOrder = -100;
    backdrop.matrixAutoUpdate = false;
    backdrop.updateMatrix();
    this.scene.add(backdrop);
    this.camera.name = 'state-vector-camera';
    this.camera.position.set(0, 0, 3);
    this.camera.updateMatrix();
    this.camera.updateMatrixWorld(true);
    this.orientationRoot.name = 'state-vector-orientation';
    this.orientationRoot.matrixAutoUpdate = false;
    this.scene.add(this.orientationRoot);

    const gridGeometry = createGridGeometry();
    const gridMaterial = new LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.13,
      depthTest: false,
      depthWrite: false,
    });
    const grid = new LineSegments(gridGeometry, gridMaterial);
    grid.name = 'state-vector-ecliptic-grid';
    grid.matrixAutoUpdate = false;
    grid.updateMatrix();
    this.orientationRoot.add(grid);

    const axesGeometry = createAxesGeometry();
    const axesMaterial = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      depthWrite: false,
    });
    const axes = new LineSegments(axesGeometry, axesMaterial);
    axes.name = 'state-vector-axes';
    axes.matrixAutoUpdate = false;
    axes.updateMatrix();
    this.orientationRoot.add(axes);

    const resources: MutableLineResources[] = [];
    const lines: Line2[] = [];
    const geometries: BufferGeometry[] = [backdropGeometry, gridGeometry, axesGeometry];
    const materials: Material[] = [backdropMaterial, gridMaterial, axesMaterial];
    for (let index = 0; index < VECTOR_COUNT; index += 1) {
      const resource = createVectorLine(
        VECTOR_COLORS[index] as number,
        VECTOR_WIDTHS[index] as number,
      );
      resource.line.name = `state-vector-${index}`;
      resources.push(resource);
      lines.push(resource.line);
      geometries.push(resource.geometry);
      materials.push(resource.material);
      this.orientationRoot.add(resource.line);

      const color = VECTOR_COLOR_COMPONENTS[index];
      const colorOffset = index * 4;
      this.tipColors[colorOffset] = color?.[0] ?? 1;
      this.tipColors[colorOffset + 1] = color?.[1] ?? 1;
      this.tipColors[colorOffset + 2] = color?.[2] ?? 1;
      this.tipColors[colorOffset + 3] = 0;
    }
    this.vectorResources = resources;
    this.vectorLines = lines;

    const tipGeometry = new BufferGeometry();
    this.tipPositionAttribute = new BufferAttribute(this.endpointComponents, 3);
    this.tipPositionAttribute.setUsage(DynamicDrawUsage);
    this.tipColorAttribute = new BufferAttribute(this.tipColors, 4);
    this.tipColorAttribute.setUsage(DynamicDrawUsage);
    tipGeometry.setAttribute('position', this.tipPositionAttribute);
    tipGeometry.setAttribute('glowColor', this.tipColorAttribute);
    const tipMaterial = new ShaderMaterial({
      uniforms: { pointSize: { value: 26 } },
      vertexShader: GLOW_VERTEX_SHADER,
      fragmentShader: GLOW_FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const tips = new Points(tipGeometry, tipMaterial);
    tips.name = 'state-vector-glow-tips';
    tips.frustumCulled = false;
    tips.matrixAutoUpdate = false;
    tips.updateMatrix();
    this.orientationRoot.add(tips);
    geometries.push(tipGeometry);
    materials.push(tipMaterial);
    this.disposableGeometries = geometries;
    this.disposableMaterials = materials;
    this.orientationRoot.quaternion.copy(this.fixedOrientation);
    this.orientationRoot.updateMatrix();
  }

  setPinnedToEcliptic(pinned: boolean): void {
    this.pinnedToEcliptic = pinned;
  }

  setViewportPixels(x: number, y: number, width: number, height: number): void {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      x < 0 ||
      y < 0 ||
      width < 0 ||
      height < 0
    ) {
      throw new RangeError('State-vector viewport bounds must be finite and nonnegative.');
    }
    this.viewportX = Math.round(x);
    this.viewportY = Math.round(y);
    this.viewportWidth = Math.round(width);
    this.viewportHeight = Math.round(height);
    const resolutionWidth = Math.max(1, this.viewportWidth);
    const resolutionHeight = Math.max(1, this.viewportHeight);
    for (let index = 0; index < VECTOR_COUNT; index += 1) {
      const resource = this.vectorResources[index];
      if (resource !== undefined) {
        resource.material.resolution.set(resolutionWidth, resolutionHeight);
      }
    }
  }

  update(snapshot: SimSnapshot, mainCamera: Camera): void {
    this.visibleMask = writeStateVectorEndpointsInto(
      this.endpointComponents,
      snapshot.shipCmRelativeVelocityKmS,
      snapshot.shipProperAccelerationKmS2,
      snapshot.shipRelativisticMomentumKgKmS,
      snapshot.shipAngularMomentumKgKm2S,
    );
    for (let index = 0; index < VECTOR_COUNT; index += 1) {
      const resource = this.vectorResources[index];
      if (resource === undefined) continue;
      const endpointOffset = index * 3;
      const visible = (this.visibleMask & (1 << index)) !== 0;
      resource.segmentComponents[0] = 0;
      resource.segmentComponents[1] = 0;
      resource.segmentComponents[2] = 0;
      resource.segmentComponents[3] = this.endpointComponents[endpointOffset] as number;
      resource.segmentComponents[4] = this.endpointComponents[endpointOffset + 1] as number;
      resource.segmentComponents[5] = this.endpointComponents[endpointOffset + 2] as number;
      resource.geometry.instanceCount = visible ? 1 : 0;
      resource.line.visible = visible;
      resource.segmentBuffer.needsUpdate = true;
      this.tipColors[index * 4 + 3] = visible ? 0.9 : 0;
    }
    this.tipPositionAttribute.needsUpdate = true;
    this.tipColorAttribute.needsUpdate = true;

    if (this.pinnedToEcliptic) {
      this.orientationRoot.quaternion.copy(this.fixedOrientation);
    } else {
      this.orientationRoot.quaternion.copy(mainCamera.quaternion).invert();
    }
    this.orientationRoot.updateMatrix();
  }

  /** Renders the inset and restores the main renderer's state before returning. */
  render(renderer: StateVectorRendererPort): void {
    if (this.viewportWidth === 0 || this.viewportHeight === 0) {
      this.lastRenderMs = 0;
      return;
    }
    const startMs = performance.now();
    renderer.getViewport(this.previousViewport);
    renderer.getScissor(this.previousScissor);
    const previousScissorTest = renderer.getScissorTest();
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setViewport(this.viewportX, this.viewportY, this.viewportWidth, this.viewportHeight);
    renderer.setScissor(this.viewportX, this.viewportY, this.viewportWidth, this.viewportHeight);
    renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setViewport(
      this.previousViewport.x,
      this.previousViewport.y,
      this.previousViewport.z,
      this.previousViewport.w,
    );
    renderer.setScissor(
      this.previousScissor.x,
      this.previousScissor.y,
      this.previousScissor.z,
      this.previousScissor.w,
    );
    renderer.setScissorTest(previousScissorTest);
    renderer.autoClear = previousAutoClear;
    this.lastRenderMs = performance.now() - startMs;
  }

  async prepare(renderer: WebGLRenderer): Promise<void> {
    await renderer.compileAsync(this.scene, this.camera);
  }

  dispose(): void {
    for (let index = 0; index < this.disposableGeometries.length; index += 1) {
      this.disposableGeometries[index]?.dispose();
    }
    for (let index = 0; index < this.disposableMaterials.length; index += 1) {
      this.disposableMaterials[index]?.dispose();
    }
  }
}
