import { options, render, type VNode } from 'preact';
import type { WebGLRenderer } from 'three';

import '../../src/style.css';
import type { RendererContextReport } from '../../src/render/createRenderer.js';
import { RenderTelemetry } from '../../src/render/telemetry.js';
import { PerfPanel } from '../../src/ui/hud/PerfPanel.js';
import { createPerfPanelStore } from '../../src/ui/hud/perfPanelStore.js';

interface PerfPanelHarnessSnapshot {
  readonly measuredCostMsPerFrame: number;
  readonly renderCount: number;
  readonly sampleCount: number;
}

declare global {
  interface Window {
    __perfPanelHarness: {
      snapshot(): PerfPanelHarnessSnapshot;
    };
  }
}

const root = document.querySelector('#perf-panel-root');
if (!(root instanceof HTMLElement)) throw new Error('Perf panel regression root is missing');

const context = { getExtension: () => null } as unknown as WebGL2RenderingContext;
const renderer = {
  getContext: () => context,
  info: {
    autoReset: true,
    memory: { geometries: 3, textures: 4 },
    programs: [{}, {}, {}, {}, {}],
    render: { calls: 12, frame: 0, lines: 0, points: 8_000, triangles: 34_567 },
    reset() {},
  },
} as unknown as WebGLRenderer;
const contextReport: RendererContextReport = {
  contextFlavor: 'webgl2',
  depthStrategy: 'reversed',
  effectiveContextAttributes: null,
  gpuTimerQueryAvailable: false,
  rendererName: 'ANGLE (NVIDIA RTX 5070)',
  softwareRasterizer: false,
  usedPerformanceCaveatFallback: false,
  warningRequired: false,
};
const telemetry = new RenderTelemetry(renderer, contextReport);
const quality = {
  governorState: 'Awaiting adaptive governor',
  lastAction: 'None',
  renderScale: 1,
  tier: 6,
  tierCount: 6,
};
const resolution = { height: 1_080, width: 1_920 };
const store = createPerfPanelStore({ quality, resolution, telemetry });
let renderCount = 0;
const previousDiffed = options.diffed;
options.diffed = (vnode: VNode): void => {
  previousDiffed?.(vnode);
  if (vnode.type === PerfPanel) renderCount += 1;
};

render(
  <main class="app-overlay">
    <PerfPanel display={store.display} />
    <details id="session-settings" class="session-settings">
      <summary>Session &amp; settings</summary>
    </details>
    <section id="orbit-readout" class="hud-panel orbit-readout" aria-label="Orbit placeholder" />
  </main>,
  root,
);

function frame(timestampMs: number): void {
  telemetry.beginFrame(timestampMs);
  telemetry.endFrame(1.25, 6.5, 0.15, timestampMs);
  store.publish(timestampMs);
  requestAnimationFrame(frame);
}

window.__perfPanelHarness = {
  snapshot: () => ({
    measuredCostMsPerFrame: store.measuredCostMsPerFrame,
    renderCount,
    sampleCount: telemetry.frameSampleCount,
  }),
};
requestAnimationFrame(frame);
