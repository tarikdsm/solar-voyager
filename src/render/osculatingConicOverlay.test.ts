import { Frustum, Matrix4, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';

import { createSimulationSnapshotBuffer } from '../sim/simulationSnapshot.js';
import { OsculatingConicOverlay } from './osculatingConicOverlay.js';
import { CameraRelativeSpaceScene } from './spaceScene.js';

const EARTH_X_KM = 149_597_870.7;

function validSnapshot() {
  const snapshot = createSimulationSnapshotBuffer(Object.freeze(['earth']));
  snapshot.bodyPositionsKm.set([EARTH_X_KM, -42_000_000.25, 7_500_000.125]);
  snapshot.dominantBodyIndex = 0;
  Object.assign(snapshot.osculatingElements, {
    valid: true,
    semiMajorAxisKm: 6_778.137,
    eccentricity: 0,
    inclinationRad: 0.3,
    longitudeAscendingNodeRad: 0.4,
    argumentPeriapsisRad: 0,
    trueAnomalyRad: 0.8,
    periapsisRadiusKm: 6_778.137,
    apoapsisRadiusKm: 6_778.137,
    periodSec: 5_553.6,
  });
  return snapshot;
}

describe('OsculatingConicOverlay', () => {
  it('updates one Line2 buffer and one camera-relative anchor in place', () => {
    const spaceScene = new CameraRelativeSpaceScene();
    const overlay = new OsculatingConicOverlay(spaceScene);
    const geometry = overlay.line.geometry;
    const startAttribute = geometry.getAttribute('instanceStart');
    const startArray = startAttribute.array;
    const anchor = overlay.line.parent;
    const snapshot = validSnapshot();

    overlay.update(snapshot, 1_920, 1_080);
    spaceScene.updateCameraRelative({
      x: EARTH_X_KM + 10_000,
      y: -42_000_000.25,
      z: 7_500_000.125,
    });
    overlay.update(snapshot, 1_280, 720);

    expect(overlay.line.geometry).toBe(geometry);
    expect(geometry.getAttribute('instanceStart')).toBe(startAttribute);
    expect(geometry.getAttribute('instanceStart').array).toBe(startArray);
    expect(geometry.instanceCount).toBe(64);
    expect(overlay.line.visible).toBe(true);
    expect(anchor?.position.toArray()).toEqual([Math.fround(-10_000), 0, 0]);
    expect(overlay.line.material.resolution.toArray()).toEqual([1_280, 720]);
  });

  it('keeps a stable bound so an off-camera conic can be frustum culled', () => {
    const overlay = new OsculatingConicOverlay(new CameraRelativeSpaceScene());
    const snapshot = validSnapshot();
    const geometry = overlay.line.geometry;
    const boundingSphere = geometry.boundingSphere;
    const anchor = overlay.line.parent;
    const camera = new PerspectiveCamera(60, 16 / 9, 1, 100_000);
    camera.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );

    overlay.update(snapshot, 1_920, 1_080);

    expect(overlay.line.frustumCulled).toBe(true);
    expect(geometry.boundingSphere).toBe(boundingSphere);
    expect(geometry.boundingSphere?.center.toArray()).toEqual([0, 0, 0]);
    expect(geometry.boundingSphere?.radius).toBeGreaterThanOrEqual(
      snapshot.osculatingElements.apoapsisRadiusKm,
    );

    anchor?.position.set(0, 0, -20_000);
    anchor?.updateMatrix();
    anchor?.updateMatrixWorld(true);
    expect(frustum.intersectsObject(overlay.line)).toBe(true);

    anchor?.position.set(1_000_000, 0, -20_000);
    anchor?.updateMatrix();
    anchor?.updateMatrixWorld(true);
    expect(geometry.boundingSphere?.radius).toBeLessThan(10_000);
    expect(overlay.line.matrixWorld.elements[12]).toBe(1_000_000);
    expect(frustum.intersectsObject(overlay.line)).toBe(false);
  });

  it('hides invalid solutions without replacing setup-time resources', () => {
    const overlay = new OsculatingConicOverlay(new CameraRelativeSpaceScene());
    const geometry = overlay.line.geometry;
    const startAttribute = geometry.getAttribute('instanceStart');
    const snapshot = validSnapshot();
    snapshot.osculatingElements.valid = false;

    overlay.update(snapshot, 1_920, 1_080);

    expect(overlay.line.visible).toBe(false);
    expect(geometry.instanceCount).toBe(0);
    expect(geometry.getAttribute('instanceStart')).toBe(startAttribute);
  });

  it('hides snapshots with an invalid dominant-body position', () => {
    const overlay = new OsculatingConicOverlay(new CameraRelativeSpaceScene());
    const snapshot = validSnapshot();
    snapshot.dominantBodyIndex = -1;

    overlay.update(snapshot, 1_920, 1_080);

    expect(overlay.line.visible).toBe(false);
    expect(overlay.line.geometry.instanceCount).toBe(0);
  });
});
