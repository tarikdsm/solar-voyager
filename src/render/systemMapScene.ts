import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  LineBasicMaterial,
  LineSegments,
  Points,
  ShaderMaterial,
  Vector3,
  type WebGLRenderer,
} from 'three';

import { OrbitCameraController, type CameraFocusTarget } from '../game/orbitCameraController.js';
import {
  createCartesianState,
  createOrbitalConversionScratch,
  createOrbitalElements,
  elementsToStateInto,
  type OrbitalElements,
} from '../sim/bodies/orbitalElements.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';
import { TrajectoryOverlay } from './trajectoryOverlay.js';

export const SYSTEM_MAP_ORBIT_SEGMENTS = 96;

const FULL_TURN_RAD = Math.PI * 2;
const ICON_SIZE_CSS_PX = 8;
const SELECTED_ICON_SIZE_CSS_PX = 14;

const ICON_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uPixelRatio;
attribute vec3 aColor;
attribute float aSelected;
varying vec3 vColor;
varying float vSelected;

void main() {
  vColor = aColor;
  vSelected = aSelected;
  gl_PointSize = mix(${ICON_SIZE_CSS_PX.toFixed(1)}, ${SELECTED_ICON_SIZE_CSS_PX.toFixed(1)}, aSelected) * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const ICON_FRAGMENT_SHADER = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vSelected;

void main() {
  #include <logdepthbuf_fragment>
  vec2 centered = gl_PointCoord * 2.0 - 1.0;
  float radius = length(centered);
  float disc = 1.0 - smoothstep(0.78, 1.0, radius);
  float ring = smoothstep(0.98, 0.78, radius) * smoothstep(0.52, 0.66, radius);
  float alpha = max(disc, ring * vSelected);
  if (alpha <= 0.0) discard;
  vec3 selectedColor = mix(vColor, vec3(1.0), 0.45 * vSelected);
  gl_FragColor = vec4(selectedColor, alpha);
}
`;

export interface SystemMapBodyDefinition {
  readonly id: string;
  readonly parentIndex: number;
  readonly meanRadiusKm: number;
  readonly muKm3S2: number;
  readonly albedoColor: number;
  readonly elements: Readonly<OrbitalElements> | null;
}

export interface SystemMapDiagnostics {
  readonly bodyCount: number;
  readonly iconDrawCount: 1;
  readonly orbitDrawCount: 1;
  readonly orbitSegmentCount: number;
  selectedBodyIndex: number;
  selectedRelativeX: number;
  selectedRelativeY: number;
  selectedRelativeZ: number;
  selectedProjectedX: number;
  selectedProjectedY: number;
  selectedVisible: boolean;
  selectedOrbitAlignmentKm: number;
}

function assertPositiveFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive.`);
  }
}

/** Preallocated camera-relative system-map resources driven by shared body positions. */
export class SystemMapScene {
  readonly spaceScene = new CameraRelativeSpaceScene();
  readonly bodyIcons: Points<BufferGeometry, ShaderMaterial>;
  readonly orbitLines: LineSegments<BufferGeometry, LineBasicMaterial>;
  readonly trajectoryOverlay: TrajectoryOverlay;
  readonly cameraController: OrbitCameraController;
  readonly cameraPositionKm;
  readonly diagnostics: SystemMapDiagnostics;

  private readonly positionsKm: Float64Array;
  private readonly bodies: readonly SystemMapBodyDefinition[];
  private readonly bodyIds: string[] = [];
  private readonly orbitRelativePositionsKm: Float64Array;
  private readonly orbitPositionsKm: Float64Array;
  private readonly orbitComponentStarts: Int32Array;
  private readonly selectionAttribute: BufferAttribute;
  private readonly projectedScratch = new Vector3();
  private selectedBodyIndex = 0;

