import { h, render } from 'preact';

import { createScaffoldState } from './game/createScaffoldState';
import { createPlaceholderScene } from './render/createPlaceholderScene';
import { createRenderer } from './render/createRenderer';
import { App } from './ui/App';
import './style.css';

const ROTATION_PER_FRAME_RAD = 0.01;

const mountElement = document.querySelector<HTMLDivElement>('#app');

if (mountElement === null) {
  throw new Error(
    'Solar Voyager startup failed: mount element #app was not found.',
  );
}

const canvas = document.createElement('canvas');
const uiRoot = document.createElement('div');

canvas.className = 'space-canvas';
uiRoot.className = 'ui-root';
mountElement.append(canvas, uiRoot);

const renderer = createRenderer(canvas);
const { scene, camera, cube } = createPlaceholderScene();
const scaffoldState = createScaffoldState();

render(h(App, { state: scaffoldState }), uiRoot);

function resizeRendererToDisplaySize(): void {
  const pixelRatio = renderer.getPixelRatio();
  const width = Math.floor(canvas.clientWidth * pixelRatio);
  const height = Math.floor(canvas.clientHeight * pixelRatio);

  if (canvas.width === width && canvas.height === height) {
    return;
  }

  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
}

function frame(): void {
  resizeRendererToDisplaySize();
  cube.rotation.x += ROTATION_PER_FRAME_RAD;
  cube.rotation.y += ROTATION_PER_FRAME_RAD;
  cube.updateMatrix();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
