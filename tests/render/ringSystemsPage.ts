import {
  AmbientLight,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';

import bodiesDocument from '../../data/bodies.json';
import { loadAssetManifest } from '../../src/render/assetManifest.js';
import { BodyAssetLoader } from '../../src/render/bodyAssetLoader.js';
import { ringDefinitionFor, type RingDefinition } from '../../src/render/ringCatalog.js';
import { prepareRingSystem, type PreparedRingSystem } from '../../src/render/ringSystem.js';

const VIEWPORT_SIZE = 512;
const BODY_IDS = ['jupiter', 'saturn', 'uranus', 'neptune'] as const;
type BodyId = (typeof BODY_IDS)[number];
type ViewMode = 'top' | 'shadow' | 'backlit' | 'edge';

interface PixelMetrics {
  readonly annulusMean: number;
  readonly angularContrast: number;
  readonly litPixels: number;
  readonly meanLuminance: number;
  readonly radialVariation: number;
  readonly sectorMeans: readonly number[];
}

interface RingRenderSnapshot extends PixelMetrics {
  readonly bodyId: BodyId;
  readonly calls: number;
  readonly glError: number;
  readonly mode: ViewMode;
  readonly programs: number;
  readonly triangles: number;
}

interface RingSystemsHarness {
  readonly loadedBodyIds: readonly BodyId[];
  readonly programs: {
    readonly afterFirstPass: number;
    readonly afterWarmUp: number;
    readonly beforeWarmUp: number;
  };
  render(bodyId: BodyId, mode: ViewMode): RingRenderSnapshot;
}

declare global {
  var __ringSystemsTest: RingSystemsHarness | undefined;
}

interface FixtureBody {
  readonly definition: RingDefinition;
  readonly prepared: PreparedRingSystem;
  readonly root: Awaited<ReturnType<BodyAssetLoader['loadModel']>> extends infer Loaded
    ? Loaded extends { root: infer Root }
      ? Root
      : never
    : never;
  readonly tilt: number;
}

const canvas = document.querySelector('#ring-systems-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Ring-systems canvas is missing.');

const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_SIZE, VIEWPORT_SIZE, false);
renderer.setClearColor(0x000000, 1);
const scene = new Scene();
const camera = new PerspectiveCamera(45, 1, 0.1, 2_000_000);
camera.matrixAutoUpdate = false;
const ambient = new AmbientLight(0xffffff, 0.035);
const sun = new DirectionalLight(0xffffff, Math.PI);
sun.target.position.set(0, 0, 0);
scene.add(ambient, sun, sun.target);
const manifest = await loadAssetManifest(`${import.meta.env.BASE_URL}assets/manifest.json`);
const loader = new BodyAssetLoader(renderer, manifest);
const fixtures = new Map<BodyId, FixtureBody>();
const transformed = new Vector3();

function rotateLocalIntoGlobal(
  target: Vector3,
  x: number,
  y: number,
  z: number,
  tilt: number,
): void {
  const cosine = Math.cos(tilt);
  const sine = Math.sin(tilt);
  target.set(cosine * x - sine * y, sine * x + cosine * y, z);
}

for (const bodyId of BODY_IDS) {
  const definition = ringDefinitionFor(bodyId);
  const body = bodiesDocument.bodies.find((candidate) => candidate.id === bodyId);
  const model = await loader.loadModel(bodyId);
  if (definition === null || body === undefined || model === null) {
    throw new Error(`Ring fixture could not load ${bodyId}.`);
  }
  const prepared = prepareRingSystem(model.root, model.materials, definition, {
    axialTiltRad: body.axialTiltRad,
    meanRadiusKm: body.meanRadiusKm,
    muKm3S2: body.muKm3S2,
    polarRadiusRatio: body.visual.polarRadiusRatio,
  });
  if (prepared === null) throw new Error(`Ring fixture found an incomplete ${bodyId} model.`);
  prepared.setParticleCount(0);
  model.root.scale.setScalar(definition.referenceRadiusKm);
  model.root.visible = false;
  model.root.updateMatrix();
  scene.add(model.root);
  fixtures.set(bodyId, {
    definition,
    prepared,
    root: model.root,
    tilt: body.axialTiltRad,
  });
}

