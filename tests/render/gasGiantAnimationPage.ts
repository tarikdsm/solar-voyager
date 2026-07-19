import {
  AmbientLight,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
  type Object3D,
} from 'three';

import bodiesDocument from '../../data/bodies.json';
import { loadAssetManifest } from '../../src/render/assetManifest.js';
import { BodyAssetLoader } from '../../src/render/bodyAssetLoader.js';
import { GasGiantAnimation, prepareGasGiantAnimation } from '../../src/render/gasGiantAnimation.js';
import type { ProceduralQuality } from '../../src/render/proceduralSunState.js';
import {
  prepareSurfaceDetail,
  type PreparedSurfaceDetail,
} from '../../src/render/surfaceDetail.js';

function viewportDimension(name: string, fallback: number): number {
  const value = Number(new URLSearchParams(globalThis.location.search).get(name) ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
  return value;
}

const WIDTH = viewportDimension('width', 512);
const HEIGHT = viewportDimension('height', 512);
const BODY_IDS = ['jupiter', 'saturn', 'uranus', 'neptune'] as const;
type BodyId = (typeof BODY_IDS)[number];

interface FixtureBody {
  readonly animation: GasGiantAnimation;
  readonly detail: PreparedSurfaceDetail | null;
  readonly root: Object3D;
  readonly seed: number;
  readonly surface: MeshStandardMaterial;
}

interface RenderSnapshot {
  readonly bodyId: BodyId | 'jupiter-spot';
  readonly calls: number;
  readonly detailBlend: number;
  readonly glError: number;
  readonly octaves: number;
  readonly programs: number;
  readonly seed: number;
  readonly triangles: number;
}

interface GasGiantAnimationHarness {
  renderBody(
    bodyId: BodyId,
    simTimeSec: number,
    quality: ProceduralQuality,
    enabled: boolean,
  ): RenderSnapshot;
  renderSpot(simTimeSec: number, enabled: boolean): RenderSnapshot;
  measureQualityCpu(quality: ProceduralQuality, sampleCount: number): Promise<readonly number[]>;
  measureQualityGpu(quality: ProceduralQuality, sampleCount: number): Promise<readonly number[]>;
  setupSnapshot(): {
    readonly glError: number;
    readonly loadedBodyIds: readonly BodyId[];
    readonly programs: {
      readonly afterFirstPass: number;
      readonly afterWarmUp: number;
      readonly beforeWarmUp: number;
    };
  };
}

declare global {
  var __gasGiantAnimationTest: GasGiantAnimationHarness | undefined;
}

const canvas = document.querySelector('#gas-giant-animation-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Gas-giant canvas is missing.');

const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setClearColor(0x000000, 1);
const scene = new Scene();
const camera = new PerspectiveCamera(45, WIDTH / HEIGHT, 0.01, 100);
camera.position.set(0, 0, 3);
camera.lookAt(0, 0, 0);
const ambient = new AmbientLight(0xffffff, 0.42);
const directional = new DirectionalLight(0xffffff, 2.4);
directional.position.set(3, 2, 4);
directional.target.position.set(0, 0, 0);
scene.add(ambient, directional, directional.target);

const manifest = await loadAssetManifest(`${import.meta.env.BASE_URL}assets/manifest.json`);
const loader = new BodyAssetLoader(renderer, manifest);
const fixtures = new Map<BodyId, FixtureBody>();

function hideRingMeshes(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some((material) => material.name === 'mat_rings')) object.visible = false;
  });
}

