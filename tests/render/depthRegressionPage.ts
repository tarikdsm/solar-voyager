import { CircleGeometry, LessDepth, Mesh, MeshBasicMaterial, WebGLRenderer } from 'three';

import type { ReadonlyVec3 } from '../../src/core/vec3.js';
import { createRenderer, createRendererParameters } from '../../src/render/createRenderer.js';
import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';

const AU_KM = 149_597_870.7;
const EARTH_RADIUS_KM = 6_371.0084;
const CANVAS_SIZE = 256;

interface DepthCaseDefinition {
  readonly name: 'earth-200-km' | 'earth-1-au';
  readonly cameraPositionKm: ReadonlyVec3;
  readonly frontPositionKm: ReadonlyVec3;
  readonly rearPositionKm: ReadonlyVec3;
  readonly fovDeg: number;
}

interface DepthCaseResult {
  readonly name: DepthCaseDefinition['name'];
  readonly centerFront: boolean;
  readonly frontPixels: number;
  readonly rearPixels: number;
  readonly backgroundPixels: number;
  readonly stablePixels: boolean;
}

interface DepthRegressionResult {
  readonly mode: 'logarithmic' | 'standard-control';
  readonly cases: readonly DepthCaseResult[];
  readonly glError: number;
}

declare global {
  interface Window {
    __depthRegressionResult?: DepthRegressionResult;
  }
}

const cases: readonly DepthCaseDefinition[] = [
  {
    name: 'earth-200-km',
    cameraPositionKm: { x: AU_KM, y: 0, z: EARTH_RADIUS_KM + 200 },
    frontPositionKm: { x: AU_KM, y: 0, z: 0 },
    rearPositionKm: { x: AU_KM, y: 0, z: -1 },
    fovDeg: 160,
  },
  {
    name: 'earth-1-au',
    cameraPositionKm: { x: 0, y: 0, z: 0 },
    frontPositionKm: { x: 0, y: 0, z: -AU_KM },
    rearPositionKm: { x: 0, y: 0, z: -AU_KM - 500 },
    fovDeg: 0.01,
  },
];

function readPixels(renderer: WebGLRenderer): Uint8Array {
  const pixels = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE * 4);
  const context = renderer.getContext();
  context.readPixels(0, 0, CANVAS_SIZE, CANVAS_SIZE, context.RGBA, context.UNSIGNED_BYTE, pixels);
  return pixels;
}

function classifyPixels(
  name: DepthCaseDefinition['name'],
  firstFrame: Uint8Array,
  secondFrame: Uint8Array,
): DepthCaseResult {
  let frontPixels = 0;
  let rearPixels = 0;
  let backgroundPixels = 0;
  let stablePixels = true;

  for (let offset = 0; offset < firstFrame.length; offset += 4) {
    const red = firstFrame[offset] ?? 0;
    const green = firstFrame[offset + 1] ?? 0;
    const blue = firstFrame[offset + 2] ?? 0;

    if (red > blue * 2 && red > 40) {
      frontPixels += 1;
    } else if (blue > red * 2 && blue > 40) {
      rearPixels += 1;
    } else if (red < 10 && green < 10 && blue < 10) {
      backgroundPixels += 1;
    }

    if (
      firstFrame[offset] !== secondFrame[offset] ||
      firstFrame[offset + 1] !== secondFrame[offset + 1] ||
      firstFrame[offset + 2] !== secondFrame[offset + 2] ||
      firstFrame[offset + 3] !== secondFrame[offset + 3]
    ) {
      stablePixels = false;
    }
  }

  const centerOffset = (Math.floor(CANVAS_SIZE / 2) * CANVAS_SIZE + CANVAS_SIZE / 2) * 4;
  const centerRed = firstFrame[centerOffset] ?? 0;
  const centerBlue = firstFrame[centerOffset + 2] ?? 0;

  return {
    name,
    centerFront: centerRed > centerBlue * 2 && centerRed > 40,
    frontPixels,
    rearPixels,
    backgroundPixels,
    stablePixels,
  };
}

function renderCase(renderer: WebGLRenderer, definition: DepthCaseDefinition): DepthCaseResult {
  const spaceScene = new CameraRelativeSpaceScene();
  const rearGeometry = new CircleGeometry(EARTH_RADIUS_KM, 96);
  const frontGeometry = new CircleGeometry(EARTH_RADIUS_KM * 0.75, 96);
  const rearMaterial = new MeshBasicMaterial({ color: 0x0040ff });
  const frontMaterial = new MeshBasicMaterial({ color: 0xff2000, depthFunc: LessDepth });
  const rear = new Mesh(rearGeometry, rearMaterial);
  const front = new Mesh(frontGeometry, frontMaterial);

  rear.renderOrder = 0;
  front.renderOrder = 1;
  spaceScene.bindVisual(rear, definition.rearPositionKm);
  spaceScene.bindVisual(front, definition.frontPositionKm);
  spaceScene.camera.fov = definition.fovDeg;
  spaceScene.camera.updateProjectionMatrix();
  spaceScene.updateCameraRelative(definition.cameraPositionKm);

  renderer.render(spaceScene.scene, spaceScene.camera);
  const firstFrame = readPixels(renderer);
  spaceScene.updateCameraRelative(definition.cameraPositionKm);
  renderer.render(spaceScene.scene, spaceScene.camera);
  const secondFrame = readPixels(renderer);
  const result = classifyPixels(definition.name, firstFrame, secondFrame);

  rearGeometry.dispose();
  frontGeometry.dispose();
  rearMaterial.dispose();
  frontMaterial.dispose();
  return result;
}

const canvas = document.querySelector('#depth-regression-canvas');

if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Depth regression canvas was not found.');
}

const isStandardControl = new URLSearchParams(window.location.search).has('standard-control');
const renderer = isStandardControl
  ? new WebGLRenderer({
      ...createRendererParameters(canvas),
      logarithmicDepthBuffer: false,
    })
  : createRenderer(canvas);
renderer.setPixelRatio(1);
renderer.setSize(CANVAS_SIZE, CANVAS_SIZE, false);
renderer.setClearColor(0x000000, 1);

const results: DepthCaseResult[] = [];
for (let index = 0; index < cases.length; index += 1) {
  const definition = cases[index];
  if (definition !== undefined) {
    results.push(renderCase(renderer, definition));
  }
}

window.__depthRegressionResult = {
  mode: isStandardControl ? 'standard-control' : 'logarithmic',
  cases: results,
  glError: renderer.getContext().getError(),
};
renderer.dispose();
