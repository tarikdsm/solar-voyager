import { WebGLRenderer, type WebGLRendererParameters } from 'three';

/** Returns the immutable-at-runtime WebGL context policy for Solar Voyager. */
export function createRendererParameters(canvas: HTMLCanvasElement): WebGLRendererParameters {
  return {
    canvas,
    powerPreference: 'high-performance',
    antialias: false,
    stencil: false,
    alpha: false,
    preserveDrawingBuffer: false,
    logarithmicDepthBuffer: true,
  };
}

/** Creates the initial high-performance renderer for the supplied canvas. */
export function createRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const renderer = new WebGLRenderer(createRendererParameters(canvas));

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  return renderer;
}
