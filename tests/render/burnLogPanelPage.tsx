import { render } from 'preact';

import type { BurnLogEntry, BurnLogView } from '../../src/sim/ship/ledger.js';
import '../../src/ui/app.css';
import { createBurnLogSignalStore } from '../../src/ui/burnLogSignals.js';
import { BurnLogPanel } from '../../src/ui/BurnLogPanel.js';

function entry(sequence: number): BurnLogEntry {
  return {
    startTimeSec: sequence * 10,
    endTimeSec: sequence * 10 + 4,
    startProperTimeSec: sequence * 8,
    endProperTimeSec: sequence * 8 + 3,
    energySpentJ: sequence * 3_600,
    properDeltaVMS: sequence + 0.25,
    peakPowerW: sequence * 1_000,
    dominantBodyId: sequence % 2 === 0 ? 'earth' : 'mars',
    progradeDeltaVMS: sequence + 1,
    normalDeltaVMS: -(sequence + 2),
    radialDeltaVMS: sequence + 3,
  };
}

class RegressionBurnLogView implements BurnLogView {
  readonly capacity = 256;
  readonly entries: BurnLogEntry[] = [];
  activeBurn: BurnLogEntry | null = entry(300);

  constructor() {
    for (let index = 0; index < this.capacity; index += 1) this.entries.push(entry(index));
  }

  get count(): number {
    return this.entries.length;
  }

  get(index: number): BurnLogEntry | null {
    return this.entries[index] ?? null;
  }
}

const root = document.querySelector('#burn-log-root');
if (!(root instanceof HTMLElement)) throw new Error('burn log regression root is missing');

render(<BurnLogPanel store={createBurnLogSignalStore(new RegressionBurnLogView())} />, root);
