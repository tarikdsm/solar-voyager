import {
  ACESFilmicToneMapping,
  HalfFloatType,
  Mesh,
  MeshStandardMaterial,
  WebGLRenderer,
} from 'three';

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

import bodiesDocument from '../../data/bodies.json';
import { AU_KM } from '../../src/core/constants.js';
import { EARTH_NIGHT_EMISSIVE_INTENSITY } from '../../src/render/bodyVisualSystem.js';
import { createEpochWorld } from '../../src/render/createEpochWorld.js';
import {
  EXPOSURE_MAX,
  EXPOSURE_MIN,
  EXPOSURE_TAU_BRIGHT_TO_DARK_SEC,
  EXPOSURE_TAU_DARK_TO_BRIGHT_SEC,
  ExposureController,
} from '../../src/render/exposureController.js';
import { LightingPostPipeline, POST_PASS_ANCHORS } from '../../src/render/lightingPostPipeline.js';

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

interface ExposurePoseSample {
  readonly label: string;
  readonly heliocentricAu: number;
  readonly sceneLuminance: number;
  readonly targetExposure: number;
  readonly rendererExposure: number;
}

interface ExposureSample {
  readonly poses: readonly ExposurePoseSample[];
  readonly minExposure: number;
  readonly maxExposure: number;
  readonly brightToDarkSec: number;
  readonly darkToBrightSec: number;
  readonly tauBrightToDarkSec: number;
  readonly tauDarkToBrightSec: number;
  readonly glError: number;
}

interface InsertedPassSample {
  readonly defaultPassNames: readonly string[];
  readonly insertedPassNames: readonly string[];
  readonly anchors: readonly string[];
  readonly glError: number;
}

