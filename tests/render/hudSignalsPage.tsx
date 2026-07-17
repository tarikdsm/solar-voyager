import { options, render, type VNode } from 'preact';

import '../../src/style.css';
import type { WarpFactor } from '../../src/core/time.js';
import { writeQuaternionFromForwardInto } from '../../src/sim/ship/attitude.js';
import {
  createSimulationSnapshotBuffer,
  type Commands,
  WarpClampReason,
} from '../../src/sim/simulationSnapshot.js';
import {
  App,
  DualClock,
  EnergyPanel,
  OrbitReadout,
  TargetPanel,
  WarpControl,
} from '../../src/ui/App.js';
import { createHudSignalStore } from '../../src/ui/hudSignals.js';
import { Navball } from '../../src/ui/Navball.js';

interface RenderCounts {
  app: number;
  dualClock: number;
  energyPanel: number;
  navball: number;
  orbitReadout: number;
  targetPanel: number;
  warpControl: number;
}

interface HudSignalsHarness {
  commitCommands(): Promise<HudSignalsHarnessSnapshot>;
  snapshot(): HudSignalsHarnessSnapshot;
  updateAttitude(): Promise<HudSignalsHarnessSnapshot>;
  updateClamp(): Promise<HudSignalsHarnessSnapshot>;
  updateClock(): Promise<HudSignalsHarnessSnapshot>;
  updateIntermediateHorizon(): Promise<HudSignalsHarnessSnapshot>;
  updateInvalidFrame(): Promise<HudSignalsHarnessSnapshot>;
  updateRadialIn(): Promise<HudSignalsHarnessSnapshot>;
}

interface HudSignalsHarnessSnapshot {
  readonly burnEnergy: string;
  readonly burnProperDeltaV: string;
  readonly burnSummaryLabel: string;
  readonly cameraPointerDowns: number;
  readonly cameraWheels: number;
  readonly commandedTarget: string | null;
  readonly commandedWarp: WarpFactor;
  readonly coordinateClock: string;
  readonly counts: RenderCounts;
  readonly navballMode: string;
  readonly navballGroundCapOpacity: string;
  readonly navballHemisphereTransform: string;
  readonly navballHorizonInwardOpacity: string;
  readonly navballHorizonOutwardOpacity: string;
  readonly navballProgradeTransform: string;
  readonly navballRadialOutTransform: string;
  readonly navballSkyCapOpacity: string;
  readonly navballStatus: string;
  readonly navballThrustOpacity: string;
  readonly warpClampStatus: string;
}

declare global {
  interface Window {
    __hudSignalsHarness: HudSignalsHarness;
  }
}

const root = document.querySelector('#hud-root');
if (!(root instanceof HTMLElement)) throw new Error('HUD regression root is missing');
const cameraSurface = document.querySelector('#hud-camera-surface');
if (!(cameraSurface instanceof HTMLCanvasElement)) {
  throw new Error('HUD camera regression surface is missing');
}

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
snapshot.burnSummaryAvailable = true;
snapshot.burnSummaryActive = true;
snapshot.burnEnergySpentJ = 3_600_000;
snapshot.burnProperDeltaVMS = 12.3;
snapshot.shipState.set([6_778.137, 0, 0]);
snapshot.shipCoordinateVelocityKmS.set([0, 7.668_558, 0]);
snapshot.shipProperAccelerationKmS2.set([0.009_806_65, 0, 0]);

const store = createHudSignalStore();
store.publish(snapshot, 0);
const counts: RenderCounts = {
  app: 0,
  dualClock: 0,
  energyPanel: 0,
  navball: 0,
  orbitReadout: 0,
  targetPanel: 0,
  warpControl: 0,
};
let commandedTarget: string | null = null;
let commandedWarp: WarpFactor = 1;
let cameraPointerDowns = 0;
let cameraWheels = 0;
cameraSurface.addEventListener('pointerdown', () => {
  cameraPointerDowns += 1;
});
cameraSurface.addEventListener('wheel', () => {
  cameraWheels += 1;
});
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
  if (vnode.type === Navball) counts.navball += 1;
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
    navball: counts.navball,
    orbitReadout: counts.orbitReadout,
    targetPanel: counts.targetPanel,
    warpControl: counts.warpControl,
  };
}

