import { PerspectiveCamera, WebGLRenderer } from 'three';

import { StateVectorWidget } from '../../src/render/stateVectorWidget.js';
import { createSimulationSnapshotBuffer } from '../../src/sim/simulationSnapshot.js';

interface StateVectorWidgetHarness {
  measure(iterations: number): readonly number[];
  snapshot(): {
    readonly renderer: string;
    readonly softwareRasterizer: boolean;
    readonly velocityKmS: number;
    readonly visibleMask: number;
  };
}

declare global {
  interface Window {
    __stateVectorWidgetHarness?: StateVectorWidgetHarness;
  }
}

const canvas = document.querySelector('#fixture-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('fixture canvas is missing');

const renderer = new WebGLRenderer({ antialias: false, canvas });
renderer.setPixelRatio(1);
renderer.setSize(512, 512, false);
renderer.setClearColor(0xd8dee8, 1);
const camera = new PerspectiveCamera();
const snapshot = createSimulationSnapshotBuffer(['sun', 'earth']);
snapshot.shipCmRelativeVelocityKmS.set([30, 0, 0]);
snapshot.shipProperAccelerationKmS2.set([0, 0.009_806_65, 0]);
snapshot.shipRelativisticMomentumKgKmS.set([300_000, 0, 0]);
snapshot.shipAngularMomentumKgKm2S.set([0, 0, 5e16]);
snapshot.gamma = 1.000_000_005;
snapshot.speedFractionOfLight = 30 / 299_792.458;

const widget = new StateVectorWidget();
widget.setViewportPixels(128, 128, 256, 256);
widget.setPinnedToEcliptic(true);
widget.update(snapshot, camera);
await widget.prepare(renderer);
renderer.clear();
widget.render(renderer);

const context = renderer.getContext();
const rendererInfo = context.getExtension('WEBGL_debug_renderer_info');
const rendererName =
  rendererInfo === null
    ? 'masked WebGL renderer'
    : String(context.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL));
const softwareRasterizer = /SwiftShader|llvmpipe|Software|Basic Render/iu.test(rendererName);

window.__stateVectorWidgetHarness = {
  measure(iterations: number): readonly number[] {
    if (!Number.isInteger(iterations) || iterations <= 0 || iterations > 1_000) {
      throw new RangeError('measurement iterations must be between 1 and 1000');
    }
    const samples = new Float64Array(iterations);
    for (let index = 0; index < iterations; index += 1) {
      widget.render(renderer);
      samples[index] = widget.lastRenderMs;
    }
    return Array.from(samples);
  },
  snapshot() {
    return {
      renderer: rendererName,
      softwareRasterizer,
      velocityKmS: snapshot.shipCmRelativeVelocityKmS[0] as number,
      visibleMask: widget.visibleMask,
    };
  },
};
