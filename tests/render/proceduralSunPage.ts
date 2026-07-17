import { WebGLRenderer } from 'three';

import bodiesDocument from '../../data/bodies.json';
import { createEpochWorld } from '../../src/render/createEpochWorld.js';
import { LightingPostPipeline } from '../../src/render/lightingPostPipeline.js';
import type { ProceduralSunQuality } from '../../src/render/proceduralSunState.js';

function viewportDimension(name: string, fallback: number): number {
  const value = Number(new URLSearchParams(globalThis.location.search).get(name) ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
  return value;
}

const VIEWPORT_WIDTH = viewportDimension('width', 512);
const VIEWPORT_HEIGHT = viewportDimension('height', 512);
const MODEL_LOAD_START_MS = 1_000;
const MODEL_FADE_END_MS = 1_600;
const CLOSE_CAMERA_RADII = 3;

type SolarDistanceLabel = 'mercury' | 'earth' | 'neptune';

interface SunRenderSnapshot {
  readonly glError: number;
  readonly modelOpacity: number;
  readonly sunLoadState: string;
  readonly sunTier: number;
}

interface ProgramSnapshot {
  readonly beforeWarmUp: number;
  readonly afterWarmUp: number;
  readonly afterFirstFrame: number;
  readonly glError: number;
}

interface ProceduralSunHarness {
  programSnapshot(): ProgramSnapshot;
  renderClose(
    simTimeSec: number,
    quality: ProceduralSunQuality,
    enabled: boolean,
  ): SunRenderSnapshot;
  renderDistance(label: SolarDistanceLabel, simTimeSec: number): SunRenderSnapshot;
  measureQualityGpu(
    quality: ProceduralSunQuality,
    sampleCount: number,
  ): Promise<readonly number[]>;
}

declare global {
  var __proceduralSunHarness: ProceduralSunHarness | undefined;
}

const canvas = document.querySelector('#procedural-sun-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Procedural Sun canvas is missing.');

const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, false);
renderer.setClearColor(0x000000, 1);

const world = await createEpochWorld(renderer, { initialViewportHeightPx: VIEWPORT_HEIGHT });
const sunIndex = bodiesDocument.bodies.findIndex((body) => body.id === 'sun');
if (sunIndex < 0) throw new Error('Sun is missing from the procedural fixture.');
const sunDefinition = bodiesDocument.bodies[sunIndex];
if (sunDefinition === undefined) throw new Error('Sun definition is sparse.');
const sunOffset = sunIndex * 3;
const sunX = world.positionsKm[sunOffset] ?? Number.NaN;
const sunY = world.positionsKm[sunOffset + 1] ?? Number.NaN;
const sunZ = world.positionsKm[sunOffset + 2] ?? Number.NaN;
if (!Number.isFinite(sunX) || !Number.isFinite(sunY) || !Number.isFinite(sunZ)) {
  throw new Error('Sun position is non-finite.');
}

function heliocentricDistanceKm(id: SolarDistanceLabel): number {
  const index = bodiesDocument.bodies.findIndex((body) => body.id === id);
  if (index < 0) throw new Error(`Fixture body ${id} is missing.`);
  const offset = index * 3;
  const x = (world.positionsKm[offset] ?? Number.NaN) - sunX;
  const y = (world.positionsKm[offset + 1] ?? Number.NaN) - sunY;
  const z = (world.positionsKm[offset + 2] ?? Number.NaN) - sunZ;
  const distanceKm = Math.sqrt(x * x + y * y + z * z);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    throw new Error(`Fixture body ${id} has no solar distance.`);
  }
  return distanceKm;
}

const closeDistanceKm = sunDefinition.meanRadiusKm * CLOSE_CAMERA_RADII;
const mercuryDistanceKm = heliocentricDistanceKm('mercury');
const earthDistanceKm = heliocentricDistanceKm('earth');
const neptuneDistanceKm = heliocentricDistanceKm('neptune');
let nowMs = MODEL_LOAD_START_MS;

function updateView(distanceKm: number, simTimeSec: number): void {
  const cameraPositionKm = { x: sunX + distanceKm, y: sunY, z: sunZ };
  world.spaceScene.camera.lookAt(-1, 0, 0);
  world.spaceScene.camera.updateMatrix();
  world.proceduralSun.update(simTimeSec);
  world.visualSystem.update(
    cameraPositionKm,
    VIEWPORT_HEIGHT,
    world.spaceScene.camera.fov * (Math.PI / 180),
    nowMs,
  );
  world.lighting.update();
  world.spaceScene.updateCameraRelative(cameraPositionKm);
}