function readHarnessSnapshot() {
  return {
    burnEnergy: document.querySelector('#burn-energy')?.textContent ?? '',
    burnProperDeltaV: document.querySelector('#burn-delta-v')?.textContent ?? '',
    burnSummaryLabel: document.querySelector('#burn-summary-title')?.textContent ?? '',
    cameraPointerDowns,
    cameraWheels,
    commandedTarget,
    commandedWarp,
    counts: copyCounts(),
    coordinateClock: document.querySelector('#coordinate-clock')?.textContent ?? '',
    navballMode: document.querySelector('#navball-mode')?.textContent ?? '',
    navballGroundCapOpacity:
      document.querySelector('#navball-ground-cap')?.getAttribute('opacity') ?? '',
    navballHemisphereTransform:
      document.querySelector('#navball-hemisphere')?.getAttribute('transform') ?? '',
    navballHorizonInwardOpacity:
      document.querySelector('#navball-horizon-inward')?.getAttribute('opacity') ?? '',
    navballHorizonOutwardOpacity:
      document.querySelector('#navball-horizon-outward')?.getAttribute('opacity') ?? '',
    navballProgradeTransform:
      document.querySelector('#navball-prograde')?.getAttribute('transform') ?? '',
    navballRadialOutTransform:
      document.querySelector('#navball-radial-out')?.getAttribute('transform') ?? '',
    navballSkyCapOpacity: document.querySelector('#navball-sky-cap')?.getAttribute('opacity') ?? '',
    navballStatus: document.querySelector('#navball-status')?.textContent ?? '',
    navballThrustOpacity: document.querySelector('#navball-thrust')?.getAttribute('opacity') ?? '',
    warpClampStatus: document.querySelector('#warp-clamp-status')?.textContent ?? '',
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
    snapshot.warpClampReason = WarpClampReason.NONE;
    snapshot.targetBodyId = commandedTarget;
    snapshot.targetBodyIndex =
      commandedTarget === null ? -1 : snapshot.bodyIds.indexOf(commandedTarget);
    store.publish(snapshot, 300);
    await nextFrame();
    return readHarnessSnapshot();
  },
  snapshot: readHarnessSnapshot,
  updateAttitude: async () => {
    snapshot.attitudeMode = 'prograde';
    writeQuaternionFromForwardInto(snapshot.attitudeQuaternion, 0, 1, 0);
    store.publish(snapshot, 200);
    await nextFrame();
    return readHarnessSnapshot();
  },
  updateClamp: async () => {
    snapshot.requestedWarp = 1_000;
    snapshot.effectiveWarp = 100;
    snapshot.warpClampReason = WarpClampReason.INTEGRATION_BUDGET;
    store.publish(snapshot, 16);
    await nextFrame();
    return readHarnessSnapshot();
  },
  updateClock: async () => {
    snapshot.utcTimeMs += 1_000;
    store.publish(snapshot, 100);
    await nextFrame();
    return readHarnessSnapshot();
  },
  updateIntermediateHorizon: async () => {
    writeQuaternionFromForwardInto(snapshot.attitudeQuaternion, 0.5, 0, Math.sqrt(0.75));
    store.publish(snapshot, 500);
    await nextFrame();
    return readHarnessSnapshot();
  },
  updateInvalidFrame: async () => {
    snapshot.dominantBodyIndex = -1;
    store.publish(snapshot, 600);
    await nextFrame();
    return readHarnessSnapshot();
  },
  updateRadialIn: async () => {
    writeQuaternionFromForwardInto(snapshot.attitudeQuaternion, -1, 0, 0);
    store.publish(snapshot, 400);
    await nextFrame();
    return readHarnessSnapshot();
  },
};
