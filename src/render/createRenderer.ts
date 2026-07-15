import { WebGLRenderer } from 'three';

/** Creates the initial high-performance renderer for the supplied canvas. */
export function createRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const renderer = new WebGLRenderer({
    canvas,
    powerPreference: 'high-performance',
    antialias: false,
    stencil: false,
    alpha: false,
    preserveDrawingBuffer: false,
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  return renderer;
}
