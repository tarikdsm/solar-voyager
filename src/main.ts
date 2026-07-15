import { advanceBaselineAngle } from './baselineState.js';
import './style.css';

const canvasElement = document.querySelector('#space-canvas');
const appElement = document.querySelector('#app');

if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('Solar Voyager canvas was not found.');
}

if (!(appElement instanceof HTMLElement)) {
  throw new Error('Solar Voyager application root was not found.');
}

const context = canvasElement.getContext('2d');

if (context === null) {
  throw new Error('Solar Voyager requires a 2D canvas context.');
}

const canvas = canvasElement;
const drawingContext = context;
const heading = document.createElement('h1');
heading.textContent = 'Solar Voyager';
appElement.replaceChildren(heading);

let canvasCssWidth = 0;
let canvasCssHeight = 0;
let canvasPixelRatio = 1;
let previousFrameTimeMs = 0;
let squareAngleRad = 0;

function resizeCanvas(): void {
  canvasCssWidth = window.innerWidth;
  canvasCssHeight = window.innerHeight;
  canvasPixelRatio = Math.min(window.devicePixelRatio, 2);

  const backingWidth = Math.round(canvasCssWidth * canvasPixelRatio);
  const backingHeight = Math.round(canvasCssHeight * canvasPixelRatio);

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
}

function drawFrame(frameTimeMs: number): void {
  const elapsedMs = previousFrameTimeMs === 0 ? 0 : frameTimeMs - previousFrameTimeMs;
  previousFrameTimeMs = frameTimeMs;
  squareAngleRad = advanceBaselineAngle(squareAngleRad, elapsedMs);

  drawingContext.setTransform(1, 0, 0, 1, 0, 0);
  drawingContext.clearRect(0, 0, canvas.width, canvas.height);
  drawingContext.setTransform(
    canvasPixelRatio,
    0,
    0,
    canvasPixelRatio,
    canvasCssWidth * 0.5,
    canvasCssHeight * 0.5,
  );
  drawingContext.rotate(squareAngleRad);
  drawingContext.fillRect(-40, -40, 80, 80);

  requestAnimationFrame(drawFrame);
}

drawingContext.fillStyle = '#38bdf8';
resizeCanvas();
window.addEventListener('resize', resizeCanvas, { passive: true });
requestAnimationFrame(drawFrame);