interface LightingPostHarness {
  directFallbackPrograms(): DirectFallbackPrograms;
  adaptiveExposure(): ExposureSample;
  insertedPassOrder(): InsertedPassSample;
  renderProductionSunAtExposure(exposure: number): PipelineSnapshot;
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

/**
 * The four poses plan §3.5 names, as heliocentric distances along the fixture's
 * +x axis from the real catalogued Sun position. Nothing is loaded for them: the
 * exposure key reads the packed positions, never the scene graph.
 */
const EXPOSURE_POSES: readonly { readonly label: string; readonly heliocentricAu: number }[] = [
  { label: 'near-Sun', heliocentricAu: (25 * sunDefinition.meanRadiusKm) / AU_KM },
  { label: 'Mercury', heliocentricAu: 0.387_098 },
  { label: 'Earth', heliocentricAu: 1 },
  { label: 'Neptune', heliocentricAu: 30.069_9 },
];

const exposureController = new ExposureController({
  sink: earthPipeline,
  positionsKm: world.positionsKm,
  sunIndex: world.sunIndex,
  bodyRadiiKm: world.bodyRadiiKm,
  bodyGeometricAlbedos: world.bodyGeometricAlbedos,
});

function exposureCameraAt(heliocentricAu: number): { x: number; y: number; z: number } {
  return { x: sunX + heliocentricAu * AU_KM, y: sunY, z: sunZ };
}

/** Wall seconds until the controller has closed 63.2% of the stop gap. */
function stopGapCrossingSec(
  fromAu: number,
  toAu: number,
  fromExposure: number,
  toExposure: number,
): number {
  exposureController.reset(exposureCameraAt(fromAu), -1);
  const startStops = Math.log2(fromExposure);
  const gapStops = Math.log2(toExposure) - startStops;
  const crossing = Math.pow(2, startStops + gapStops * (1 - Math.exp(-1)));
  const camera = exposureCameraAt(toAu);
  const stepSec = 1 / 60;
  for (let elapsedSec = 0; elapsedSec < 60; elapsedSec += stepSec) {
    exposureController.update(stepSec, camera, -1);
    const reached =
      gapStops > 0
        ? exposureController.exposure >= crossing
        : exposureController.exposure <= crossing;
    if (reached) return elapsedSec + stepSec;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * One real `ShaderPass` subclass per anchor, so the browser gate can assert the
 * resulting order by class name exactly as it does for the six built-in passes.
 */
class InsertedScenePass extends ShaderPass {
  constructor() {
    super(CopyShader);
  }
}
class InsertedRelativisticPass extends ShaderPass {
  constructor() {
    super(CopyShader);
  }
}
class InsertedBloomPass extends ShaderPass {
  constructor() {
    super(CopyShader);
  }
}
class InsertedAntiAliasingPass extends ShaderPass {
  constructor() {
    super(CopyShader);
  }
}

const INSERTED_PASS_CLASSES: Record<(typeof POST_PASS_ANCHORS)[number], new () => ShaderPass> = {
  scene: InsertedScenePass,
  relativistic: InsertedRelativisticPass,
  bloom: InsertedBloomPass,
  'anti-aliasing': InsertedAntiAliasingPass,
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
  /**
   * T0127 — the controller driving the *real* renderer through the pipeline sink.
   * Restores exposure 1 so every other fixture measurement stays on the v1 key.
   */
  adaptiveExposure() {
    const poses: ExposurePoseSample[] = [];
    for (const pose of EXPOSURE_POSES) {
      exposureController.reset(exposureCameraAt(pose.heliocentricAu), -1);
      poses.push({
        label: pose.label,
        heliocentricAu: pose.heliocentricAu,
        sceneLuminance: exposureController.sceneLuminance,
        targetExposure: exposureController.targetExposure,
        rendererExposure: renderer.toneMappingExposure,
      });
    }
    const brightToDarkSec = stopGapCrossingSec(1, 30.069_9, 1, EXPOSURE_MAX);
    const darkToBrightSec = stopGapCrossingSec(
      30.069_9,
      (25 * sunDefinition.meanRadiusKm) / AU_KM,
      EXPOSURE_MAX,
      EXPOSURE_MIN,
    );
    earthPipeline.setExposure(1);
    return {
      poses,
      minExposure: EXPOSURE_MIN,
      maxExposure: EXPOSURE_MAX,
      brightToDarkSec,
      darkToBrightSec,
      tauBrightToDarkSec: EXPOSURE_TAU_BRIGHT_TO_DARK_SEC,
      tauDarkToBrightSec: EXPOSURE_TAU_DARK_TO_BRIGHT_SEC,
      glError: renderer.getContext().getError(),
    };
  },
  /**
   * T0127 — real three.js passes through `insertPass`, on a throwaway pipeline so
   * the production-order measurements above keep their pristine six-pass chain.
   */
  insertedPassOrder() {
    const defaultPassNames = earthPipeline.composer.passes.map((pass) => pass.constructor.name);
    const insertionPipeline = new LightingPostPipeline(
      renderer,
      world.spaceScene.scene,
      world.spaceScene.camera,
    );
    insertionPipeline.resize(VIEWPORT_SIZE, VIEWPORT_SIZE, 1);
    for (const anchor of POST_PASS_ANCHORS) {
      const pass = new INSERTED_PASS_CLASSES[anchor]();
      pass.enabled = false;
      insertionPipeline.insertPass(pass, anchor);
    }
    insertionPipeline.render();
    const insertedPassNames = insertionPipeline.composer.passes.map(
      (pass) => pass.constructor.name,
    );
    insertionPipeline.dispose();
    earthPipeline.setExposure(1);
    return {
      defaultPassNames,
      insertedPassNames,
      anchors: [...POST_PASS_ANCHORS],
      glError: renderer.getContext().getError(),
    };
  },
  renderProductionSunAtExposure(exposure) {
    earthPipeline.setExposure(exposure);
    earthPipeline.render();
    const snapshot = pipelineSnapshot(earthPipeline);
    earthPipeline.setExposure(1);
    return snapshot;
  },
  directFallbackPrograms() {
    return {
      beforeWarmUp: directProgramsBeforeWarmUp,
      afterWarmUp: directProgramsAfterWarmUp,
      afterFirstFrame: directProgramsAfterFirstFrame,
      glError: directFallbackGlError,
    };
  },
  renderEarthNight(emissionEnabled) {
    // `createEpochWorld` leaves the camera on the chase pose (T0110), whose up is
    // the ship's, so `lookAt` alone no longer reproduces this fixture's framing.
    // State the world-frame up this measurement has always assumed.
    world.spaceScene.camera.up.set(0, 1, 0);
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
    world.spaceScene.camera.up.set(0, 1, 0);
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