  constructor(
    positionsKm: Float64Array,
    bodies: readonly SystemMapBodyDefinition[],
    initialViewportHeightPx: number,
    pixelRatio: number,
  ) {
    assertPositiveFinite('System-map viewport height', initialViewportHeightPx);
    assertPositiveFinite('System-map pixel ratio', pixelRatio);
    if (bodies.length === 0 || positionsKm.length !== bodies.length * 3) {
      throw new RangeError('System map requires one packed position per body.');
    }
    this.positionsKm = positionsKm;
    this.bodies = bodies;

    const cameraTargets: CameraFocusTarget[] = [];
    const contextRadiiKm = new Float64Array(bodies.length);
    let rootContextRadiusKm = 0;
    for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex += 1) {
      const body = bodies[bodyIndex];
      if (body === undefined) throw new Error('System-map body array is sparse.');
      if (body.id.length === 0) throw new RangeError('System-map body ids must be nonempty.');
      assertPositiveFinite(`System-map radius for ${body.id}`, body.meanRadiusKm);
      assertPositiveFinite(`System-map GM for ${body.id}`, body.muKm3S2);
      if (bodyIndex === 0) {
        if (body.parentIndex !== -1 || body.elements !== null) {
          throw new Error('The first system-map body must be the orbitless root.');
        }
      } else if (
        !Number.isInteger(body.parentIndex) ||
        body.parentIndex < 0 ||
        body.parentIndex >= bodyIndex ||
        body.elements === null
      ) {
        throw new Error(`System-map body ${body.id} requires a preceding parent and elements.`);
      }
      for (let previousIndex = 0; previousIndex < bodyIndex; previousIndex += 1) {
        if (bodies[previousIndex]?.id === body.id) {
          throw new Error(`Duplicate system-map body id "${body.id}".`);
        }
      }
      this.bodyIds.push(body.id);
      if (body.elements !== null) {
        const contextRadiusKm = Math.max(
          body.meanRadiusKm * 4,
          Math.abs(body.elements.semiMajorAxisKm) * (1 + body.elements.eccentricity),
        );
        contextRadiiKm[bodyIndex] = contextRadiusKm;
        if (body.parentIndex === 0)
          rootContextRadiusKm = Math.max(rootContextRadiusKm, contextRadiusKm);
      }
    }
    rootContextRadiusKm = Math.max(
      rootContextRadiusKm,
      bodies[0]?.meanRadiusKm === undefined ? 0 : bodies[0].meanRadiusKm * 8,
    );
    contextRadiiKm[0] = rootContextRadiusKm;
    for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex += 1) {
      const body = bodies[bodyIndex];
      const contextRadiusKm = contextRadiiKm[bodyIndex];
      if (body === undefined || contextRadiusKm === undefined) {
        throw new Error('System-map camera context arrays are out of sync.');
      }
      cameraTargets.push({
        id: body.id,
        positionOffset: bodyIndex * 3,
        meanRadiusKm: Math.max(body.meanRadiusKm, contextRadiusKm * 0.5),
      });
    }

    const rootX = positionsKm[0];
    const rootY = positionsKm[1];
    const rootZ = positionsKm[2];
    if (rootX === undefined || rootY === undefined || rootZ === undefined) {
      throw new Error('System-map root position is incomplete.');
    }
    this.cameraController = new OrbitCameraController({
      positionsKm,
      targets: cameraTargets,
      initialFocusId: bodies[0]?.id ?? '',
      initialCameraPositionKm: {
        x: rootX,
        y: rootY,
        z: rootZ + rootContextRadiusKm * 1.5,
      },
    });
    this.cameraPositionKm = this.cameraController.cameraPositionKm;

    const iconGeometry = new BufferGeometry();
    const iconPositionAttribute = new BufferAttribute(
      new Float32Array(positionsKm.length),
      3,
    ).setUsage(DynamicDrawUsage);
    const iconColors = new Float32Array(positionsKm.length);
    const selection = new Float32Array(bodies.length);
    selection[0] = 1;
    const scratchColor = new Color();
    for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex += 1) {
      const body = bodies[bodyIndex];
      if (body === undefined) throw new Error('System-map body array is sparse.');
      scratchColor.setHex(body.albedoColor);
      const component = bodyIndex * 3;
      iconColors[component] = scratchColor.r;
      iconColors[component + 1] = scratchColor.g;
      iconColors[component + 2] = scratchColor.b;
    }
    this.selectionAttribute = new BufferAttribute(selection, 1).setUsage(DynamicDrawUsage);
    iconGeometry.setAttribute('position', iconPositionAttribute);
    iconGeometry.setAttribute('aColor', new BufferAttribute(iconColors, 3));
    iconGeometry.setAttribute('aSelected', this.selectionAttribute);
    iconGeometry.computeBoundingSphere();
    const iconMaterial = new ShaderMaterial({
      uniforms: { uPixelRatio: { value: pixelRatio } },
      vertexShader: ICON_VERTEX_SHADER,
      fragmentShader: ICON_FRAGMENT_SHADER,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    this.bodyIcons = new Points(iconGeometry, iconMaterial);
    this.bodyIcons.name = 'system-map-body-icons';
    this.bodyIcons.frustumCulled = true;
    this.spaceScene.bindPackedPointPositions(this.bodyIcons, positionsKm);

    const orbitCount = bodies.length - 1;
    const orbitVertexCount = orbitCount * SYSTEM_MAP_ORBIT_SEGMENTS * 2;
    this.orbitRelativePositionsKm = new Float64Array(orbitVertexCount * 3);
    this.orbitPositionsKm = new Float64Array(orbitVertexCount * 3);
    this.orbitComponentStarts = new Int32Array(bodies.length);
    this.orbitComponentStarts.fill(-1);
    const orbitColors = new Float32Array(orbitVertexCount * 3);
    const sampleElements = createOrbitalElements();
    const sampleState = createCartesianState();
    const conversionScratch = createOrbitalConversionScratch();
    for (let bodyIndex = 1; bodyIndex < bodies.length; bodyIndex += 1) {
      const body = bodies[bodyIndex];
      const parent = body === undefined ? undefined : bodies[body.parentIndex];
      if (body === undefined || parent === undefined || body.elements === null) {
        throw new Error('System-map orbit catalog is incomplete.');
      }
      sampleElements.semiMajorAxisKm = body.elements.semiMajorAxisKm;
      sampleElements.eccentricity = body.elements.eccentricity;
      sampleElements.inclinationRad = body.elements.inclinationRad;
      sampleElements.longitudeAscendingNodeRad = body.elements.longitudeAscendingNodeRad;
      sampleElements.argumentPeriapsisRad = body.elements.argumentPeriapsisRad;
      const orbitalMuKm3S2 = parent.muKm3S2 + body.muKm3S2;
      const bodyComponentStart = (bodyIndex - 1) * SYSTEM_MAP_ORBIT_SEGMENTS * 6;
      this.orbitComponentStarts[bodyIndex] = bodyComponentStart;
      scratchColor.setHex(body.albedoColor);
      for (let segmentIndex = 0; segmentIndex < SYSTEM_MAP_ORBIT_SEGMENTS; segmentIndex += 1) {
        const segmentComponent = bodyComponentStart + segmentIndex * 6;
        for (let endpoint = 0; endpoint < 2; endpoint += 1) {
          const component = segmentComponent + endpoint * 3;
          sampleElements.meanAnomalyRad =
            (FULL_TURN_RAD * ((segmentIndex + endpoint) % SYSTEM_MAP_ORBIT_SEGMENTS)) /
            SYSTEM_MAP_ORBIT_SEGMENTS;
          elementsToStateInto(sampleState, sampleElements, orbitalMuKm3S2, conversionScratch);
          this.orbitRelativePositionsKm[component] = sampleState.positionKm.x;
          this.orbitRelativePositionsKm[component + 1] = sampleState.positionKm.y;
          this.orbitRelativePositionsKm[component + 2] = sampleState.positionKm.z;
          orbitColors[component] = scratchColor.r * 0.7;
          orbitColors[component + 1] = scratchColor.g * 0.7;
          orbitColors[component + 2] = scratchColor.b * 0.7;
        }
      }
    }
    this.anchorOrbits();
    const orbitGeometry = new BufferGeometry();
    orbitGeometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(this.orbitPositionsKm.length), 3).setUsage(
        DynamicDrawUsage,
      ),
    );
    orbitGeometry.setAttribute('color', new BufferAttribute(orbitColors, 3));
    orbitGeometry.computeBoundingSphere();
    const orbitMaterial = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.42,
      depthTest: true,
      depthWrite: false,
    });
    this.orbitLines = new LineSegments(orbitGeometry, orbitMaterial);
    this.orbitLines.name = 'system-map-orbits';
    this.orbitLines.frustumCulled = true;
    this.spaceScene.bindPackedPositions(this.orbitLines, this.orbitPositionsKm);

    this.trajectoryOverlay = new TrajectoryOverlay(this.spaceScene, this.bodyIds);
    this.diagnostics = {
      bodyCount: bodies.length,
      iconDrawCount: 1,
      orbitDrawCount: 1,
      orbitSegmentCount: orbitCount * SYSTEM_MAP_ORBIT_SEGMENTS,
      selectedBodyIndex: 0,
      selectedRelativeX: 0,
      selectedRelativeY: 0,
      selectedRelativeZ: 0,
      selectedProjectedX: 0,
      selectedProjectedY: 0,
      selectedVisible: false,
      selectedOrbitAlignmentKm: 0,
    };
    this.resize(1, initialViewportHeightPx, pixelRatio);
    this.update(0);
  }

  focusBody(id: string): boolean {
    let bodyIndex = -1;
    for (let index = 0; index < this.bodyIds.length; index += 1) {
      if (this.bodyIds[index] === id) {
        bodyIndex = index;
        break;
      }
    }
    if (bodyIndex < 0) return false;
    if (bodyIndex !== this.selectedBodyIndex) {
      const selection = this.selectionAttribute.array as Float32Array;
      selection[this.selectedBodyIndex] = 0;
      selection[bodyIndex] = 1;
      this.selectedBodyIndex = bodyIndex;
      this.selectionAttribute.needsUpdate = true;
    }
    return this.cameraController.focusBody(id);
  }

  resize(widthPx: number, heightPx: number, pixelRatio: number): void {
    assertPositiveFinite('System-map viewport width', widthPx);
    assertPositiveFinite('System-map viewport height', heightPx);
    assertPositiveFinite('System-map pixel ratio', pixelRatio);
    this.spaceScene.camera.aspect = widthPx / heightPx;
    this.spaceScene.camera.updateProjectionMatrix();
    const pixelRatioUniform = this.bodyIcons.material.uniforms.uPixelRatio;
    if (pixelRatioUniform === undefined) throw new Error('System-map icon pixel ratio is absent.');
    pixelRatioUniform.value = pixelRatio;
    this.trajectoryOverlay.setViewport(widthPx, heightPx, pixelRatio);
  }

  /** Updates live anchors, camera state, and camera-relative buffers without allocating. */
  update(deltaSec: number): void {
    this.anchorOrbits();
    this.cameraController.update(deltaSec);
    this.spaceScene.camera.lookAt(
      this.cameraController.lookDirection.x,
      this.cameraController.lookDirection.y,
      this.cameraController.lookDirection.z,
    );
    this.spaceScene.camera.updateMatrix();
    this.spaceScene.camera.updateMatrixWorld(true);
    this.spaceScene.updateCameraRelative(this.cameraPositionKm);
    this.updateDiagnostics();
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.spaceScene.scene, this.spaceScene.camera);
  }

  dispose(): void {
    this.trajectoryOverlay.dispose();
    this.spaceScene.unbindVisual(this.bodyIcons);
    this.spaceScene.unbindVisual(this.orbitLines);
    this.bodyIcons.geometry.dispose();
    this.bodyIcons.material.dispose();
    this.orbitLines.geometry.dispose();
    this.orbitLines.material.dispose();
  }

  private anchorOrbits(): void {
    for (let bodyIndex = 1; bodyIndex < this.bodies.length; bodyIndex += 1) {
      const body = this.bodies[bodyIndex];
      if (body === undefined) throw new Error('System-map body array is sparse.');
      const parentComponent = body.parentIndex * 3;
      const parentX = this.positionsKm[parentComponent];
      const parentY = this.positionsKm[parentComponent + 1];
      const parentZ = this.positionsKm[parentComponent + 2];
      const componentStart = this.orbitComponentStarts[bodyIndex];
      if (
        parentX === undefined ||
        parentY === undefined ||
        parentZ === undefined ||
        componentStart === undefined ||
        componentStart < 0
      ) {
        throw new Error('System-map orbit anchor arrays are out of sync.');
      }
      const componentEnd = componentStart + SYSTEM_MAP_ORBIT_SEGMENTS * 6;
      for (let component = componentStart; component < componentEnd; component += 3) {
        this.orbitPositionsKm[component] =
          (this.orbitRelativePositionsKm[component] as number) + parentX;
        this.orbitPositionsKm[component + 1] =
          (this.orbitRelativePositionsKm[component + 1] as number) + parentY;
        this.orbitPositionsKm[component + 2] =
          (this.orbitRelativePositionsKm[component + 2] as number) + parentZ;
      }
    }
  }

  private updateDiagnostics(): void {
    const bodyComponent = this.selectedBodyIndex * 3;
    const bodyX = this.positionsKm[bodyComponent] as number;
    const bodyY = this.positionsKm[bodyComponent + 1] as number;
    const bodyZ = this.positionsKm[bodyComponent + 2] as number;
    const relativeX = Math.fround(bodyX - this.cameraPositionKm.x);
    const relativeY = Math.fround(bodyY - this.cameraPositionKm.y);
    const relativeZ = Math.fround(bodyZ - this.cameraPositionKm.z);
    this.diagnostics.selectedBodyIndex = this.selectedBodyIndex;
    this.diagnostics.selectedRelativeX = relativeX;
    this.diagnostics.selectedRelativeY = relativeY;
    this.diagnostics.selectedRelativeZ = relativeZ;
    this.projectedScratch.set(relativeX, relativeY, relativeZ).project(this.spaceScene.camera);
    this.diagnostics.selectedProjectedX = this.projectedScratch.x;
    this.diagnostics.selectedProjectedY = this.projectedScratch.y;
    this.diagnostics.selectedVisible =
      Math.abs(this.projectedScratch.x) <= 1 &&
      Math.abs(this.projectedScratch.y) <= 1 &&
      this.projectedScratch.z >= -1 &&
      this.projectedScratch.z <= 1;

    const orbitComponentStart = this.orbitComponentStarts[this.selectedBodyIndex] as number;
    if (orbitComponentStart < 0) {
      this.diagnostics.selectedOrbitAlignmentKm = 0;
      return;
    }
    let minimumDistanceSquaredKm2 = Number.POSITIVE_INFINITY;
    const componentEnd = orbitComponentStart + SYSTEM_MAP_ORBIT_SEGMENTS * 6;
    for (let component = orbitComponentStart; component < componentEnd; component += 3) {
      const deltaX = (this.orbitPositionsKm[component] as number) - bodyX;
      const deltaY = (this.orbitPositionsKm[component + 1] as number) - bodyY;
      const deltaZ = (this.orbitPositionsKm[component + 2] as number) - bodyZ;
      minimumDistanceSquaredKm2 = Math.min(
        minimumDistanceSquaredKm2,
        deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ,
      );
    }
    this.diagnostics.selectedOrbitAlignmentKm = Math.sqrt(minimumDistanceSquaredKm2);
  }
}
