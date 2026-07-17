import { WebGLRenderer } from 'three';

import bodiesDocument from '../../data/bodies.json';
import { createEpochWorld } from '../../src/render/createEpochWorld.js';
import { LightingPostPipeline } from '../../src/render/lightingPostPipeline.js';
import {
  QUALITY_PROFILES,
  PerfGovernor,
  createPerfQualityState,
  type RenderQualityProfile,
} from '../../src/render/perfGovernor.js';
import { RenderQualityController } from '../../src/render/renderQualityController.js';

const VIEWPORT_WIDTH = 640;
const VIEWPORT_HEIGHT = 360;

interface RungSnapshot {
  readonly antiAliasing: string;
  readonly bloom: string;
  readonly bloomHeight: number;
  readonly bloomWidth: number;
  readonly canvasHeight: number;
  readonly canvasWidth: number;
  readonly earthTier: number;
  readonly fxaaEnabled: boolean;
  readonly modelThresholdScale: number;
  readonly proceduralOctaves: number;
  readonly programCount: number;
  readonly renderScale: number;
  readonly rung: number;
  readonly smaaEnabled: boolean;
  readonly starCount: number;
  readonly textureCap: string;
  readonly tier: number;
}

interface PerfGovernorHarness {
  applyRung(rung: number): RungSnapshot;
  lockScenario(): { readonly actionCount: number; readonly rung: number };
  readonly programCountAfterWarmUp: number;
  syntheticLoad(): {
    readonly actionCount: number;
    readonly p75FrameMs: number;
    readonly rung: number;
  };
}

declare global {
  var __perfGovernorHarness: PerfGovernorHarness | undefined;
}

const canvasNode = document.querySelector('#quality-canvas');
const titleNode = document.querySelector('#quality-title');
const valuesNode = document.querySelector('#quality-values');
const actionNode = document.querySelector('#quality-action');
if (!(canvasNode instanceof HTMLCanvasElement)) throw new Error('Quality canvas is missing.');
if (!(titleNode instanceof HTMLElement)) throw new Error('Quality title is missing.');
if (!(valuesNode instanceof HTMLElement)) throw new Error('Quality values are missing.');
if (!(actionNode instanceof HTMLElement)) throw new Error('Quality action is missing.');
const canvas: HTMLCanvasElement = canvasNode;
const title: HTMLElement = titleNode;
const values: HTMLElement = valuesNode;
const action: HTMLElement = actionNode;

const renderer = new WebGLRenderer({
  canvas,
  alpha: false,
  antialias: false,
  logarithmicDepthBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, false);
renderer.setClearColor(0x020617, 1);
const world = await createEpochWorld(renderer, { initialViewportHeightPx: VIEWPORT_HEIGHT });
const pipeline = new LightingPostPipeline(
  renderer,
  world.spaceScene.scene,
  world.spaceScene.camera,
);

function resize(): void {
  const pixelRatio = renderer.getPixelRatio();
  renderer.setSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, false);
  pipeline.resize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, pixelRatio);
}

const controller = new RenderQualityController({
  assetLoader: world.visualSystem,
  pipeline,
  postProcessingAvailable: true,
  proceduralSun: world.proceduralSun,
  renderer,
  resize,
  starfield: world.starfield,
  visualSystem: world.visualSystem,
});

const earthIndex = bodiesDocument.bodies.findIndex((body) => body.id === 'earth');
const earth = bodiesDocument.bodies[earthIndex];
if (earthIndex < 0 || earth === undefined) throw new Error('Earth fixture definition is missing.');
const earthOffset = earthIndex * 3;
const earthX = world.positionsKm[earthOffset] ?? Number.NaN;
const earthY = world.positionsKm[earthOffset + 1] ?? Number.NaN;
const earthZ = world.positionsKm[earthOffset + 2] ?? Number.NaN;
const earthDistance = Math.sqrt(earthX * earthX + earthY * earthY + earthZ * earthZ);
const cameraDistance = earth.meanRadiusKm * 2.5;
const cameraPosition = {
  x: earthX + (earthX / earthDistance) * cameraDistance,
  y: earthY + (earthY / earthDistance) * cameraDistance,
  z: earthZ + (earthZ / earthDistance) * cameraDistance,
};
world.spaceScene.camera.lookAt(-earthX, -earthY, -earthZ);
world.spaceScene.camera.updateMatrix();