function pixelMetrics(definition: RingDefinition, cameraDistanceKm: number): PixelMetrics {
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
  const center = VIEWPORT_SIZE / 2;
  const projectedOuter =
    (definition.outerRadiusKm / cameraDistanceKm / Math.tan((camera.fov * Math.PI) / 360)) * center;
  const projectedInner =
    (projectedOuter * definition.innerRadiusRatio) / definition.outerRadiusRatio;
  const radialSums = new Float64Array(24);
  const radialCounts = new Uint32Array(24);
  const sectorSums = new Float64Array(24);
  const sectorCounts = new Uint32Array(24);
  let litPixels = 0;
  let totalLuminance = 0;
  let annulusSum = 0;
  let annulusCount = 0;
  for (let y = 0; y < VIEWPORT_SIZE; y += 1) {
    for (let x = 0; x < VIEWPORT_SIZE; x += 1) {
      const offset = (y * VIEWPORT_SIZE + x) * 4;
      const luminance =
        (pixels[offset] ?? 0) * 0.2126 +
        (pixels[offset + 1] ?? 0) * 0.7152 +
        (pixels[offset + 2] ?? 0) * 0.0722;
      if (luminance > 3) litPixels += 1;
      totalLuminance += luminance;
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const radius = Math.hypot(dx, dy);
      if (radius < projectedInner + 2 || radius > projectedOuter - 2) continue;
      const radialIndex = Math.min(
        23,
        Math.floor(((radius - projectedInner) / (projectedOuter - projectedInner)) * 24),
      );
      let angle = Math.atan2(dy, dx);
      if (angle < 0) angle += Math.PI * 2;
      const sectorIndex = Math.min(23, Math.floor((angle / (Math.PI * 2)) * 24));
      radialSums[radialIndex] = (radialSums[radialIndex] ?? 0) + luminance;
      radialCounts[radialIndex] = (radialCounts[radialIndex] ?? 0) + 1;
      sectorSums[sectorIndex] = (sectorSums[sectorIndex] ?? 0) + luminance;
      sectorCounts[sectorIndex] = (sectorCounts[sectorIndex] ?? 0) + 1;
      annulusSum += luminance;
      annulusCount += 1;
    }
  }
  const radialMeans = Array.from(radialSums, (sum, index) =>
    (radialCounts[index] ?? 0) === 0 ? 0 : sum / (radialCounts[index] ?? 1),
  );
  const sectorMeans = Array.from(sectorSums, (sum, index) =>
    (sectorCounts[index] ?? 0) === 0 ? 0 : sum / (sectorCounts[index] ?? 1),
  );
  const radialMean = radialMeans.reduce((sum, value) => sum + value, 0) / radialMeans.length;
  const radialVariation = Math.sqrt(
    radialMeans.reduce((sum, value) => sum + (value - radialMean) ** 2, 0) / radialMeans.length,
  );
  const minimumSector = Math.min(...sectorMeans);
  const maximumSector = Math.max(...sectorMeans);
  return {
    annulusMean: annulusCount === 0 ? 0 : annulusSum / annulusCount,
    angularContrast: maximumSector / Math.max(0.01, minimumSector),
    litPixels,
    meanLuminance: totalLuminance / (VIEWPORT_SIZE * VIEWPORT_SIZE),
    radialVariation,
    sectorMeans,
  };
}

function renderBody(bodyId: BodyId, mode: ViewMode): RingRenderSnapshot {
  const fixture = fixtures.get(bodyId);
  if (fixture === undefined) throw new Error(`Unknown ring fixture ${bodyId}.`);
  for (const candidate of fixtures.values()) candidate.root.visible = candidate === fixture;
  const outer = fixture.definition.outerRadiusKm;
  const cameraDistance = outer * 2.95;
  const localCameraX = 0;
  let localCameraY = cameraDistance;
  let localCameraZ = 0;
  if (mode === 'edge') {
    localCameraY = outer * 0.075;
    localCameraZ = cameraDistance;
  }
  rotateLocalIntoGlobal(transformed, localCameraX, localCameraY, localCameraZ, fixture.tilt);
  camera.position.copy(transformed);
  if (mode === 'edge') {
    rotateLocalIntoGlobal(transformed, 0, 1, 0, fixture.tilt);
    camera.up.copy(transformed);
  } else {
    camera.up.set(0, 0, 1);
  }
  camera.updateMatrix();
  camera.updateMatrixWorld(true);
  camera.lookAt(0, 0, 0);
  camera.updateMatrix();
  camera.updateMatrixWorld(true);

  let localSunX = 0;
  let localSunY = 1;
  let localSunZ = 0;
  if (mode === 'shadow' || mode === 'edge') {
    localSunX = 1;
    localSunY = 0.12;
    localSunZ = 0.15;
  } else if (mode === 'backlit') {
    localSunY = -1;
    localSunZ = 0.08;
  }
  rotateLocalIntoGlobal(transformed, localSunX, localSunY, localSunZ, fixture.tilt);
  transformed.normalize();
  sun.position.copy(transformed);
  sun.updateMatrixWorld(true);
  fixture.prepared.update(
    camera.position.x,
    camera.position.y,
    camera.position.z,
    transformed.x,
    transformed.y,
    transformed.z,
    123_456,
  );
  renderer.render(scene, camera);
  return {
    bodyId,
    mode,
    ...pixelMetrics(fixture.definition, cameraDistance),
    calls: renderer.info.render.calls,
    glError: renderer.getContext().getError(),
    programs: renderer.info.programs?.length ?? 0,
    triangles: renderer.info.render.triangles,
  };
}

const beforeWarmUp = renderer.info.programs?.length ?? 0;
for (const bodyId of BODY_IDS) renderBody(bodyId, 'top');
for (const bodyId of BODY_IDS) renderBody(bodyId, 'shadow');
const afterFirstPass = renderer.info.programs?.length ?? 0;
for (const bodyId of BODY_IDS) renderBody(bodyId, 'top');
const afterWarmUp = renderer.info.programs?.length ?? 0;

globalThis.__ringSystemsTest = {
  loadedBodyIds: BODY_IDS,
  programs: { beforeWarmUp, afterFirstPass, afterWarmUp },
  render: renderBody,
};
