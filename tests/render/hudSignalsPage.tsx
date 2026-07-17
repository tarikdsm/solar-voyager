import { options, render, type VNode } from 'preact';

import '../../src/style.css';
import type { WarpFactor } from '../../src/core/time.js';
import { createSimulationSnapshotBuffer, type Commands } from '../../src/sim/simulationSnapshot.js';
import {
  App,
  DualClock,
  EnergyPanel,
  OrbitReadout,
  TargetPanel,
  WarpControl,
} from '../../src/ui/App.js';
import { createHudSignalStore } from '../../src/ui/hudSignals.js';

interface RenderCounts {
  app: number;
  dualClock: number;
  energyPanel: number;
  orbitReadout: number;
  targetPanel: number;
  warpControl: number;
}

interface HudSignalsHarness {
  commitCommands(): Promise<HudSignalsHarnessSnapshot>;
  snapshot(): HudSignalsHarnessSnapshot;
  updateClock(): Promise<HudSignalsHarnessSnapshot>;
}

interface HudSignalsHarnessSnapshot {
  readonly commandedTarget: string | null;
  readonly commandedWarp: WarpFactor;
  readonly coordinateClock: string;
  readonly counts: RenderCounts;
}

declare global {
  interface Window {
    __hudSignalsHarness: HudSignalsHarness;
  }
}

const root = document.querySelector('#hud-root');
if (!(root instanceof HTMLElement)) throw new Error('HUD regression root is missing');

const snapshot = createSimulationSnapshotBuffer(Object.freeze(['earth', 'mars']));
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
const counts: RenderCounts = {
  app: 0,
  dualClock: 0,
  energyPanel: 0,
  orbitReadout: 0,
  targetPanel: 0,
  warpControl: 0,
};
let commandedTarget: string | null = null;
let commandedWarp: WarpFactor = 1;
const commands: Commands = {
  rotate: () => undefined,
  setAttitudeMode: () => undefined,
  setTarget: (bodyId) => {
    commandedTarget = bodyId;
  },
  setThrottle: () => undefined,
  setWarp: (warp) => {
    commandedWarp = warp;
  },
};
const previousDiffed = options.diffed;
options.diffed = (vnode: VNode): void => {
  previousDiffed?.(vnode);
  if (vnode.type === App) counts.app += 1;
  if (vnode.type === DualClock) counts.dualClock += 1;
  if (vnode.type === EnergyPanel) counts.energyPanel += 1;
  if (vnode.type === OrbitReadout) counts.orbitReadout += 1;
  if (vnode.type === TargetPanel) counts.targetPanel += 1;
  if (vnode.type === WarpControl) counts.warpControl += 1;
};

render(
  <App
    bodyIds={snapshot.bodyIds}
    commands={commands}
    hud={store.display}
    hudState={store.signals}
  />,
  root,
);

function copyCounts(): RenderCounts {
  return {
    app: counts.app,
    dualClock: counts.dualClock,
    energyPanel: counts.energyPanel,
    orbitReadout: counts.orbitReadout,
    targetPanel: counts.targetPanel,
    warpControl: counts.warpControl,
  };
}

function readHarnessSnapshot() {
  return {
    commandedTarget,
    commandedWarp,
    counts: copyCounts(),
    coordinateClock: document.querySelector('#coordinate-clock')?.textContent ?? '',
  };
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    requestAnimationFrame(() => resolvePromise());
  });
}

window.__hudSignalsHarness = {
  commitCommands: async () => {
    snapshot.requestedWarp = commandedWarp;
    snapshot.effectiveWarp = commandedWarp;
    snapshot.targetBodyId = commandedTarget;
    snapshot.targetBodyIndex =
      commandedTarget === null ? -1 : snapshot.bodyIds.indexOf(commandedTarget);
    store.publish(snapshot, 200);
    await nextFrame();
    return readHarnessSnapshot();
  },
  snapshot: readHarnessSnapshot,
  updateClock: async () => {
    snapshot.utcTimeMs += 1_000;
    store.publish(snapshot, 100);
    await nextFrame();
    return readHarnessSnapshot();
  },
};
