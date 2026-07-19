import { BufferAttribute, LineSegments, Points, ShaderMaterial, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  createCartesianState,
  createOrbitalConversionScratch,
  elementsToStateInto,
  type OrbitalElements,
} from '../sim/bodies/orbitalElements.js';
import { type PredictorSuccessMessage } from '../workers/predictorProtocol.js';
import {
  SYSTEM_MAP_ORBIT_SEGMENTS,
  SystemMapScene,
  type SystemMapBodyDefinition,
} from './systemMapScene.js';

const EARTH_ORBIT: OrbitalElements = {
  semiMajorAxisKm: 149_597_870.7,
  eccentricity: 0.0167,
  inclinationRad: 0.01,
  longitudeAscendingNodeRad: 0.2,
  argumentPeriapsisRad: 1.1,
  meanAnomalyRad: 2.2,
};

const MOON_ORBIT: OrbitalElements = {
  semiMajorAxisKm: 384_400,
  eccentricity: 0.0549,
  inclinationRad: 0.089,
  longitudeAscendingNodeRad: 0.4,
  argumentPeriapsisRad: 0.7,
  meanAnomalyRad: 1.4,
};

const BODIES: readonly SystemMapBodyDefinition[] = Object.freeze([
  {
    id: 'sun',
    parentIndex: -1,
    meanRadiusKm: 696_340,
    muKm3S2: 132_712_440_041.9394,
    albedoColor: 0xffd27d,
    elements: null,
  },
  {
    id: 'earth',
    parentIndex: 0,
    meanRadiusKm: 6_371.0084,
    muKm3S2: 398_600.435_436,
    albedoColor: 0x4f83cc,
    elements: EARTH_ORBIT,
  },
  {
    id: 'moon',
    parentIndex: 1,
    meanRadiusKm: 1_737.4,
    muKm3S2: 4_902.800_066,
    albedoColor: 0xb7b7b7,
    elements: MOON_ORBIT,
  },
]);

function createPositions(): Float64Array {
  return new Float64Array([
    1_000, 2_000, 3_000, 149_598_870.7, 2_000, 3_000, 149_983_270.7, 2_000, 3_000,
  ]);
}

function prediction(): PredictorSuccessMessage {
  return {
    type: 'success',
    requestId: 1,
    points: new Float64Array([0, 1_000, 2_000, 3_000, 10, 2_000, 3_000, 4_000]),
    events: new Float64Array(0),
  };
}

