import { options, render, type VNode } from 'preact';

import { createSimulationSnapshotBuffer } from '../../src/sim/simulationSnapshot.js';
import { App, DualClock, OrbitReadout } from '../../src/ui/App.js';
import { createHudSignalStore } from '../../src/ui/hudSignals.js';

interface RenderCounts {
  app: number;
  dualClock: number;
  orbitReadout: number;
}

interface HudSignalsHarness {
  snapshot(): { readonly counts: RenderCounts; readonly coordinateClock: string };
  updateClock(): Promise<{ readonly counts: RenderCounts; readonly coordinateClock: string }>;
}

declare global {
  interface Window {
    __hudSignalsHarness: HudSignalsHarness;
  }
}

const root = document.querySelector('#hud-root');
if (!(root instanceof HTMLElement)) throw new Error('HUD regression root is missing');

const snapshot = createSimulationSnapshotBuffer(Object.freeze(['earth']));
snapshot.dominantBodyIndex = 0;
snapshot.osculatingElements.valid = true;
snapshot.osculatingElements.apoapsisRadiusKm = 6_778.137;
snapshot.osculatingElements.periapsisRadiusKm = 6_778.137;
snapshot.osculatingElements.eccentricity = 0;
snapshot.osculatingElements.inclinationRad = 0;
snapshot.osculatingElements.periodSec = 5_553.6;
snapshot.utcTimeMs = Date.UTC(2026, 0, 1);
snapshot.shipProperTimeSec = 0;

const store = createHudSignalStore();
store.publish(snapshot, 0);
const counts: RenderCounts = { app: 0, dualClock: 0, orbitReadout: 0 };
const previousDiffed = options.diffed;
options.diffed = (vnode: VNode): void => {
  previousDiffed?.(vnode);
  if (vnode.type === App) counts.app += 1;
  if (vnode.type === DualClock) counts.dualClock += 1;
  if (vnode.type === OrbitReadout) counts.orbitReadout += 1;
};

render(<App hud={store.display} />, root);

function copyCounts(): RenderCounts {
  return { app: counts.app, dualClock: counts.dualClock, orbitReadout: counts.orbitReadout };
}

function readHarnessSnapshot() {
  return {
    counts: copyCounts(),
    coordinateClock: document.querySelector('#coordinate-clock')?.textContent ?? '',
  };
}

window.__hudSignalsHarness = {
  snapshot: readHarnessSnapshot,
  updateClock: async () => {
    snapshot.utcTimeMs += 1_000;
    store.publish(snapshot, 100);
    await new Promise<void>((resolvePromise) => {
      requestAnimationFrame(() => resolvePromise());
    });
    return readHarnessSnapshot();
  },
};
