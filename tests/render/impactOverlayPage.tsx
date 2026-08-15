import { render } from 'preact';

import '../../src/style.css';
// `App.tsx` is what normally pulls this in; the harness mounts the overlay
// alone, so without this line the layout assertions measure unstyled blocks.
import '../../src/ui/app.css';
import { createSimulationSnapshotBuffer } from '../../src/sim/simulationSnapshot.js';
import { ImpactOverlay } from '../../src/ui/ImpactOverlay.js';
import { createImpactSignalStore } from '../../src/ui/impactSignals.js';

interface ImpactOverlayHarness {
  clear(): void;
  impact(speedKmS: number, bodyIndex: number, restorePoints: number): void;
  snapshot(): { readonly restoreClicks: number; readonly respawnClicks: number };
}

declare global {
  var __impactOverlayHarness: ImpactOverlayHarness;
}

const BODY_IDS = ['earth', 'moon', 'jupiter'] as const;
const store = createImpactSignalStore();
const buffer = createSimulationSnapshotBuffer([...BODY_IDS]);
let restoreClicks = 0;
let respawnClicks = 0;

const root = document.querySelector('#impact-overlay-root');
if (!(root instanceof HTMLElement)) throw new Error('impact overlay root missing');

render(
  <ImpactOverlay
    actions={{
      onRestore: () => {
        restoreClicks += 1;
      },
      onRespawn: () => {
        respawnClicks += 1;
      },
    }}
    display={store.display}
  />,
  root,
);

globalThis.__impactOverlayHarness = {
  clear: () => {
    buffer.impactOccurred = 0;
    buffer.impactBodyIndex = -1;
    buffer.impactSpeedKmS = 0;
    buffer.impactSimTimeSec = 0;
    store.publish(buffer, 0);
  },
  impact: (speedKmS, bodyIndex, restorePoints) => {
    buffer.impactOccurred = 1;
    buffer.impactBodyIndex = bodyIndex;
    buffer.impactSpeedKmS = speedKmS;
    buffer.impactSimTimeSec = 4_321;
    buffer.shipProperTimeSec = 4_320;
    buffer.utcTimeMs = Date.UTC(2026, 0, 1, 1, 12, 0);
    store.publish(buffer, restorePoints);
  },
  snapshot: () => ({ restoreClicks, respawnClicks }),
};

store.publish(buffer, 0);
