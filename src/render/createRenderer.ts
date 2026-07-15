import * as THREE from 'three';

/** Creates the high-performance WebGL renderer used by the game. */
export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
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