updateView(closeDistanceKm, 0);
const modelDeadline = performance.now() + 60_000;
while (world.visualSystem.getLoadState('sun') !== 'ready') {
  if (performance.now() >= modelDeadline) throw new Error('Sun tier-3 model load timed out.');
  await new Promise((resolve) => setTimeout(resolve, 10));
}
nowMs = MODEL_FADE_END_MS;
updateView(closeDistanceKm, 0);

const pipeline = new LightingPostPipeline(
  renderer,
  world.spaceScene.scene,
  world.spaceScene.camera,
);
pipeline.resize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, 1);
const programsBeforeWarmUp = renderer.info.programs?.length ?? 0;
pipeline.warmUp();
const programsAfterWarmUp = renderer.info.programs?.length ?? 0;
pipeline.render();
const programsAfterFirstFrame = renderer.info.programs?.length ?? 0;
const programGlError = renderer.getContext().getError();

function snapshot(): SunRenderSnapshot {
  return {
    glError: renderer.getContext().getError(),
    modelOpacity: world.visualSystem.getOpacity('sun', 3),
    sunLoadState: world.visualSystem.getLoadState('sun'),
    sunTier: world.visualSystem.getTier('sun'),
  };
}

function renderAt(distanceKm: number, simTimeSec: number): SunRenderSnapshot {
  nowMs += 300;
  updateView(distanceKm, simTimeSec);
  nowMs += 300;
  updateView(distanceKm, simTimeSec);
  pipeline.render();
  return snapshot();
}

globalThis.__proceduralSunHarness = {
  programSnapshot() {
    return {
      beforeWarmUp: programsBeforeWarmUp,
      afterWarmUp: programsAfterWarmUp,
      afterFirstFrame: programsAfterFirstFrame,
      glError: programGlError,
    };
  },
  renderClose(simTimeSec, quality, enabled) {
    world.proceduralSun.setQuality(quality);
    world.proceduralSun.setEnabled(enabled);
    return renderAt(closeDistanceKm, simTimeSec);
  },
  renderDistance(label, simTimeSec) {
    world.proceduralSun.setEnabled(true);
    const distanceKm =
      label === 'mercury'
        ? mercuryDistanceKm
        : label === 'earth'
          ? earthDistanceKm
          : neptuneDistanceKm;
    return renderAt(distanceKm, simTimeSec);
  },
  async measureQualityGpu(quality, sampleCount) {
    if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
      throw new RangeError('GPU sample count must be a positive integer.');
    }
    const context = renderer.getContext();
    if (!(context instanceof WebGL2RenderingContext)) {
      throw new Error('Procedural Sun GPU benchmark requires WebGL2.');
    }
    const extension = context.getExtension('EXT_disjoint_timer_query_webgl2');
    if (extension === null) throw new Error('EXT_disjoint_timer_query_webgl2 is unavailable.');

    world.proceduralSun.setQuality(quality);
    world.proceduralSun.setEnabled(true);
    renderAt(closeDistanceKm, 0);
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve()));
    for (let frame = 0; frame < 60; frame += 1) {
      await nextFrame();
      pipeline.render();
    }

    const samples: number[] = [];
    while (samples.length < sampleCount) {
      const query = context.createQuery();
      if (query === null) throw new Error('Unable to allocate a GPU timer query.');
      context.beginQuery(extension.TIME_ELAPSED_EXT, query);
      pipeline.render();
      context.endQuery(extension.TIME_ELAPSED_EXT);
      while (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) {
        await nextFrame();
      }
      const disjoint = context.getParameter(extension.GPU_DISJOINT_EXT) as boolean;
      const elapsedNanoseconds = context.getQueryParameter(query, context.QUERY_RESULT) as number;
      context.deleteQuery(query);
      if (disjoint) continue;
      const elapsedMilliseconds = elapsedNanoseconds / 1_000_000;
      if (Number.isFinite(elapsedMilliseconds) && elapsedMilliseconds > 0) {
        samples.push(elapsedMilliseconds);
      }
      await nextFrame();
    }
    return samples;
  },
};
