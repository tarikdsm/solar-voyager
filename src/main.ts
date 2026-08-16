import { startApplication } from './bootstrap/composition.js';
import type { StartupLoadingElements } from './ui/startupLoadingView.js';
import './style.css';

/**
 * Entry point: resolve the document contract, then hand it to the composition
 * root.
 *
 * Everything else lives in `src/bootstrap/` — `composition.ts` (startup order,
 * ports, listeners, space-phase activation), `frameLoop.ts` and
 * `diagnostics.ts`. They sit outside `src/game|render|ui` on purpose: the
 * composition root is the one module that must import from every layer, which
 * `import/no-restricted-paths` forbids anywhere inside them
 * (`docs/architecture.md`, and this task's design doc section 2).
 *
 * The top-level `await` is load-bearing: the burn-log runtime chunk and the
 * WebGL context are both resolved during startup, and the entry module's
 * evaluation is not finished until they are.
 */

const canvasElement = document.querySelector('#space-canvas');
const appElement = document.querySelector('#app');
const startupLoadingElement = document.querySelector('#startup-loading');
const startupMessageElement = document.querySelector('#startup-message');
const startupProgressElement = document.querySelector('#startup-progress');
const startupRetryElement = document.querySelector('#startup-retry');

if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('Solar Voyager canvas was not found.');
}

if (!(appElement instanceof HTMLElement)) {
  throw new Error('Solar Voyager application root was not found.');
}
if (
  !(startupLoadingElement instanceof HTMLElement) ||
  !(startupMessageElement instanceof HTMLElement) ||
  !(startupProgressElement instanceof HTMLProgressElement) ||
  !(startupRetryElement instanceof HTMLButtonElement)
) {
  throw new Error('Solar Voyager startup loading shell was not found.');
}

const canvas = canvasElement;
const appRoot = appElement;
const startupLoadingElements: StartupLoadingElements = {
  message: startupMessageElement,
  progress: startupProgressElement,
  retry: startupRetryElement,
  root: startupLoadingElement,
};

await startApplication({ appRoot, canvas, startupLoadingElements });
