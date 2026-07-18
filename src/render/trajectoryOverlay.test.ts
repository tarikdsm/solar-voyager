import { BufferAttribute, InterleavedBufferAttribute, ShaderMaterial } from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { describe, expect, it, vi } from 'vitest';

import {
  PREDICTOR_MAX_POINTS,
  PredictorEventCode,
  type PredictorSuccessMessage,
} from '../workers/predictorProtocol.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';
import { TrajectoryOverlay } from './trajectoryOverlay.js';

const BODY_IDS = Object.freeze(['sun', 'earth', 'moon', 'mars', 'jupiter']);

function result(): PredictorSuccessMessage {
  return {
    type: 'success',
    requestId: 1,
    points: new Float64Array([0, 100, 0, 0, 10, 110, 10, 0, 20, 120, 20, 0, 30, 130, 30, 0]),
    events: new Float64Array([
      PredictorEventCode.SoiTransition,
      10,
      0,
      1,
      Number.NaN,
      Number.NaN,
      PredictorEventCode.SoiTransition,
      20,
      1,
      2,
      Number.NaN,
      Number.NaN,
      PredictorEventCode.ClosestApproach,
      15,
      4,
      -1,
      12_345,
      Number.NaN,
      PredictorEventCode.Impact,
      30,
      2,
      -1,
      1_737.4,
      30,
    ]),
  };
}

