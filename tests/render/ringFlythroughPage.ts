import {
  AmbientLight,
  DirectionalLight,
  Mesh,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';

import bodiesDocument from '../../data/bodies.json';
import { loadAssetManifest } from '../../src/render/assetManifest.js';
import { BodyAssetLoader } from '../../src/render/bodyAssetLoader.js';
import { ringDefinitionFor } from '../../src/render/ringCatalog.js';
import { prepareRingSystem } from '../../src/render/ringSystem.js';

const VIEWPORT_SIZE = 512;

interface FlythroughSnapshot {
  readonly blend: number;
  readonly calls: number;
  readonly centroidX: number;
  readonly centroidY: number;
  readonly count: number;
  readonly glError: number;
  readonly litPixels: number;
  readonly meanLuminance: number;
  readonly pixelHash: number;
  readonly programs: number;
  readonly triangles: number;
}

interface FlythroughHarness {
  readonly programs: {
    readonly afterFirstActive: number;
    readonly afterPrecompile: number;
    readonly afterWarmUp: number;
    readonly beforePrecompile: number;
  };
  sample(
    heightKm: number,
    simTimeSec: number,
    count: number,
    view?: 'annulus' | 'combined' | 'particles',
  ): FlythroughSnapshot;
  diagnostics(): {
    readonly densityAlpha: number;
    readonly densitySurvivors: number;
    readonly maximumProjectedDiameterPx: number;
    readonly nearestVisibleDepthKm: number;
    readonly projectedCandidates: number;
  };
  stress(iterations: number): { readonly blend: number; readonly heapDeltaBytes: number | null };
}

declare global {
  var __ringFlythroughTest: FlythroughHarness | undefined;
}

const canvas = document.querySelector('#ring-flythrough-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Ring-flythrough canvas is missing.');
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_SIZE, VIEWPORT_SIZE, false);
renderer.setClearColor(0x000000, 1);
const scene = new Scene();
const camera = new PerspectiveCamera(72, 1, 0.001, 20_000);
camera.matrixAutoUpdate = false;
const ambient = new AmbientLight(0xffffff, 0.04);
const sun = new DirectionalLight(0xffffff, Math.PI);
scene.add(ambient, sun, sun.target);

const manifest = await loadAssetManifest(`${import.meta.env.BASE_URL}assets/manifest.json`);
const loader = new BodyAssetLoader(renderer, manifest);
const model = await loader.loadModel('saturn');
const definition = ringDefinitionFor('saturn');
const body = bodiesDocument.bodies.find((candidate) => candidate.id === 'saturn');
if (model === null || definition === null || body === undefined) {
  throw new Error('Saturn flythrough fixture could not load its production inputs.');
}
const preparedResult = prepareRingSystem(model.root, model.materials, definition, {
  axialTiltRad: body.axialTiltRad,
  meanRadiusKm: body.meanRadiusKm,
  muKm3S2: body.muKm3S2,
  polarRadiusRatio: body.visual.polarRadiusRatio,
});
if (preparedResult === null || preparedResult.particleMesh === null) {
  throw new Error('Saturn flythrough fixture requires the prepared particle field.');
}
const prepared = preparedResult;
const particleMesh = preparedResult.particleMesh;
const authoredMeshes: Mesh[] = [];
model.root.traverse((object) => {
  if (object instanceof Mesh && object !== particleMesh) authoredMeshes.push(object);
});
model.root.scale.setScalar(definition.referenceRadiusKm);
model.root.updateMatrix();
scene.add(model.root);
const cosine = Math.cos(body.axialTiltRad);
const sine = Math.sin(body.axialTiltRad);
const transformed = new Vector3();
const target = new Vector3();
const middleRadiusKm = (definition.innerRadiusKm + definition.outerRadiusKm) / 2;

function localToGlobal(output: Vector3, x: number, y: number, z: number): void {
  output.set(cosine * x - sine * y, sine * x + cosine * y, z);
}

function pixelSnapshot(): Pick<
  FlythroughSnapshot,
  'centroidX' | 'centroidY' | 'litPixels' | 'meanLuminance' | 'pixelHash'
> {
  const context = renderer.getContext();
  const pixels = new Uint8Array(VIEWPORT_SIZE * VIEWPORT_SIZE * 4);
  context.readPixels(
    0,
    0,
    VIEWPORT_SIZE,
    VIEWPORT_SIZE,
    context.RGBA,
    context.UNSIGNED_BYTE,
    pixels,
  );
  let litPixels = 0;
  let weightedX = 0;
  let weightedY = 0;
  let totalWeight = 0;
  let pixelHash = 2_166_136_261;
  for (let y = 0; y < VIEWPORT_SIZE; y += 1) {
    for (let x = 0; x < VIEWPORT_SIZE; x += 1) {
      const offset = (y * VIEWPORT_SIZE + x) * 4;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      if (luminance > 4) {
        litPixels += 1;
        weightedX += x * luminance;
        weightedY += y * luminance;
        totalWeight += luminance;
      }
      pixelHash ^= red;
      pixelHash = Math.imul(pixelHash, 16_777_619);
      pixelHash ^= green;
      pixelHash = Math.imul(pixelHash, 16_777_619);
      pixelHash ^= blue;
      pixelHash = Math.imul(pixelHash, 16_777_619);
    }
  }
  return {
    centroidX: totalWeight === 0 ? 0 : weightedX / totalWeight,
    centroidY: totalWeight === 0 ? 0 : weightedY / totalWeight,
    litPixels,
    meanLuminance: totalWeight / (VIEWPORT_SIZE * VIEWPORT_SIZE),
    pixelHash: pixelHash >>> 0,
  };
}

