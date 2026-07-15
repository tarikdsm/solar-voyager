import { render } from 'preact';

import { createPlaceholderScene } from './render/createPlaceholderScene.js';
import { createRenderer } from './render/createRenderer.js';
import { calculateDrawingBufferDimension } from './render/drawingBufferSize.js';
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
const { scene, camera, cube } = createPlaceholderScene();
const resizeListenerOptions: AddEventListenerOptions = { passive: true };

function resizeRenderer(): void {
  const clientWidth = canvas.clientWidth;
  const clientHeight = canvas.clientHeight;
  const pixelRatio = renderer.getPixelRatio();
  const drawingBufferWidth = calculateDrawingBufferDimension(clientWidth, pixelRatio);
  const drawingBufferHeight = calculateDrawingBufferDimension(clientHeight, pixelRatio);

  if (canvas.width !== drawingBufferWidth || canvas.height !== drawingBufferHeight) {
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  }
}

function renderFrame(): void {
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.01;
  cube.updateMatrix();
  renderer.render(scene, camera);
  requestAnimationFrame(renderFrame);
}

function handleCompileSuccess(): void {
  requestAnimationFrame(renderFrame);
}

function handleCompileFailure(cause: unknown): never {
  throw new Error('Solar Voyager failed to compile startup shaders.', { cause });
}

function startApplication(): void {
  render(App(), appRoot);
  resizeRenderer();
  window.addEventListener('resize', resizeRenderer, resizeListenerOptions);
  void renderer.compileAsync(scene, camera).then(handleCompileSuccess, handleCompileFailure);
}

startApplication();