describe('TrajectoryOverlay', () => {
  it('creates one hidden maximum-sized Line2 and one marker batch at setup', () => {
    const overlay = new TrajectoryOverlay(new CameraRelativeSpaceScene(), BODY_IDS);
    const lineStart = overlay.line.geometry.getAttribute('instanceStart');
    const markerPosition = overlay.markers.geometry.getAttribute('position');

    expect(overlay.line.name).toBe('predicted-trajectory');
    expect(overlay.markers.name).toBe('trajectory-event-markers');
    expect(overlay.line.visible).toBe(false);
    expect(overlay.markers.visible).toBe(false);
    expect(lineStart).toBeInstanceOf(InterleavedBufferAttribute);
    expect(lineStart.count).toBe(PREDICTOR_MAX_POINTS - 1);
    expect(markerPosition).toBeInstanceOf(BufferAttribute);
    expect(markerPosition.count).toBe(PREDICTOR_MAX_POINTS + 2);
    expect(overlay.line.geometry.instanceCount).toBe(0);
    expect(overlay.markers.geometry.drawRange.count).toBe(0);
    expect(overlay.line.frustumCulled).toBe(true);
    expect(overlay.markers.frustumCulled).toBe(true);
  });

  it('maps body-colored segments and billboard markers without replacing resources', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const overlay = new TrajectoryOverlay(spaceScene, BODY_IDS);
    const lineGeometry = overlay.line.geometry;
    const lineStart = lineGeometry.getAttribute('instanceStart') as InterleavedBufferAttribute;
    const lineColor = lineGeometry.getAttribute('instanceColorStart') as InterleavedBufferAttribute;
    const markerPosition = overlay.markers.geometry.getAttribute('position') as BufferAttribute;
    const markerCode = overlay.markers.geometry.getAttribute('aEventCode') as BufferAttribute;
    const markerBody = overlay.markers.geometry.getAttribute('aBodyIndex') as BufferAttribute;
    const markerColor = overlay.markers.geometry.getAttribute('aColor') as BufferAttribute;
    const markerBoundingSphere = overlay.markers.geometry.boundingSphere;

    overlay.applyPrediction(result(), 0);
    overlay.setViewport(1_280, 720, 2);
    spaceScene.updateCameraRelative({ x: 100, y: 0, z: 0 });

    expect(overlay.startTimeSec).toBe(0);
    expect(overlay.sampleIntervalSec).toBe(10);
    expect(lineGeometry.instanceCount).toBe(3);
    expect(overlay.markers.geometry.drawRange.count).toBe(4);
    expect(overlay.line.visible).toBe(true);
    expect(overlay.markers.visible).toBe(true);
    expect(Array.from(lineStart.data.array.slice(0, 18))).toEqual([
      0, 0, 0, 10, 10, 0, 10, 10, 0, 20, 20, 0, 20, 20, 0, 30, 30, 0,
    ]);
    const colors = Array.from(lineColor.data.array.slice(0, 18));
    expect(colors.slice(0, 6)).not.toEqual(colors.slice(6, 12));
    expect(colors.slice(6, 12)).not.toEqual(colors.slice(12, 18));
    expect(Array.from(markerPosition.array.slice(0, 12))).toEqual([
      10, 10, 0, 20, 20, 0, 15, 15, 0, 30, 30, 0,
    ]);
    expect(overlay.markers.geometry.boundingSphere).toBe(markerBoundingSphere);
    expect(markerBoundingSphere?.center.toArray()).toEqual([20, 20, 0]);
    expect(markerBoundingSphere?.radius).toBeCloseTo(Math.sqrt(200), 12);
    expect(Array.from(markerCode.array.slice(0, 4))).toEqual([
      PredictorEventCode.SoiTransition,
      PredictorEventCode.SoiTransition,
      PredictorEventCode.ClosestApproach,
      PredictorEventCode.Impact,
    ]);
    expect(Array.from(markerBody.array.slice(0, 4))).toEqual([1, 2, 4, 2]);
    expect(Array.from(markerColor.array.slice(0, 3))).not.toEqual(
      Array.from(markerColor.array.slice(3, 6)),
    );
    expect((overlay.line.material as LineMaterial).resolution.toArray()).toEqual([1_280, 720]);
    expect((overlay.markers.material as ShaderMaterial).uniforms.uPixelRatio?.value).toBe(2);
    expect((overlay.line.material as LineMaterial).vertexColors).toBe(true);

    const originalLineArray = lineStart.data.array;
    const originalMarkerArray = markerPosition.array;
    overlay.applyPrediction(result(), 0);
    expect(lineGeometry.getAttribute('instanceStart').array).toBe(originalLineArray);
    expect(overlay.markers.geometry.getAttribute('position').array).toBe(originalMarkerArray);
  });

  it('rejects an invalid timeline before mutating an existing overlay', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const overlay = new TrajectoryOverlay(spaceScene, BODY_IDS);
    const lineStart = overlay.line.geometry.getAttribute(
      'instanceStart',
    ) as InterleavedBufferAttribute;

    overlay.applyPrediction(result(), 0);
    spaceScene.updateCameraRelative({ x: 100, y: 0, z: 0 });
    const beforeSegments = Array.from(lineStart.data.array.slice(0, 18));
    const beforeStartTime = overlay.startTimeSec;

    expect(() =>
      overlay.applyPrediction({ ...result(), points: new Float64Array([999, 999, 999, 999]) }, 0),
    ).toThrow(/at least two/u);
    spaceScene.updateCameraRelative({ x: 100, y: 0, z: 0 });

    expect(Array.from(lineStart.data.array.slice(0, 18))).toEqual(beforeSegments);
    expect(overlay.startTimeSec).toBe(beforeStartTime);
    expect(overlay.line.geometry.instanceCount).toBe(3);
    expect(overlay.line.visible).toBe(true);

    expect(() =>
      overlay.applyPrediction(
        { ...result(), points: new Float64Array([0, 1, 2, 3, 0, 4, 5, 6]) },
        0,
      ),
    ).toThrow(/strictly increasing/u);
    spaceScene.updateCameraRelative({ x: 100, y: 0, z: 0 });
    expect(Array.from(lineStart.data.array.slice(0, 18))).toEqual(beforeSegments);
  });

  it('uses one precompiled shader with distinct SOI, approach, and impact icon branches', () => {
    const overlay = new TrajectoryOverlay(new CameraRelativeSpaceScene(), BODY_IDS);
    const material = overlay.markers.material as ShaderMaterial;

    expect(material.vertexShader).toContain('gl_PointSize');
    expect(material.vertexShader).toContain('aEventCode');
    expect(material.fragmentShader).toContain('SOI_RING');
    expect(material.fragmentShader).toContain('APPROACH_DIAMOND');
    expect(material.fragmentShader).toContain('IMPACT_TRIANGLE');
    expect(material.transparent).toBe(true);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
  });

  it('hides and disposes its setup resources deterministically', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const overlay = new TrajectoryOverlay(spaceScene, BODY_IDS);
    overlay.applyPrediction(result(), 0);
    const lineGeometryDispose = vi.spyOn(overlay.line.geometry, 'dispose');
    const lineMaterialDispose = vi.spyOn(overlay.line.material, 'dispose');
    const markerGeometryDispose = vi.spyOn(overlay.markers.geometry, 'dispose');
    const markerMaterialDispose = vi.spyOn(overlay.markers.material, 'dispose');

    overlay.hide();
    expect(overlay.line.visible).toBe(false);
    expect(overlay.markers.visible).toBe(false);
    expect(overlay.line.geometry.instanceCount).toBe(0);
    expect(overlay.markers.geometry.drawRange.count).toBe(0);

    overlay.dispose();
    expect(spaceScene.scene.getObjectByName('predicted-trajectory')).toBeUndefined();
    expect(spaceScene.scene.getObjectByName('trajectory-event-markers')).toBeUndefined();
    expect(lineGeometryDispose).toHaveBeenCalledOnce();
    expect(lineMaterialDispose).toHaveBeenCalledOnce();
    expect(markerGeometryDispose).toHaveBeenCalledOnce();
    expect(markerMaterialDispose).toHaveBeenCalledOnce();
  });
});