for (const bodyId of BODY_IDS) {
  const body = bodiesDocument.bodies.find((candidate) => candidate.id === bodyId);
  const model = await loader.loadModel(bodyId);
  if (body === undefined || model === null) throw new Error(`Unable to load ${bodyId}.`);
  const surface = model.materials.find(
    (material): material is MeshStandardMaterial =>
      material instanceof MeshStandardMaterial && material.name === 'mat_surface',
  );
  if (surface === undefined || surface.map === null) {
    throw new Error(`${bodyId} has no mapped mat_surface.`);
  }
  const animation = prepareGasGiantAnimation(bodyId, body.visual.proceduralSeed, surface);
  if (animation === null) throw new Error(`${bodyId} is not recognized as a gas giant.`);
  const detail =
    model.surfaceDetail === null ? null : prepareSurfaceDetail(surface, model.surfaceDetail);
  detail?.setDistance(body.meanRadiusKm * 2.6, body.meanRadiusKm);
  model.root.scale.setScalar(1);
  model.root.rotation.set(0, 0, 0);
  model.root.visible = false;
  hideRingMeshes(model.root);
  scene.add(model.root);
  fixtures.set(bodyId, {
    animation,
    detail,
    root: model.root,
    seed: body.visual.proceduralSeed,
    surface,
  });
}

const jupiter = fixtures.get('jupiter');
if (jupiter === undefined) throw new Error('Jupiter fixture is missing.');
const spotMaterial = new MeshStandardMaterial({
  color: jupiter.surface.color,
  map: jupiter.surface.map,
  metalness: jupiter.surface.metalness,
  roughness: jupiter.surface.roughness,
});
spotMaterial.name = 'mat_surface';
const spotAnimation = new GasGiantAnimation('jupiter', jupiter.seed, spotMaterial);
const spotPlane = new Mesh(new PlaneGeometry(2, 1), spotMaterial);
spotPlane.visible = false;
scene.add(spotPlane);

function showOnly(bodyId: BodyId | null): FixtureBody | null {
  let selected: FixtureBody | null = null;
  for (const [candidateId, fixture] of fixtures) {
    fixture.root.visible = candidateId === bodyId;
    if (candidateId === bodyId) selected = fixture;
  }
  spotPlane.visible = bodyId === null;
  return selected;
}

function renderSnapshot(
  bodyId: BodyId | 'jupiter-spot',
  seed: number,
  animation: GasGiantAnimation,
  detail: PreparedSurfaceDetail | null = null,
): RenderSnapshot {
  renderer.render(scene, camera);
  return {
    bodyId,
    calls: renderer.info.render.calls,
    detailBlend: detail?.blend ?? 0,
    glError: renderer.getContext().getError(),
    octaves: animation.state.uniforms.uGasOctaves.value,
    programs: renderer.info.programs?.length ?? 0,
    seed,
    triangles: renderer.info.render.triangles,
  };
}

function configureBodyCamera(): void {
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
}

function configureSpotCamera(): void {
  camera.position.set(0, 0, 2.6);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
}

const programsBeforeWarmUp = renderer.info.programs?.length ?? 0;
for (const bodyId of BODY_IDS) {
  const fixture = showOnly(bodyId);
  if (fixture === null) throw new Error(`Missing warm-up fixture ${bodyId}.`);
  configureBodyCamera();
  fixture.animation.update(0);
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
}
showOnly(null);
configureSpotCamera();
spotAnimation.update(0);
await renderer.compileAsync(scene, camera);
renderer.render(scene, camera);
const programsAfterFirstPass = renderer.info.programs?.length ?? 0;
for (const bodyId of BODY_IDS) {
  showOnly(bodyId);
  configureBodyCamera();
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
}
showOnly(null);
configureSpotCamera();
await renderer.compileAsync(scene, camera);
renderer.render(scene, camera);
const programsAfterWarmUp = renderer.info.programs?.length ?? 0;
const setupGlError = renderer.getContext().getError();

