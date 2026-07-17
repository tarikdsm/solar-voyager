import { Mesh, MeshStandardMaterial, WebGLRenderer } from 'three';

import bodiesDocument from '../../data/bodies.json';
import { createEpochWorld } from '../../src/render/createEpochWorld.js';
import { LightingPostPipeline } from '../../src/render/lightingPostPipeline.js';

const VIEWPORT_SIZE = 512;
const LEO_ALTITUDE_KM = 400;
const MODEL_FADE_START_MS = 1_000;
const MODEL_FADE_END_MS = 1_300;
const MODEL_READY_FADE_END_MS = 1_600;

interface RenderSnapshot {
  readonly detailBlend: number;
  readonly earthLoadState: string;
  readonly earthTier: number;
  readonly glError: number;
  readonly modelOpacity: number;
}

interface ProgramSnapshot {
  readonly beforeWarmUp: number;
  readonly afterWarmUp: number;
  readonly afterFirstFrame: number;
  readonly glError: number;
}

interface SurfaceDetailHarness {
  renderLeo(enabled: boolean): RenderSnapshot;
  renderFar(enabled: boolean): RenderSnapshot;
  renderAtmosphere(): RenderSnapshot;
  advanceClouds(nowMs: number): readonly number[];
  programSnapshot(): ProgramSnapshot;
}

declare global {
  var __surfaceDetailHarness: SurfaceDetailHarness | undefined;
}

const canvas = document.querySelector('#surface-detail-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Surface-detail canvas is missing.');

const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_SIZE, VIEWPORT_SIZE, false);
renderer.setClearColor(0x000000, 1);

const world = await createEpochWorld(renderer, { initialViewportHeightPx: VIEWPORT_SIZE });
const earthIndex = bodiesDocument.bodies.findIndex((body) => body.id === 'earth');
if (earthIndex < 0) throw new Error('Earth is missing from the surface-detail fixture.');
const earthDefinition = bodiesDocument.bodies[earthIndex];
if (earthDefinition === undefined) throw new Error('Earth definition is sparse.');
const earthOffset = earthIndex * 3;
const earthX = world.positionsKm[earthOffset] ?? Number.NaN;
const earthY = world.positionsKm[earthOffset + 1] ?? Number.NaN;
const earthZ = world.positionsKm[earthOffset + 2] ?? Number.NaN;
const earthSunDistanceKm = Math.sqrt(earthX * earthX + earthY * earthY + earthZ * earthZ);
const outwardX = earthX / earthSunDistanceKm;
const outwardY = earthY / earthSunDistanceKm;
const outwardZ = earthZ / earthSunDistanceKm;
const sunwardX = -outwardX;
const sunwardY = -outwardY;
const sunwardZ = -outwardZ;

function cameraPosition(distanceKm: number): { x: number; y: number; z: number } {
  return {
    x: earthX + sunwardX * distanceKm,
    y: earthY + sunwardY * distanceKm,
    z: earthZ + sunwardZ * distanceKm,
  };
}

function updateView(distanceKm: number, nowMs: number): void {
  const position = cameraPosition(distanceKm);
  world.spaceScene.camera.lookAt(outwardX, outwardY, outwardZ);
  world.spaceScene.camera.updateMatrix();
  world.visualSystem.update(
    position,
    VIEWPORT_SIZE,
    world.spaceScene.camera.fov * (Math.PI / 180),
    nowMs,
  );
  world.lighting.update();
  world.spaceScene.updateCameraRelative(position);
}

const leoDistanceKm = earthDefinition.meanRadiusKm + LEO_ALTITUDE_KM;
updateView(leoDistanceKm, MODEL_FADE_START_MS);
const modelDeadline = performance.now() + 60_000;
while (world.visualSystem.getLoadState('earth') !== 'ready') {
  if (performance.now() >= modelDeadline) throw new Error('Earth tier-3 model load timed out.');
  await new Promise((resolve) => setTimeout(resolve, 10));
}
updateView(leoDistanceKm, MODEL_FADE_END_MS);
updateView(leoDistanceKm, MODEL_READY_FADE_END_MS);

const pipeline = new LightingPostPipeline(
  renderer,
  world.spaceScene.scene,
  world.spaceScene.camera,
);
pipeline.resize(VIEWPORT_SIZE, VIEWPORT_SIZE, 1);
const programsBeforeWarmUp = renderer.info.programs?.length ?? 0;
pipeline.warmUp();
const programsAfterWarmUp = renderer.info.programs?.length ?? 0;
pipeline.render();
const programsAfterFirstFrame = renderer.info.programs?.length ?? 0;
const programGlError = renderer.getContext().getError();

function snapshot(): RenderSnapshot {
  return {
    detailBlend: world.visualSystem.getSurfaceDetailBlend('earth'),
    earthLoadState: world.visualSystem.getLoadState('earth'),
    earthTier: world.visualSystem.getTier('earth'),
    glError: renderer.getContext().getError(),
    modelOpacity: world.visualSystem.getOpacity('earth', 3),
  };
}

function renderAt(distanceKm: number, nowMs: number, enabled: boolean): RenderSnapshot {
  world.visualSystem.setSurfaceDetailEnabled('earth', enabled);
  updateView(distanceKm, nowMs);
  pipeline.render();
  return snapshot();
}

function cloudMatrix(): readonly number[] {
  let elements: readonly number[] | null = null;
  world.spaceScene.scene.traverse((object) => {
    if (!(object instanceof Mesh) || Array.isArray(object.material)) return;
    if (object.material instanceof MeshStandardMaterial && object.material.name === 'mat_clouds') {
      elements = Array.from(object.matrix.elements);
    }
  });
  if (elements === null) throw new Error('Earth cloud shell is missing.');
  return elements;
}

globalThis.__surfaceDetailHarness = {
  renderLeo(enabled) {
    return renderAt(leoDistanceKm, MODEL_READY_FADE_END_MS, enabled);
  },
  renderFar(enabled) {
    return renderAt(earthDefinition.meanRadiusKm * 6, MODEL_READY_FADE_END_MS, enabled);
  },
  renderAtmosphere() {
    return renderAt(earthDefinition.meanRadiusKm * 3, MODEL_READY_FADE_END_MS, true);
  },
  advanceClouds(nowMs) {
    updateView(earthDefinition.meanRadiusKm * 3, nowMs);
    return cloudMatrix();
  },
  programSnapshot() {
    return {
      beforeWarmUp: programsBeforeWarmUp,
      afterWarmUp: programsAfterWarmUp,
      afterFirstFrame: programsAfterFirstFrame,
      glError: programGlError,
    };
  },
};
