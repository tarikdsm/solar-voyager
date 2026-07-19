import {
  ACESFilmicToneMapping,
  HalfFloatType,
  Mesh,
  MeshStandardMaterial,
  WebGLRenderer,
} from 'three';

import bodiesDocument from '../../data/bodies.json';
import { EARTH_NIGHT_EMISSIVE_INTENSITY } from '../../src/render/bodyVisualSystem.js';
import { createEpochWorld } from '../../src/render/createEpochWorld.js';
import { LightingPostPipeline } from '../../src/render/lightingPostPipeline.js';

const VIEWPORT_SIZE = 512;
const EARTH_CAMERA_RADII = 3;
const SUN_CAMERA_RADII = 20;
const MODEL_FADE_START_MS = 1_000;
const MODEL_FADE_END_MS = 1_300;

interface PipelineSnapshot {
  readonly bufferType: number;
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  readonly expectedBufferType: number;
  readonly brightWidth: number;
  readonly brightHeight: number;
  readonly passNames: readonly string[];
  readonly toneMapping: number;
  readonly expectedToneMapping: number;
  readonly glError: number;
}

interface DirectFallbackPrograms {
  readonly beforeWarmUp: number;
  readonly afterWarmUp: number;
  readonly afterFirstFrame: number;
  readonly glError: number;
}

interface LightingPostHarness {
  directFallbackPrograms(): DirectFallbackPrograms;
  renderEarthNight(emissionEnabled: boolean): PipelineSnapshot & {
    readonly earthLoadState: string;
    readonly earthTier: number;
    readonly sphereOpacity: number;
    readonly modelOpacity: number;
  };
  renderProductionSun(
    bloomEnabled: boolean,
    glareEnabled: boolean,
  ): PipelineSnapshot & {
    readonly sunLoadState: string;
    readonly sunTier: number;
    readonly sphereOpacity: number;
    readonly modelOpacity: number;
  };
}

declare global {
  var __lightingPostHarness: LightingPostHarness | undefined;
}

const canvas = document.querySelector('#lighting-post-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Lighting-post canvas is missing.');

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
world.visualSystem.enableLazyLoading();
const earthPipeline = new LightingPostPipeline(
  renderer,
  world.spaceScene.scene,
  world.spaceScene.camera,
);
// Keep the lighting golden independent of the governor-owned AA stage.
earthPipeline.setAntiAliasing('off');
earthPipeline.resize(VIEWPORT_SIZE, VIEWPORT_SIZE, 1);
const directProgramsBeforeWarmUp = renderer.info.programs?.length ?? 0;
earthPipeline.warmUp(false);
const directProgramsAfterWarmUp = renderer.info.programs?.length ?? 0;
earthPipeline.render(false);
const directProgramsAfterFirstFrame = renderer.info.programs?.length ?? 0;
const directFallbackGlError = renderer.getContext().getError();
earthPipeline.warmUp();

const earthIndex = bodiesDocument.bodies.findIndex((body) => body.id === 'earth');
if (earthIndex < 0) throw new Error('Earth is missing from the lighting fixture catalog.');
const earthDefinition = bodiesDocument.bodies[earthIndex];
if (earthDefinition === undefined) throw new Error('Earth definition is sparse.');
const earthOffset = earthIndex * 3;
const earthX = world.positionsKm[earthOffset] ?? Number.NaN;
const earthY = world.positionsKm[earthOffset + 1] ?? Number.NaN;
const earthZ = world.positionsKm[earthOffset + 2] ?? Number.NaN;
const earthDistanceKm = Math.sqrt(earthX * earthX + earthY * earthY + earthZ * earthZ);
const outwardX = earthX / earthDistanceKm;
const outwardY = earthY / earthDistanceKm;
const outwardZ = earthZ / earthDistanceKm;
const cameraDistanceKm = earthDefinition.meanRadiusKm * EARTH_CAMERA_RADII;
const nightCameraPositionKm = {
  x: earthX + outwardX * cameraDistanceKm,
  y: earthY + outwardY * cameraDistanceKm,
  z: earthZ + outwardZ * cameraDistanceKm,
};

const sunIndex = bodiesDocument.bodies.findIndex((body) => body.id === 'sun');
if (sunIndex < 0) throw new Error('Sun is missing from the lighting fixture catalog.');
const sunDefinition = bodiesDocument.bodies[sunIndex];
if (sunDefinition === undefined) throw new Error('Sun definition is sparse.');
const sunOffset = sunIndex * 3;
const sunX = world.positionsKm[sunOffset] ?? Number.NaN;
const sunY = world.positionsKm[sunOffset + 1] ?? Number.NaN;
const sunZ = world.positionsKm[sunOffset + 2] ?? Number.NaN;
const sunCameraPositionKm = {
  x: sunX + sunDefinition.meanRadiusKm * SUN_CAMERA_RADII,
  y: sunY,
  z: sunZ,
};

