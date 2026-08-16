import { CircleGeometry, LessDepth, Mesh, MeshBasicMaterial, WebGLRenderer } from 'three';

import type { ReadonlyVec3 } from '../../src/core/vec3.js';
import {
  createRenderer,
  createRendererParameters,
  createWebGL2Context,
  type DepthStrategy,
} from '../../src/render/createRenderer.js';
import { CameraRelativeSpaceScene } from '../../src/render/spaceScene.js';

const AU_KM = 149_597_870.7;
const EARTH_RADIUS_KM = 6_371.0084;
const ERIS_RADIUS_KM = 1_200;
/**
 * Eris's heliocentric distance at the J2026 epoch, from `data/bodies.json`
 * (`a = 1.017e10 km`, `e = 0.4372`, `M = 3.6917 rad`). It sits 43 % beyond the
 * pre-T0129 far plane of 1e10 km, which is why it did not render at all.
 */
const ERIS_DISTANCE_KM = 1.429e10;
/**
 * Depth witness separation for the far case.
 *
 * The coarsest resolvable separation at this range is ~20,400 km (logarithmic
 * depth, unorm24 buffer, `far = 2.5e10`); see the design doc §1 for the
 * derivation. 1e6 km is 49x that floor, so the case asserts that depth still
 * *functions* at 1.4e10 km without pretending it is precise there.
 */
const FAR_WITNESS_SEPARATION_KM = 1e6;
const CANVAS_SIZE = 256;

interface DepthCaseDefinition {
  readonly name: 'earth-200-km' | 'earth-1-au' | 'eris-1.43e10-km';
  readonly cameraPositionKm: ReadonlyVec3;
  readonly frontPositionKm: ReadonlyVec3;
  readonly frontRadiusKm: number;
  readonly rearPositionKm: ReadonlyVec3;
  readonly rearRadiusKm: number;
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
  readonly mode: DepthStrategy | 'standard-control';
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
    frontRadiusKm: EARTH_RADIUS_KM * 0.75,
    rearPositionKm: { x: AU_KM, y: 0, z: -1 },
    rearRadiusKm: EARTH_RADIUS_KM,
    fovDeg: 160,
  },
  {
    name: 'earth-1-au',
    cameraPositionKm: { x: 0, y: 0, z: 0 },
    frontPositionKm: { x: 0, y: 0, z: -AU_KM },
    frontRadiusKm: EARTH_RADIUS_KM * 0.75,
    rearPositionKm: { x: 0, y: 0, z: -AU_KM - 500 },
    rearRadiusKm: EARTH_RADIUS_KM,
    fovDeg: 0.01,
  },
  // T0129 — the far end of the catalog. Eris at its epoch distance, observed
  // from Earth's heliocentric position so the float64 subtraction is the real
  // one. Its 1,200 km radius subtends 8.39e-8 rad from here, which the 2e-5 deg
  // field of view maps to ~61 px of the 256 px viewport.
  {
    name: 'eris-1.43e10-km',
    cameraPositionKm: { x: AU_KM, y: 0, z: 0 },
    frontPositionKm: { x: AU_KM, y: 0, z: -ERIS_DISTANCE_KM },
    frontRadiusKm: ERIS_RADIUS_KM,
    rearPositionKm: { x: AU_KM, y: 0, z: -ERIS_DISTANCE_KM - FAR_WITNESS_SEPARATION_KM },
    rearRadiusKm: ERIS_RADIUS_KM * (4 / 3),
    fovDeg: 2e-5,
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
  const rearGeometry = new CircleGeometry(definition.rearRadiusKm, 96);
  const frontGeometry = new CircleGeometry(definition.frontRadiusKm, 96);
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

const searchParameters = new URLSearchParams(window.location.search);
const isStandardControl = searchParameters.has('standard-control');
const requestedDepth = searchParameters.get('depth');
const depthStrategy: DepthStrategy = requestedDepth === 'reversed' ? 'reversed' : 'logarithmic';
let renderer: WebGLRenderer;
if (isStandardControl) {
  const context = createWebGL2Context(canvas).context;
  renderer = new WebGLRenderer({
    ...createRendererParameters(canvas, context, 'logarithmic'),
    logarithmicDepthBuffer: false,
  });
} else {
  renderer = createRenderer(canvas, { depthStrategy, pixelRatio: 1 }).renderer;
}
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
  mode: isStandardControl ? 'standard-control' : depthStrategy,
  cases: results,
  glError: renderer.getContext().getError(),
};
renderer.dispose();