globalThis.__gasGiantAnimationTest = {
  async measureQualityCpu(quality, sampleCount) {
    if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
      throw new RangeError('CPU sample count must be a positive integer.');
    }
    const fixture = showOnly('jupiter');
    if (fixture === null) throw new Error('Jupiter quality fixture is missing.');
    configureBodyCamera();
    fixture.animation.setEnabled(true);
    fixture.animation.setQuality(quality);
    fixture.animation.update(3_900);
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve()));
    for (let frame = 0; frame < 60; frame += 1) {
      await nextFrame();
      renderer.render(scene, camera);
    }
    const samples: number[] = [];
    while (samples.length < sampleCount) {
      await nextFrame();
      const startMs = performance.now();
      renderer.render(scene, camera);
      const elapsedMs = performance.now() - startMs;
      if (Number.isFinite(elapsedMs) && elapsedMs > 0) samples.push(elapsedMs);
    }
    return samples;
  },
  async measureQualityGpu(quality, sampleCount) {
    if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
      throw new RangeError('GPU sample count must be a positive integer.');
    }
    const fixture = showOnly('jupiter');
    if (fixture === null) throw new Error('Jupiter quality fixture is missing.');
    configureBodyCamera();
    fixture.animation.setEnabled(true);
    fixture.animation.setQuality(quality);
    fixture.animation.update(3_900);
    const context = renderer.getContext();
    if (!(context instanceof WebGL2RenderingContext)) {
      throw new Error('Gas-giant GPU benchmark requires WebGL2.');
    }
    const extension = context.getExtension('EXT_disjoint_timer_query_webgl2');
    if (extension === null) throw new Error('EXT_disjoint_timer_query_webgl2 is unavailable.');
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve()));
    for (let frame = 0; frame < 60; frame += 1) {
      await nextFrame();
      renderer.render(scene, camera);
    }
    const samples: number[] = [];
    while (samples.length < sampleCount) {
      const query = context.createQuery();
      if (query === null) throw new Error('Unable to allocate a GPU timer query.');
      context.beginQuery(extension.TIME_ELAPSED_EXT, query);
      renderer.render(scene, camera);
      context.endQuery(extension.TIME_ELAPSED_EXT);
      while (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) {
        await nextFrame();
      }
      const disjoint = context.getParameter(extension.GPU_DISJOINT_EXT) as boolean;
      const elapsedNanoseconds = context.getQueryParameter(query, context.QUERY_RESULT) as number;
      context.deleteQuery(query);
      if (!disjoint) {
        const elapsedMilliseconds = elapsedNanoseconds / 1_000_000;
        if (Number.isFinite(elapsedMilliseconds) && elapsedMilliseconds > 0) {
          samples.push(elapsedMilliseconds);
        }
      }
      await nextFrame();
    }
    return samples;
  },
  renderBody(bodyId, simTimeSec, quality, enabled) {
    const fixture = showOnly(bodyId);
    if (fixture === null) throw new Error(`Unknown gas-giant fixture ${bodyId}.`);
    configureBodyCamera();
    fixture.animation.setQuality(quality);
    fixture.animation.setEnabled(enabled);
    fixture.animation.update(simTimeSec);
    return renderSnapshot(bodyId, fixture.seed, fixture.animation, fixture.detail);
  },
  renderSpot(simTimeSec, enabled) {
    showOnly(null);
    configureSpotCamera();
    spotAnimation.setQuality('full');
    spotAnimation.setEnabled(enabled);
    spotAnimation.update(simTimeSec);
    spotAnimation.state.uniforms.uGasBandPhases.value.set(0, 0, 0, 0);
    spotAnimation.state.uniforms.uGasStormPhase.value.z = 1;
    spotAnimation.state.uniforms.uGasStormPhase.value.w = 0;
    spotAnimation.state.uniforms.uGasWarp.value.x = 0;
    spotAnimation.state.uniforms.uGasWarp.value.y = 0;
    spotAnimation.state.uniforms.uGasWarp.value.z = 0;
    return renderSnapshot('jupiter-spot', jupiter.seed, spotAnimation);
  },
  setupSnapshot() {
    return {
      glError: setupGlError,
      loadedBodyIds: BODY_IDS,
      programs: {
        afterFirstPass: programsAfterFirstPass,
        afterWarmUp: programsAfterWarmUp,
        beforeWarmUp: programsBeforeWarmUp,
      },
    };
  },
};