function setEarthEmissionEnabled(enabled: boolean): void {
  let emissiveMaterialCount = 0;
  world.spaceScene.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material instanceof MeshStandardMaterial && material.emissiveMap !== null) {
        material.emissiveIntensity = enabled ? EARTH_NIGHT_EMISSIVE_INTENSITY : 0;
        emissiveMaterialCount += 1;
      }
    }
  });
  if (emissiveMaterialCount === 0) {
    throw new Error('Loaded Earth model has no emissive night-light material.');
  }
}

function pipelineSnapshot(pipeline: LightingPostPipeline): PipelineSnapshot {
  const bloom = pipeline.bloomPass as unknown as {
    readonly renderTargetBright: { readonly width: number; readonly height: number };
  };
  return {
    bufferType: pipeline.composer.readBuffer.texture.type,
    bufferWidth: pipeline.composer.readBuffer.width,
    bufferHeight: pipeline.composer.readBuffer.height,
    expectedBufferType: HalfFloatType,
    brightWidth: bloom.renderTargetBright.width,
    brightHeight: bloom.renderTargetBright.height,
    passNames: pipeline.composer.passes.map((pass) => pass.constructor.name),
    toneMapping: renderer.toneMapping,
    expectedToneMapping: ACESFilmicToneMapping,
    glError: renderer.getContext().getError(),
  };
}

globalThis.__lightingPostHarness = {
  directFallbackPrograms() {
    return {
      beforeWarmUp: directProgramsBeforeWarmUp,
      afterWarmUp: directProgramsAfterWarmUp,
      afterFirstFrame: directProgramsAfterFirstFrame,
      glError: directFallbackGlError,
    };
  },
  renderEarthNight(emissionEnabled) {
    world.spaceScene.camera.lookAt(-outwardX, -outwardY, -outwardZ);
    world.spaceScene.camera.updateMatrix();
    world.visualSystem.update(
      nightCameraPositionKm,
      VIEWPORT_SIZE,
      world.spaceScene.camera.fov * (Math.PI / 180),
      MODEL_FADE_START_MS,
    );
    world.visualSystem.update(
      nightCameraPositionKm,
      VIEWPORT_SIZE,
      world.spaceScene.camera.fov * (Math.PI / 180),
      MODEL_FADE_END_MS,
    );
    const earthLoadState = world.visualSystem.getLoadState('earth');
    if (earthLoadState === 'ready') setEarthEmissionEnabled(emissionEnabled);
    world.lighting.update();
    world.spaceScene.updateCameraRelative(nightCameraPositionKm);
    earthPipeline.render();
    return {
      ...pipelineSnapshot(earthPipeline),
      earthLoadState,
      earthTier: world.visualSystem.getTier('earth'),
      sphereOpacity: world.visualSystem.getOpacity('earth', 2),
      modelOpacity: world.visualSystem.getOpacity('earth', 3),
    };
  },
  renderProductionSun(bloomEnabled, glareEnabled) {
    world.spaceScene.camera.lookAt(-1, 0, 0);
    world.spaceScene.camera.updateMatrix();
    world.visualSystem.update(
      sunCameraPositionKm,
      VIEWPORT_SIZE,
      world.spaceScene.camera.fov * (Math.PI / 180),
      MODEL_FADE_START_MS + 1_000,
    );
    world.visualSystem.update(
      sunCameraPositionKm,
      VIEWPORT_SIZE,
      world.spaceScene.camera.fov * (Math.PI / 180),
      MODEL_FADE_END_MS + 1_000,
    );
    world.lighting.update();
    world.spaceScene.updateCameraRelative(sunCameraPositionKm);
    world.proceduralSun.billboard.visible = glareEnabled;
    earthPipeline.setBloomEnabled(bloomEnabled);
    earthPipeline.render();
    return {
      ...pipelineSnapshot(earthPipeline),
      sunLoadState: world.visualSystem.getLoadState('sun'),
      sunTier: world.visualSystem.getTier('sun'),
      sphereOpacity: world.visualSystem.getOpacity('sun', 2),
      modelOpacity: world.visualSystem.getOpacity('sun', 3),
    };
  },
};
