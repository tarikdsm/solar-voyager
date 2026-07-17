import { Group, InterleavedBufferAttribute, type InstancedInterleavedBuffer } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import type { SimSnapshot } from '../sim/simulationSnapshot.js';
import {
  MAX_OSCULATING_CONIC_SEGMENTS,
  writeOsculatingConicPointsInto,
} from './osculatingConicGeometry.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';

const POINT_COMPONENT_COUNT = (MAX_OSCULATING_CONIC_SEGMENTS + 1) * 3;

/** Owns one setup-time Line2 and allocation-free per-frame conic updates. */
export class OsculatingConicOverlay {
  readonly line: Line2;

  private readonly anchor = new Group();
  private readonly anchorPositionKm = { x: 0, y: 0, z: 0 };
  private readonly pointsKm = new Float64Array(POINT_COMPONENT_COUNT);
  private readonly geometry: LineGeometry;
  private readonly material: LineMaterial;
  private readonly segmentBuffer: InstancedInterleavedBuffer;
  private readonly segmentComponents: Float32Array;

  constructor(spaceScene: CameraRelativeSpaceScene) {
    const setupPositions = new Float32Array(POINT_COMPONENT_COUNT);
    this.geometry = new LineGeometry();
    this.geometry.setPositions(setupPositions);
    const startAttribute = this.geometry.getAttribute('instanceStart');
    if (
      !(startAttribute instanceof InterleavedBufferAttribute) ||
      !(startAttribute.data.array instanceof Float32Array)
    ) {
      throw new Error('Line2 requires one float32 interleaved segment buffer.');
    }
    this.segmentBuffer = startAttribute.data as InstancedInterleavedBuffer;
    this.segmentComponents = startAttribute.data.array;
    this.geometry.instanceCount = 0;

    this.material = new LineMaterial({
      color: 0x55ddff,
      linewidth: 1.5,
      transparent: true,
      opacity: 0.72,
      depthTest: true,
      depthWrite: false,
    });
    this.material.resolution.set(1, 1);

    this.line = new Line2(this.geometry, this.material);
    this.line.name = 'osculating-conic';
    this.line.visible = false;
    this.line.frustumCulled = false;
    this.line.matrixAutoUpdate = false;
    this.line.updateMatrix();
    this.anchor.name = 'osculating-conic-anchor';
    this.anchor.add(this.line);
    spaceScene.bindVisual(this.anchor, this.anchorPositionKm);
  }

  /** Updates the current conic without creating or replacing render resources. */
  update(snapshot: SimSnapshot, viewportWidthPx: number, viewportHeightPx: number): void {
    const bodyIndex = snapshot.dominantBodyIndex;
    const bodyOffset = bodyIndex * 3;
    if (
      bodyIndex < 0 ||
      bodyOffset + 2 >= snapshot.bodyPositionsKm.length ||
      !Number.isFinite(viewportWidthPx) ||
      viewportWidthPx <= 0 ||
      !Number.isFinite(viewportHeightPx) ||
      viewportHeightPx <= 0
    ) {
      this.hide();
      return;
    }

    const anchorXKm = snapshot.bodyPositionsKm[bodyOffset] as number;
    const anchorYKm = snapshot.bodyPositionsKm[bodyOffset + 1] as number;
    const anchorZKm = snapshot.bodyPositionsKm[bodyOffset + 2] as number;
    if (!Number.isFinite(anchorXKm) || !Number.isFinite(anchorYKm) || !Number.isFinite(anchorZKm)) {
      this.hide();
      return;
    }

    const pointCount = writeOsculatingConicPointsInto(this.pointsKm, snapshot.osculatingElements);
    if (pointCount === 0) {
      this.hide();
      return;
    }

    this.anchorPositionKm.x = anchorXKm;
    this.anchorPositionKm.y = anchorYKm;
    this.anchorPositionKm.z = anchorZKm;
    const segmentCount = pointCount - 1;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const pointOffset = segmentIndex * 3;
      const segmentOffset = segmentIndex * 6;
      this.segmentComponents[segmentOffset] = this.pointsKm[pointOffset] as number;
      this.segmentComponents[segmentOffset + 1] = this.pointsKm[pointOffset + 1] as number;
      this.segmentComponents[segmentOffset + 2] = this.pointsKm[pointOffset + 2] as number;
      this.segmentComponents[segmentOffset + 3] = this.pointsKm[pointOffset + 3] as number;
      this.segmentComponents[segmentOffset + 4] = this.pointsKm[pointOffset + 4] as number;
      this.segmentComponents[segmentOffset + 5] = this.pointsKm[pointOffset + 5] as number;
    }
    this.geometry.instanceCount = segmentCount;
    this.segmentBuffer.needsUpdate = true;
    this.material.resolution.set(viewportWidthPx, viewportHeightPx);
    this.line.visible = true;
  }

  private hide(): void {
    this.geometry.instanceCount = 0;
    this.line.visible = false;
  }
}
