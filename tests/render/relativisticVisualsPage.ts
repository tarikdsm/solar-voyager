import { WebGLRenderer } from 'three';

import { SPEED_OF_LIGHT_KM_S } from '../../src/core/constants.js';
import { LightingPostPipeline } from '../../src/render/lightingPostPipeline.js';
import { RelativisticVisualController } from '../../src/render/relativisticVisualController.js';
import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';
import type { StarCatalog } from '../../src/render/starCatalog.js';
import { Starfield } from '../../src/render/starfield.js';
import { createSimulationSnapshotBuffer } from '../../src/sim/simulationSnapshot.js';

const WIDTH = 512;
const HEIGHT = 256;
const FIELD_OF_VIEW_DEG = 75;
const MARKER_Z = -Math.sqrt(3) / 2;

interface RelativisticFixtureSnapshot {
  readonly drawCalls: number;
  readonly glError: number;
  readonly passEnabled: boolean;
  readonly triangles: number;
}

interface RelativisticVisualsHarness {
  readonly fieldOfViewDeg: number;
  readonly height: number;
  readonly width: number;
  renderBeta(beta: number, facing: 'forward' | 'aft'): RelativisticFixtureSnapshot;
  renderGamma(gamma: number): RelativisticFixtureSnapshot;
}

declare global {
  var __relativisticVisualsHarness: RelativisticVisualsHarness | undefined;
}

const canvas = document.querySelector('#relativistic-visuals-canvas');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Relativistic visuals canvas is missing.');
}

const renderer = new WebGLRenderer({
  canvas,
  alpha: false,
  antialias: false,
  logarithmicDepthBuffer: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setClearColor(0x000000, 1);
renderer.info.autoReset = false;

const catalog: StarCatalog = {
  starCount: 3,
  strideFloats: 7,
  data: new Float32Array([
    0,
    0,
    -1,
    -5,
    0.1,
    0.1,
    0.1,
    0.5,
    0,
    MARKER_Z,
    -5,
    0.01,
    0.5,
    0.01,
    0,
    0,
    1,
    -5,
    0.1,
    0.1,
    0.1,
  ]),
};

const spaceScene = new CameraRelativeSpaceScene();
spaceScene.camera.fov = FIELD_OF_VIEW_DEG;
spaceScene.camera.aspect = WIDTH / HEIGHT;
spaceScene.camera.updateProjectionMatrix();
const starfield = new Starfield(catalog, 1);
spaceScene.scene.add(starfield.points);
const pipeline = new LightingPostPipeline(renderer, spaceScene.scene, spaceScene.camera);
pipeline.setBloomQuality('off');
pipeline.setAntiAliasing('off');
pipeline.resize(WIDTH, HEIGHT, 1);
pipeline.warmUp();

const controller = new RelativisticVisualController({
  postPass: pipeline.relativisticPass,
  spaceScene,
  starfield,
});
controller.setQualityEnabled(true);
const snapshot = createSimulationSnapshotBuffer([]);
const cameraPositionKm = { x: 0, y: 0, z: 0 };

function renderAtBeta(beta: number, facing: 'forward' | 'aft'): RelativisticFixtureSnapshot {
  if (!Number.isFinite(beta) || beta < 0 || beta >= 1) {
    throw new RangeError('Fixture beta must be finite and subluminal.');
  }
  snapshot.shipCoordinateVelocityKmS.set([0, 0, -beta * SPEED_OF_LIGHT_KM_S]);
  snapshot.speedFractionOfLight = beta;
  snapshot.gamma = 1 / Math.sqrt(1 - beta * beta);
  spaceScene.camera.lookAt(0, 0, facing === 'forward' ? -1 : 1);
  spaceScene.camera.updateMatrix();
  spaceScene.camera.updateMatrixWorld(true);
  controller.update(snapshot, spaceScene.camera);
  spaceScene.updateCameraRelative(cameraPositionKm);
  renderer.info.reset();
  pipeline.render();
  return {
    drawCalls: renderer.info.render.calls,
    glError: renderer.getContext().getError(),
    passEnabled: pipeline.relativisticPass.enabled,
    triangles: renderer.info.render.triangles,
  };
}

globalThis.__relativisticVisualsHarness = {
  fieldOfViewDeg: FIELD_OF_VIEW_DEG,
  height: HEIGHT,
  width: WIDTH,
  renderBeta: renderAtBeta,
  renderGamma(gamma) {
    if (!Number.isFinite(gamma) || gamma < 1) {
      throw new RangeError('Fixture gamma must be finite and at least one.');
    }
    return renderAtBeta(Math.sqrt(1 - 1 / (gamma * gamma)), 'forward');
  },
};
