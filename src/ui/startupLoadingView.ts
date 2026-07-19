import type { StartupTracker } from '../game/startupTracker.js';

export interface StartupLoadingElements {
  readonly message: HTMLElement;
  readonly progress: HTMLProgressElement;
  readonly retry: HTMLButtonElement;
  readonly root: HTMLElement;
}

function loadingMessage(stage: StartupTracker['stage']): string {
  switch (stage) {
    case 'boot':
      return 'Starting renderer';
    case 'context':
      return 'Loading star catalog';
    case 'star-catalog':
      return 'Loading asset manifest';
    case 'asset-manifest':
      return 'Loading critical textures';
    case 'hero-spheres':
      return 'Compiling flight shaders';
    case 'flight-shaders':
      return 'Compiling system map';
    case 'map-shaders':
      return 'Measuring graphics performance';
    case 'quality':
      return 'Preparing flight displays';
    case 'post-ready':
    case 'ready':
      return 'Ready';
    case 'failed':
      return 'Startup failed';
  }
}

/** Mirrors setup evidence into the static loading shell. */
export function updateStartupLoadingView(
  elements: StartupLoadingElements,
  tracker: StartupTracker,
): void {
  const failed = tracker.stage === 'failed';
  const ready = tracker.stage === 'ready';
  elements.root.dataset.startupStage = tracker.stage;
  elements.root.setAttribute('aria-busy', String(!failed && !ready));
  elements.root.setAttribute('role', failed ? 'alert' : 'status');
  elements.progress.value = tracker.progress;
  elements.retry.hidden = !failed;
  elements.root.hidden = ready;
  elements.message.textContent = failed
    ? `Startup failed during ${tracker.failedStage ?? 'boot'}: ${tracker.errorMessage ?? 'Unknown error.'}`
    : loadingMessage(tracker.stage);
}
