import {
  ACESFilmicToneMapping,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';

import bodiesDocument from '../../data/bodies.json';
import { createEpochWorld } from '../../src/render/createEpochWorld.js';
import { LightingPostPipeline } from '../../src/render/lightingPostPipeline.js';

const VIEWPORT_SIZE = 512;
const EARTH_CAMERA_RADII = 3;
const MODEL_FADE_START_MS = 1_000;
const MODEL_FADE_END_MS = 1_300;

interface PipelineSnapshot {
  readonly bufferType: number;
  readonly expectedBufferType: number;
  readonly brightWidth: number;
  readonly brightHeight: number;
  readonly passNames: readonly string[];
  readonly toneMapping: number;
  readonly expectedToneMapping: number;
  readonly glError: number;
}

interface LightingPostHarness {
  renderEarthNight(): PipelineSnapshot & {
    readonly earthLoadState: string;
    readonly earthTier: number;
    readonly sphereOpacity: number;
    readonly modelOpacity: number;
  };
  renderBloom(enabled: boolean): PipelineSnapshot;
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
const earthPipeline = new LightingPostPipeline(
  renderer,
  world.spaceScene.scene,
  world.spaceScene.camera,
);
earthPipeline.resize(VIEWPORT_SIZE, VIEWPORT_SIZE, 1);
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
world.spaceScene.camera.lookAt(-outwardX, -outwardY, -outwardZ);
world.spaceScene.camera.updateMatrix();

const bloomScene = new Scene();
const bloomCamera = new PerspectiveCamera(60, 1, 0.1, 100);
bloomCamera.position.z = 5;
bloomCamera.updateMatrix();
const bloomGeometry = new SphereGeometry(0.6, 64, 32);
const bloomMaterial = new MeshBasicMaterial({ toneMapped: true });
bloomMaterial.color.setRGB(8, 4, 1);
const bloomDisc = new Mesh(bloomGeometry, bloomMaterial);
bloomScene.add(bloomDisc);
const bloomPipeline = new LightingPostPipeline(renderer, bloomScene, bloomCamera);
bloomPipeline.resize(VIEWPORT_SIZE, VIEWPORT_SIZE, 1);
bloomPipeline.warmUp();

function pipelineSnapshot(pipeline: LightingPostPipeline): PipelineSnapshot {
  const bloom = pipeline.bloomPass as unknown as {
    readonly renderTargetBright: { readonly width: number; readonly height: number };
  };
  return {
    bufferType: pipeline.composer.readBuffer.texture.type,
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
  renderEarthNight() {
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
    world.lighting.update();
    world.spaceScene.updateCameraRelative(nightCameraPositionKm);
    earthPipeline.render();
    return {
      ...pipelineSnapshot(earthPipeline),
      earthLoadState: world.visualSystem.getLoadState('earth'),
      earthTier: world.visualSystem.getTier('earth'),
      sphereOpacity: world.visualSystem.getOpacity('earth', 2),
      modelOpacity: world.visualSystem.getOpacity('earth', 3),
    };
  },
  renderBloom(enabled) {
    bloomPipeline.setBloomEnabled(enabled);
    bloomPipeline.render();
    return pipelineSnapshot(bloomPipeline);
  },
};