let visualTimeMs = 1_000;
function updateWorld(): void {
  world.visualSystem.update(
    cameraPosition,
    VIEWPORT_HEIGHT,
    world.spaceScene.camera.fov * (Math.PI / 180),
    visualTimeMs,
  );
  visualTimeMs += 300;
  world.visualSystem.update(
    cameraPosition,
    VIEWPORT_HEIGHT,
    world.spaceScene.camera.fov * (Math.PI / 180),
    visualTimeMs,
  );
  world.lighting.update();
  world.proceduralSun.update(visualTimeMs / 1_000);
  world.spaceScene.updateCameraRelative(cameraPosition);
}

updateWorld();
pipeline.warmUp(true);
for (
  let attempt = 0;
  attempt < 100 && world.visualSystem.getLoadState('earth') !== 'ready';
  attempt += 1
) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
updateWorld();
resize();
pipeline.warmUp(true);
const programCountAfterWarmUp = renderer.info.programs?.length ?? 0;

function row(label: string, value: string): string {
  return `<dt>${label}</dt><dd>${value}</dd>`;
}

function renderProfileLabel(profile: RenderQualityProfile): void {
  title.textContent = `R${String(profile.rung).padStart(2, '0')} · Q${String(profile.tier)}/6`;
  values.innerHTML =
    row('Scale', profile.renderScale.toFixed(2)) +
    row('Bloom', profile.bloom) +
    row('AA', profile.antiAliasing) +
    row('Octaves', profile.proceduralQuality) +
    row('Stars', profile.starCountCap.toLocaleString('en-US')) +
    row('Textures', profile.textureCap) +
    row('Model ×', profile.modelThresholdScale.toFixed(1));
  action.textContent = profile.downAction;
}

function profileSnapshot(profile: RenderQualityProfile): RungSnapshot {
  const bloom = pipeline.bloomPass as unknown as {
    readonly renderTargetBright: { readonly height: number; readonly width: number };
  };
  const sunMaterial = world.proceduralSun.billboard.material;
  const uniforms = (
    sunMaterial as typeof sunMaterial & {
      readonly uniforms?: Record<string, { readonly value: number }>;
    }
  ).uniforms;
  return {
    antiAliasing: profile.antiAliasing,
    bloom: profile.bloom,
    bloomHeight: bloom.renderTargetBright.height,
    bloomWidth: bloom.renderTargetBright.width,
    canvasHeight: canvas.height,
    canvasWidth: canvas.width,
    earthTier: world.visualSystem.getTier('earth'),
    fxaaEnabled: pipeline.fxaaPass.enabled,
    modelThresholdScale: profile.modelThresholdScale,
    proceduralOctaves: uniforms?.uSunOctaves?.value ?? -1,
    programCount: renderer.info.programs?.length ?? 0,
    renderScale: profile.renderScale,
    rung: profile.rung,
    smaaEnabled: pipeline.smaaPass.enabled,
    starCount: world.starfield.points.geometry.drawRange.count,
    textureCap: profile.textureCap,
    tier: profile.tier,
  };
}

globalThis.__perfGovernorHarness = {
  applyRung(rung) {
    const profile = QUALITY_PROFILES[rung];
    if (profile === undefined) throw new RangeError('Fixture quality rung is out of range.');
    controller.apply(profile);
    updateWorld();
    renderer.info.reset();
    pipeline.render(true);
    renderProfileLabel(profile);
    return profileSnapshot(profile);
  },
  lockScenario() {
    const state = createPerfQualityState();
    let actionCount = 0;
    const governor = new PerfGovernor({
      application: { apply() {} },
      state,
      telemetry: { recordQualityAction: () => (actionCount += 1) },
    });
    governor.setLock('low', 0);
    for (let sample = 1; sample <= 20; sample += 1) {
      governor.update(sample * 1_000, { frameCount: sample, p75FrameMs: 5 });
    }
    return { actionCount, rung: state.rung };
  },
  programCountAfterWarmUp,
  syntheticLoad() {
    const state = createPerfQualityState();
    let actionCount = 0;
    const governor = new PerfGovernor({
      application: { apply() {} },
      state,
      telemetry: { recordQualityAction: () => (actionCount += 1) },
    });
    let nowMs = 0;
    for (let sample = 1; sample <= 40; sample += 1) {
      const p75FrameMs = state.rung === 0 ? 20 : state.rung === 1 ? 17 : 14;
      governor.update(nowMs, { frameCount: sample * 15, p75FrameMs });
      nowMs += 250;
    }
    const p75FrameMs = state.rung === 0 ? 20 : state.rung === 1 ? 17 : 14;
    return { actionCount, p75FrameMs, rung: state.rung };
  },
};

globalThis.__perfGovernorHarness.applyRung(0);
