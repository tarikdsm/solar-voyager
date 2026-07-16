import { render } from 'preact';

import { createEpochWorld, type EpochWorld } from './render/createEpochWorld.js';
import { createRenderer } from './render/createRenderer.js';
import { calculateDrawingBufferDimension } from './render/drawingBufferSize.js';
import { LightingPostPipeline } from './render/lightingPostPipeline.js';
import './style.css';
import { App } from './ui/App.js';

const canvasElement = document.querySelector('#space-canvas');
const appElement = document.querySelector('#app');

if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('Solar Voyager canvas was not found.');
}

if (!(appElement instanceof HTMLElement)) {
  throw new Error('Solar Voyager application root was not found.');
}

const canvas = canvasElement;
const appRoot = appElement;
const renderer = createRenderer(canvas);
const resizeListenerOptions: AddEventListenerOptions = { passive: true };
let world: EpochWorld | null = null;
let postPipeline: LightingPostPipeline | null = null;

function resizeRenderer(): void {
  const clientWidth = canvas.clientWidth;
  const clientHeight = canvas.clientHeight;
  const pixelRatio = renderer.getPixelRatio();
  const drawingBufferWidth = calculateDrawingBufferDimension(clientWidth, pixelRatio);
  const drawingBufferHeight = calculateDrawingBufferDimension(clientHeight, pixelRatio);

  if (canvas.width !== drawingBufferWidth || canvas.height !== drawingBufferHeight) {
    renderer.setSize(clientWidth, clientHeight, false);
    if (world === null) return;
    world.spaceScene.camera.aspect = clientWidth / clientHeight;
    world.spaceScene.camera.updateProjectionMatrix();
    postPipeline?.resize(clientWidth, clientHeight, pixelRatio);
  }
}

function renderFrame(nowMs: number): void {
  if (world === null || postPipeline === null) return;
  const { spaceScene, visualSystem, lighting, cameraPositionKm } = world;
  visualSystem.update(
    cameraPositionKm,
    canvas.height,
    spaceScene.camera.fov * (Math.PI / 180),
    nowMs,
  );
  lighting.update();
  spaceScene.updateCameraRelative(cameraPositionKm);
  postPipeline.render();
  requestAnimationFrame(renderFrame);
}

async function startApplication(): Promise<void> {
  render(App(), appRoot);
  resizeRenderer();
  world = await createEpochWorld(renderer, { initialViewportHeightPx: canvas.height });
  postPipeline = new LightingPostPipeline(
    renderer,
    world.spaceScene.scene,
    world.spaceScene.camera,
  );
  postPipeline.resize(canvas.clientWidth, canvas.clientHeight, renderer.getPixelRatio());
  world.lighting.update();
  world.spaceScene.updateCameraRelative(world.cameraPositionKm);
  postPipeline.warmUp();
  window.addEventListener('resize', resizeRenderer, resizeListenerOptions);
  requestAnimationFrame(renderFrame);
}

void startApplication().catch((cause: unknown) => {
  throw new Error('Solar Voyager failed to initialize the epoch world.', { cause });
});
