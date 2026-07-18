import { BufferAttribute, InterleavedBufferAttribute, Vector3, WebGLRenderer } from 'three';

import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';
import { TrajectoryOverlay } from '../../src/render/trajectoryOverlay.js';
import { PredictorEventCode } from '../../src/workers/predictorProtocol.js';

interface TrajectoryOverlaySnapshot {
  readonly drawCalls: number;
  readonly markerCount: number;
  readonly maximumAlignmentCssPx: number;
  readonly segmentCount: number;
}

interface TrajectoryOverlayHarness {
  setFov(fovDeg: number): TrajectoryOverlaySnapshot;
  snapshot(): TrajectoryOverlaySnapshot;
}

declare global {
  interface Window {
    __trajectoryOverlayHarness?: TrajectoryOverlayHarness;
  }
}

const canvas = document.querySelector('#trajectory-overlay-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('trajectory fixture canvas is missing');

const renderer = new WebGLRenderer({ antialias: false, canvas });
renderer.setPixelRatio(1);
renderer.setSize(800, 450, false);
renderer.setClearColor(0x02040a, 1);
const spaceScene = new CameraRelativeSpaceScene();
spaceScene.camera.aspect = 800 / 450;
spaceScene.camera.fov = 45;
spaceScene.camera.lookAt(0, 0, -1);
spaceScene.camera.updateProjectionMatrix();
spaceScene.camera.updateMatrix();
spaceScene.camera.updateMatrixWorld(true);
const overlay = new TrajectoryOverlay(spaceScene, ['sun', 'earth', 'moon']);
overlay.applyPrediction(
  {
    type: 'success',
    requestId: 1,
    points: new Float64Array([
      0, -180, -80, -1_000, 10, -60, 90, -1_000, 20, 80, -20, -1_000, 30, 200, 70, -1_000,
    ]),
    events: new Float64Array([
      PredictorEventCode.SoiTransition,
      10,
      0,
      1,
      Number.NaN,
      Number.NaN,
      PredictorEventCode.ClosestApproach,
      15,
      2,
      -1,
      42_000,
      Number.NaN,
      PredictorEventCode.Impact,
      30,
      1,
      -1,
      6_371,
      30,
    ]),
  },
  0,
);
overlay.setViewport(800, 450, 1);
spaceScene.updateCameraRelative({ x: 0, y: 0, z: 0 });
await renderer.compileAsync(spaceScene.scene, spaceScene.camera);

const markerAttribute = overlay.markers.geometry.getAttribute('position');
const lineStartAttribute = overlay.line.geometry.getAttribute('instanceStart');
if (
  !(markerAttribute instanceof BufferAttribute) ||
  !(markerAttribute.array instanceof Float32Array) ||
  !(lineStartAttribute instanceof InterleavedBufferAttribute) ||
  !(lineStartAttribute.data.array instanceof Float32Array)
) {
  throw new Error('trajectory fixture requires float32 line and marker buffers');
}

const markerComponents = markerAttribute.array;
const segmentComponents = lineStartAttribute.data.array;
const markerSegments = new Int32Array([0, 1, 2]);
const markerFractions = new Float64Array([1, 0.5, 1]);
const markerProjection = new Vector3();
const expectedProjection = new Vector3();

function projectToCssPixels(vector: Vector3): void {
  vector.project(spaceScene.camera);
  vector.x = (vector.x * 0.5 + 0.5) * 800;
  vector.y = (-vector.y * 0.5 + 0.5) * 450;
}

function renderAndSnapshot(): TrajectoryOverlaySnapshot {
  renderer.render(spaceScene.scene, spaceScene.camera);
  let maximumAlignmentCssPx = 0;
  const markerCount = overlay.markers.geometry.drawRange.count;
  for (let markerIndex = 0; markerIndex < markerCount; markerIndex += 1) {
    const markerOffset = markerIndex * 3;
    const segmentOffset = (markerSegments[markerIndex] as number) * 6;
    const fraction = markerFractions[markerIndex] as number;
    markerProjection.set(
      markerComponents[markerOffset] as number,
      markerComponents[markerOffset + 1] as number,
      markerComponents[markerOffset + 2] as number,
    );
    expectedProjection.set(
      (segmentComponents[segmentOffset] as number) +
        fraction *
          ((segmentComponents[segmentOffset + 3] as number) -
            (segmentComponents[segmentOffset] as number)),
      (segmentComponents[segmentOffset + 1] as number) +
        fraction *
          ((segmentComponents[segmentOffset + 4] as number) -
            (segmentComponents[segmentOffset + 1] as number)),
      (segmentComponents[segmentOffset + 2] as number) +
        fraction *
          ((segmentComponents[segmentOffset + 5] as number) -
            (segmentComponents[segmentOffset + 2] as number)),
    );
    projectToCssPixels(markerProjection);
    projectToCssPixels(expectedProjection);
    maximumAlignmentCssPx = Math.max(
      maximumAlignmentCssPx,
      Math.hypot(
        markerProjection.x - expectedProjection.x,
        markerProjection.y - expectedProjection.y,
      ),
    );
  }
  return {
    drawCalls: renderer.info.render.calls,
    markerCount,
    maximumAlignmentCssPx,
    segmentCount: overlay.line.geometry.instanceCount,
  };
}

window.__trajectoryOverlayHarness = {
  setFov(fovDeg: number): TrajectoryOverlaySnapshot {
    if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) {
      throw new RangeError('trajectory fixture FOV must be within (0, 180)');
    }
    spaceScene.camera.fov = fovDeg;
    spaceScene.camera.updateProjectionMatrix();
    return renderAndSnapshot();
  },
  snapshot: renderAndSnapshot,
};