function sample(
  heightKm: number,
  simTimeSec: number,
  count: number,
  view: 'annulus' | 'combined' | 'particles' = 'combined',
): FlythroughSnapshot {
  if (!Number.isFinite(heightKm)) throw new RangeError('Flythrough height must be finite.');
  prepared.setParticleCount(count);
  localToGlobal(transformed, middleRadiusKm, heightKm, 0);
  camera.position.copy(transformed);
  localToGlobal(target, middleRadiusKm, heightKm, 1_000);
  localToGlobal(camera.up, 0, 1, 0);
  camera.updateMatrix();
  camera.updateMatrixWorld(true);
  camera.lookAt(target);
  camera.updateMatrix();
  camera.updateMatrixWorld(true);
  localToGlobal(transformed, 0.25, 1, 0.2);
  transformed.normalize();
  sun.position.copy(transformed);
  sun.updateMatrixWorld(true);
  prepared.update(
    camera.position.x,
    camera.position.y,
    camera.position.z,
    transformed.x,
    transformed.y,
    transformed.z,
    simTimeSec,
  );
  for (const mesh of authoredMeshes) mesh.visible = view !== 'particles';
  particleMesh.visible = view !== 'annulus';
  renderer.render(scene, camera);
  const blend = prepared.blend;
  return {
    ...pixelSnapshot(),
    blend,
    calls: renderer.info.render.calls,
    count: particleMesh.count,
    glError: renderer.getContext().getError(),
    programs: renderer.info.programs?.length ?? 0,
    triangles: renderer.info.render.triangles,
  };
}

const beforePrecompile = renderer.info.programs?.length ?? 0;
prepared.setParticleCount(4096);
await renderer.compileAsync(scene, camera);
const afterPrecompile = renderer.info.programs?.length ?? 0;
sample(0.02, 0, 4096);
const afterFirstActive = renderer.info.programs?.length ?? 0;
sample(0.02, 0.001, 4096);
const afterWarmUp = renderer.info.programs?.length ?? 0;

globalThis.__ringFlythroughTest = {
  programs: {
    beforePrecompile,
    afterPrecompile,
    afterFirstActive,
    afterWarmUp,
  },
  sample,
  diagnostics() {
    const seeds = particleMesh.geometry.getAttribute('aRingParticle');
    const matrix = particleMesh.instanceMatrix.array;
    const materialUniforms = particleMesh.material.uniforms;
    const densityTexture = materialUniforms.uRingDensityMap?.value;
    const densityPixels = densityTexture?.image.data as Uint8Array | undefined;
    const radialUv =
      (middleRadiusKm - definition.innerRadiusKm) /
      (definition.outerRadiusKm - definition.innerRadiusKm);
    const densityIndex = Math.min(255, Math.max(0, Math.floor(radialUv * 256)));
    const densityAlpha = (densityPixels?.[densityIndex * 4 + 3] ?? 0) / 255;
    const tangentLimit = Math.tan((camera.fov * Math.PI) / 360);
    let densitySurvivors = 0;
    let maximumProjectedDiameterPx = 0;
    let nearestVisibleDepthKm = Number.POSITIVE_INFINITY;
    let projectedCandidates = 0;
    for (let index = 0; index < particleMesh.instanceMatrix.count; index += 1) {
      if (seeds.getW(index) > densityAlpha) continue;
      densitySurvivors += 1;
      const radialOffsetKm = (seeds.getX(index) * 2 - 1) * 2_400;
      const depthKm = (seeds.getY(index) * 2 - 1) * 2_400;
      if (depthKm <= camera.near || Math.abs(radialOffsetKm) > depthKm * tangentLimit) continue;
      const verticalKm = (seeds.getZ(index) * 2 - 1) * 0.12 - 0.02;
      if (Math.abs(verticalKm) > depthKm * tangentLimit) continue;
      const sizeKm = (matrix[index * 16] ?? 0) * definition.referenceRadiusKm * 2;
      const projectedDiameterPx =
        (sizeKm / depthKm / Math.tan((camera.fov * Math.PI) / 360)) * (VIEWPORT_SIZE / 2);
      maximumProjectedDiameterPx = Math.max(maximumProjectedDiameterPx, projectedDiameterPx);
      nearestVisibleDepthKm = Math.min(nearestVisibleDepthKm, depthKm);
      if (projectedDiameterPx >= 0.25) projectedCandidates += 1;
    }
    return {
      densityAlpha,
      densitySurvivors,
      maximumProjectedDiameterPx,
      nearestVisibleDepthKm,
      projectedCandidates,
    };
  },
  stress(iterations) {
    if (!Number.isInteger(iterations) || iterations <= 0) {
      throw new RangeError('Flythrough stress iterations must be a positive integer.');
    }
    const performanceWithMemory = performance as Performance & {
      readonly memory?: { readonly usedJSHeapSize: number };
    };
    const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    collectGarbage?.();
    collectGarbage?.();
    const beforeHeap = performanceWithMemory.memory?.usedJSHeapSize ?? null;
    prepared.setParticleCount(4096);
    for (let index = 0; index < iterations; index += 1) {
      prepared.update(
        camera.position.x,
        camera.position.y,
        camera.position.z,
        transformed.x,
        transformed.y,
        transformed.z,
        index * 0.125,
      );
    }
    collectGarbage?.();
    collectGarbage?.();
    const afterHeap = performanceWithMemory.memory?.usedJSHeapSize ?? null;
    return {
      blend: prepared.blend,
      heapDeltaBytes: beforeHeap === null || afterHeap === null ? null : afterHeap - beforeHeap,
    };
  },
};
