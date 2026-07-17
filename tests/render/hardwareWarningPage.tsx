import { render } from 'preact';

import {
  createContextAttributes,
  createRendererContextReport,
  createWebGL2Context,
} from '../../src/render/createRenderer.js';
import { App } from '../../src/ui/App.js';
import { createHudSignalStore } from '../../src/ui/hudSignals.js';

const root = document.querySelector('#warning-root');
if (!(root instanceof HTMLElement)) throw new Error('Hardware warning root is missing.');

const unmaskedRendererParameter = 9_999;
const hardwareContext = {
  RENDERER: 7_937,
  getContextAttributes: () => createContextAttributes(true),
  getExtension(name: string) {
    if (name === 'WEBGL_debug_renderer_info') {
      return { UNMASKED_RENDERER_WEBGL: unmaskedRendererParameter };
    }
    if (name === 'EXT_disjoint_timer_query_webgl2') return {};
    return null;
  },
  getParameter(parameter: number) {
    if (parameter === unmaskedRendererParameter) return 'ANGLE (Intel Iris Xe Graphics)';
    if (parameter === 7_937) return 'WebGL hardware renderer';
    return null;
  },
} as unknown as WebGL2RenderingContext;
let contextAttempts = 0;
const strictHardwareCanvas = {
  getContext(name: string, attributes?: WebGLContextAttributes) {
    if (name !== 'webgl2') return null;
    contextAttempts += 1;
    return attributes?.failIfMajorPerformanceCaveat === true ? hardwareContext : null;
  },
} as unknown as HTMLCanvasElement;
const contextResult = createWebGL2Context(strictHardwareCanvas);
const contextReport = createRendererContextReport(
  contextResult.context,
  'reversed',
  contextResult.usedPerformanceCaveatFallback,
);
const hardwareWarning = contextReport.warningRequired
  ? { rendererName: contextReport.rendererName }
  : null;

root.dataset.contextAttempts = String(contextAttempts);
root.dataset.gpuTimerQueryAvailable = String(contextReport.gpuTimerQueryAvailable);
root.dataset.policyReady = 'true';
root.dataset.rendererName = contextReport.rendererName;
root.dataset.usedPerformanceCaveatFallback = String(contextReport.usedPerformanceCaveatFallback);
root.dataset.warningRequired = String(contextReport.warningRequired);
render(<App hardwareWarning={hardwareWarning} hud={createHudSignalStore().display} />, root);