describe('SystemMapScene', () => {
  it('creates one icon draw, one orbit draw, and one map-owned trajectory overlay', () => {
    const map = new SystemMapScene(createPositions(), BODIES, {
      viewportWidthPx: 1_280,
      viewportHeightPx: 720,
      pixelRatio: 2,
    });

    expect(map.bodyIcons).toBeInstanceOf(Points);
    expect(map.orbitLines).toBeInstanceOf(LineSegments);
    expect(map.bodyIcons.parent).toBe(map.spaceScene.scene);
    expect(map.orbitLines.parent).toBe(map.spaceScene.scene);
    expect(map.bodyIcons.geometry.getAttribute('position').count).toBe(BODIES.length);
    expect(map.orbitLines.geometry.getAttribute('position').count).toBe(
      (BODIES.length - 1) * SYSTEM_MAP_ORBIT_SEGMENTS * 2,
    );
    expect(map.diagnostics.iconDrawCount).toBe(1);
    expect(map.diagnostics.orbitDrawCount).toBe(1);
    expect(map.diagnostics.orbitSegmentCount).toBe((BODIES.length - 1) * SYSTEM_MAP_ORBIT_SEGMENTS);
    expect(map.trajectoryOverlay.line.parent).toBe(map.spaceScene.scene);
    expect(map.trajectoryOverlay.markers.parent).toBe(map.spaceScene.scene);
  });

  it('samples catalog orbits through the canonical conversion and anchors them to live parents', () => {
    const positionsKm = createPositions();
    const map = new SystemMapScene(positionsKm, BODIES, {
      viewportWidthPx: 1_280,
      viewportHeightPx: 720,
      pixelRatio: 1,
    });
    const expected = createCartesianState();
    const sampleElements = { ...EARTH_ORBIT, meanAnomalyRad: 0 };
    elementsToStateInto(
      expected,
      sampleElements,
      (BODIES[0] as SystemMapBodyDefinition).muKm3S2 +
        (BODIES[1] as SystemMapBodyDefinition).muKm3S2,
      createOrbitalConversionScratch(),
    );

    map.update(0);
    map.spaceScene.updateCameraRelative({ x: 0, y: 0, z: 0 });
    const orbitAttribute = map.orbitLines.geometry.getAttribute('position') as BufferAttribute;
    expect(orbitAttribute.getX(0)).toBe(
      Math.fround((positionsKm[0] as number) + expected.positionKm.x),
    );
    expect(orbitAttribute.getY(0)).toBe(
      Math.fround((positionsKm[1] as number) + expected.positionKm.y),
    );
    expect(orbitAttribute.getZ(0)).toBe(
      Math.fround((positionsKm[2] as number) + expected.positionKm.z),
    );

    const firstX = orbitAttribute.getX(0);
    const firstY = orbitAttribute.getY(0);
    const firstZ = orbitAttribute.getZ(0);
    positionsKm[0] = (positionsKm[0] as number) + 10_000;
    positionsKm[1] = (positionsKm[1] as number) - 20_000;
    positionsKm[2] = (positionsKm[2] as number) + 30_000;
    map.update(0);
    map.spaceScene.updateCameraRelative({ x: 0, y: 0, z: 0 });

    expect(orbitAttribute.getX(0)).toBe(
      Math.fround((positionsKm[0] as number) + expected.positionKm.x),
    );
    expect(orbitAttribute.getY(0)).toBe(
      Math.fround((positionsKm[1] as number) + expected.positionKm.y),
    );
    expect(orbitAttribute.getZ(0)).toBe(
      Math.fround((positionsKm[2] as number) + expected.positionKm.z),
    );
    expect(orbitAttribute.getX(0)).not.toBe(firstX);
    expect(orbitAttribute.getY(0)).not.toBe(firstY);
    expect(orbitAttribute.getZ(0)).not.toBe(firstZ);
  });

  it('frames focus, highlights selection, and publishes finite diagnostics', () => {
    const map = new SystemMapScene(createPositions(), BODIES, {
      viewportWidthPx: 1_280,
      viewportHeightPx: 720,
      pixelRatio: 1.5,
    });
    const selection = map.bodyIcons.geometry.getAttribute('aSelected') as BufferAttribute;

    expect(map.cameraController.focusId).toBe('sun');
    expect(Array.from(selection.array)).toEqual([1, 0, 0]);
    expect(map.focusBody('earth')).toBe(true);
    map.update(2);

    expect(map.cameraController.focusId).toBe('earth');
    expect(map.cameraController.distanceKm).toBeGreaterThan(EARTH_ORBIT.semiMajorAxisKm);
    expect(Array.from(selection.array)).toEqual([0, 1, 0]);
    expect(map.diagnostics.selectedBodyIndex).toBe(1);
    expect(Number.isFinite(map.diagnostics.selectedRelativeX)).toBe(true);
    expect(Number.isFinite(map.diagnostics.selectedRelativeY)).toBe(true);
    expect(Number.isFinite(map.diagnostics.selectedRelativeZ)).toBe(true);
    expect(Number.isFinite(map.diagnostics.selectedProjectedX)).toBe(true);
    expect(Number.isFinite(map.diagnostics.selectedProjectedY)).toBe(true);
    expect(Number.isFinite(map.diagnostics.selectedOrbitAlignmentKm)).toBe(true);
    expect(Number.isFinite(map.diagnostics.selectedOrbitAlignmentPx)).toBe(true);

    expect(map.focusBody('unknown')).toBe(false);
    expect(Array.from(selection.array)).toEqual([0, 1, 0]);
  });

  it('preserves every setup resource across repeated live updates and prediction replacement', () => {
    const positionsKm = createPositions();
    const map = new SystemMapScene(positionsKm, BODIES, {
      viewportWidthPx: 1_280,
      viewportHeightPx: 720,
      pixelRatio: 1,
    });
    const iconGeometry = map.bodyIcons.geometry;
    const iconMaterial = map.bodyIcons.material;
    const iconPosition = iconGeometry.getAttribute('position');
    const orbitGeometry = map.orbitLines.geometry;
    const orbitMaterial = map.orbitLines.material;
    const orbitPosition = orbitGeometry.getAttribute('position');
    const trajectoryLineGeometry = map.trajectoryOverlay.line.geometry;
    const trajectoryMarkerGeometry = map.trajectoryOverlay.markers.geometry;
    const diagnostics = map.diagnostics;

    map.trajectoryOverlay.applyPrediction(prediction(), 0);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      positionsKm[3] = (positionsKm[3] as number) + 1;
      map.update(1 / 60);
    }
    map.trajectoryOverlay.applyPrediction(prediction(), 0);

    expect(map.bodyIcons.geometry).toBe(iconGeometry);
    expect(map.bodyIcons.material).toBe(iconMaterial);
    expect(map.bodyIcons.geometry.getAttribute('position')).toBe(iconPosition);
    expect(map.orbitLines.geometry).toBe(orbitGeometry);
    expect(map.orbitLines.material).toBe(orbitMaterial);
    expect(map.orbitLines.geometry.getAttribute('position')).toBe(orbitPosition);
    expect(map.trajectoryOverlay.line.geometry).toBe(trajectoryLineGeometry);
    expect(map.trajectoryOverlay.markers.geometry).toBe(trajectoryMarkerGeometry);
    expect(map.diagnostics).toBe(diagnostics);
  });

  it('resizes, renders with the supplied renderer, and disposes owned resources', () => {
    const map = new SystemMapScene(createPositions(), BODIES, {
      viewportWidthPx: 1_280,
      viewportHeightPx: 720,
      pixelRatio: 1,
    });
    const render = vi.fn();
    const renderer = { render } as unknown as WebGLRenderer;
    const iconMaterial = map.bodyIcons.material as ShaderMaterial;
    const iconDispose = vi.spyOn(map.bodyIcons.geometry, 'dispose');
    const orbitDispose = vi.spyOn(map.orbitLines.geometry, 'dispose');

    map.resize(1_280, 720, 2);
    map.render(renderer);

    expect(map.spaceScene.camera.aspect).toBeCloseTo(16 / 9, 12);
    expect(iconMaterial.uniforms.uPixelRatio?.value).toBe(2);
    expect(render).toHaveBeenCalledWith(map.spaceScene.scene, map.spaceScene.camera);

    map.dispose();
    expect(iconDispose).toHaveBeenCalledOnce();
    expect(orbitDispose).toHaveBeenCalledOnce();
    expect(map.bodyIcons.parent).toBeNull();
    expect(map.orbitLines.parent).toBeNull();
    expect(map.trajectoryOverlay.line.parent).toBeNull();
    expect(map.trajectoryOverlay.markers.parent).toBeNull();
  });
});
