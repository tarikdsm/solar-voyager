import { describe, expect, it } from 'vitest';

import {
  createBurnLog,
  DEFAULT_BURN_LOG_CAPACITY,
  type BurnLogController,
  type BurnLogEntry,
  type BurnLogView,
} from '../sim/ship/ledger.js';
import { createBurnLogSignalStore } from './burnLogSignals.js';

const PROGRADE = new Float64Array([1, 0, 0]);
const NORMAL = new Float64Array([0, 1, 0]);
const RADIAL = new Float64Array([0, 0, 1]);

function burnEntry(sequence: number, bodyId: string | null = 'earth'): BurnLogEntry {
  return {
    startTimeSec: sequence * 10,
    endTimeSec: sequence * 10 + 4,
    startProperTimeSec: sequence * 8,
    endProperTimeSec: sequence * 8 + 3,
    energySpentJ: sequence * 3_600,
    properDeltaVMS: sequence + 0.25,
    peakPowerW: sequence * 1_000,
    dominantBodyId: bodyId,
    progradeDeltaVMS: sequence + 1,
    normalDeltaVMS: -(sequence + 2),
    radialDeltaVMS: sequence + 3,
  };
}

class InstrumentedBurnLogView implements BurnLogView {
  readonly entries: BurnLogEntry[] = [];
  activeBurn: BurnLogEntry | null = null;
  getCalls = 0;

  constructor(readonly capacity = DEFAULT_BURN_LOG_CAPACITY) {}

  get count(): number {
    return this.entries.length;
  }

  get(index: number): BurnLogEntry | null {
    this.getCalls += 1;
    return this.entries[index] ?? null;
  }
}

function completeBurn(controller: BurnLogController, sequence: number): void {
  controller.recorder.begin(
    sequence * 10,
    sequence * 8,
    sequence * 100,
    sequence,
    sequence,
    0,
    0,
    sequence % 2 === 0 ? 'earth' : 'mars',
    PROGRADE,
    NORMAL,
    RADIAL,
    sequence * 1_000,
  );
  controller.recorder.synchronize(
    sequence * 10 + 1,
    sequence * 8 + 0.5,
    sequence * 100 + sequence + 1,
    sequence + 0.25,
    sequence + 0.25,
    0,
    0,
  );
  controller.recorder.end();
}

describe('burn log signal store', () => {
  it('preallocates a stable bounded graph and represents an empty log', () => {
    const view = new InstrumentedBurnLogView();
    const store = createBurnLogSignalStore(view);
    const rows = store.completedRows;
    const newest = rows[0];
    const active = store.activeRow;

    expect(rows).toHaveLength(DEFAULT_BURN_LOG_CAPACITY);
    expect(store.completedCount.value).toBe(0);
    expect(store.activeRow.visible.value).toBe(false);
    expect(rows.every((row) => !row.visible.value)).toBe(true);
    expect(store.structuralRebuildCount).toBe(1);
    expect(store.publish()).toBe(false);
    expect(store.completedRows).toBe(rows);
    expect(store.completedRows[0]).toBe(newest);
    expect(store.activeRow).toBe(active);
    expect(store.structuralRebuildCount).toBe(1);
  });

  it('copies an active burn into the stable graph with UTC, MET, and signed displays', () => {
    const view = new InstrumentedBurnLogView();
    view.activeBurn = {
      startTimeSec: 86_400.5,
      endTimeSec: 86_410.5,
      startProperTimeSec: 80_000,
      endProperTimeSec: 80_008,
      energySpentJ: 7_200,
      properDeltaVMS: 12.5,
      peakPowerW: 2_500,
      dominantBodyId: 'earth',
      progradeDeltaVMS: 10,
      normalDeltaVMS: -2.5,
      radialDeltaVMS: 0,
    };
    const store = createBurnLogSignalStore(view);
    const active = store.activeRow;
    const activeSignals = active.signals;

    expect(active.visible.value).toBe(true);
    expect(active.signals.startTimeSec.value).toBe(86_400.5);
    expect(active.display.startUtc.value).toBe('2026-01-02 00:00:00.500 UTC');
    expect(active.display.endUtc.value).toBe('2026-01-02 00:00:10.500 UTC');
    expect(active.display.startMet.value).toBe('22:13:20.000');
    expect(active.display.endMet.value).toBe('22:13:28.000');
    expect(active.display.energy.value).toBe('2.00 Wh');
    expect(active.display.properDeltaV.value).toBe('12.5 m/s');
    expect(active.display.peakPower.value).toBe('2.50 kW');
    expect(active.display.dominantBody.value).toBe('Earth');
    expect(active.display.progradeDeltaV.value).toBe('+10.0 m/s');
    expect(active.display.normalDeltaV.value).toBe('-2.50 m/s');
    expect(active.display.radialDeltaV.value).toBe('0 m/s');

    view.activeBurn = burnEntry(2, 'mars');
    expect(store.publish()).toBe(false);
    expect(store.activeRow).toBe(active);
    expect(store.activeRow.signals).toBe(activeSignals);
    expect(active.display.dominantBody.value).toBe('Mars');
  });

  it('detects a completed burn that starts and ends between samples', () => {
    const controller = createBurnLog();
    const store = createBurnLogSignalStore(controller.view);

    completeBurn(controller, 4);

    expect(store.publish()).toBe(true);
    expect(store.completedCount.value).toBe(1);
    expect(store.completedRows[0]?.visible.value).toBe(true);
    expect(store.completedRows[0]?.signals.startTimeSec.value).toBe(40);
    expect(store.completedRows[0]?.signals.dominantBodyId.value).toBe('earth');
    expect(store.activeRow.visible.value).toBe(false);
  });

  it('does not display a throttle tap with no simulation step', () => {
    const controller = createBurnLog();
    const store = createBurnLogSignalStore(controller.view);

    controller.recorder.begin(10, 9, 100, 2, 2, 0, 0, 'earth', PROGRADE, NORMAL, RADIAL, 1_000);
    controller.recorder.end();

    expect(store.publish()).toBe(false);
    expect(store.completedCount.value).toBe(0);
    expect(store.activeRow.visible.value).toBe(false);
  });

  it('retains the newest 256 burns newest-first when the 257th wraps the ring', () => {
    const controller = createBurnLog();
    for (let sequence = 0; sequence < DEFAULT_BURN_LOG_CAPACITY; sequence += 1) {
      completeBurn(controller, sequence);
    }
    const store = createBurnLogSignalStore(controller.view);

    expect(store.completedRows[0]?.signals.startTimeSec.value).toBe(2_550);
    expect(store.completedRows[255]?.signals.startTimeSec.value).toBe(0);
    const rebuildsBeforeWrap = store.structuralRebuildCount;

    completeBurn(controller, DEFAULT_BURN_LOG_CAPACITY);

    expect(store.publish()).toBe(true);
    expect(store.completedCount.value).toBe(DEFAULT_BURN_LOG_CAPACITY);
    expect(store.completedRows[0]?.signals.startTimeSec.value).toBe(2_560);
    expect(store.completedRows[255]?.signals.startTimeSec.value).toBe(10);
    expect(store.structuralRebuildCount).toBe(rebuildsBeforeWrap + 1);
  });

  it('compares every newest field exactly, including dominant body', () => {
    const view = new InstrumentedBurnLogView();
    const mutable = burnEntry(1) as {
      -readonly [Key in keyof BurnLogEntry]: BurnLogEntry[Key];
    };
    view.entries.push(mutable);
    const store = createBurnLogSignalStore(view);
    const mutations: Array<() => void> = [
      () => (mutable.startTimeSec += 0.5),
      () => (mutable.endTimeSec += 0.5),
      () => (mutable.startProperTimeSec += 0.5),
      () => (mutable.endProperTimeSec += 0.5),
      () => (mutable.energySpentJ += 1),
      () => (mutable.properDeltaVMS += 1),
      () => (mutable.peakPowerW += 1),
      () => (mutable.dominantBodyId = 'mars'),
      () => (mutable.progradeDeltaVMS += 1),
      () => (mutable.normalDeltaVMS += 1),
      () => (mutable.radialDeltaVMS += 1),
    ];

    for (let index = 0; index < mutations.length; index += 1) {
      const rebuilds = store.structuralRebuildCount;
      mutations[index]?.();
      expect(store.publish()).toBe(true);
      expect(store.structuralRebuildCount).toBe(rebuilds + 1);
    }
    expect(store.completedRows[0]?.signals.dominantBodyId.value).toBe('mars');
  });

  it('does not walk unchanged history and reports exact rebuild and publish counts', () => {
    const view = new InstrumentedBurnLogView();
    for (let index = 0; index < DEFAULT_BURN_LOG_CAPACITY; index += 1) {
      view.entries.push(burnEntry(index));
    }
    const store = createBurnLogSignalStore(view);
    view.getCalls = 0;

    for (let index = 0; index < 12; index += 1) expect(store.publish()).toBe(false);

    expect(view.getCalls).toBe(12);
    expect(store.publishCount).toBe(12);
    expect(store.structuralRebuildCount).toBe(1);
  });

  it('rebinds synchronously while clearing stale active and completed slots', () => {
    const first = new InstrumentedBurnLogView();
    first.entries.push(burnEntry(1), burnEntry(2));
    first.activeBurn = burnEntry(3);
    const store = createBurnLogSignalStore(first);
    const rows = store.completedRows;
    const rowZero = rows[0];
    const active = store.activeRow;
    const replacement = new InstrumentedBurnLogView();
    replacement.entries.push(burnEntry(9, 'jupiter'));
    const rebuilds = store.structuralRebuildCount;

    store.rebind(replacement);

    expect(store.completedRows).toBe(rows);
    expect(store.completedRows[0]).toBe(rowZero);
    expect(store.activeRow).toBe(active);
    expect(store.completedCount.value).toBe(1);
    expect(store.completedRows[0]?.signals.startTimeSec.value).toBe(90);
    expect(store.completedRows[0]?.signals.dominantBodyId.value).toBe('jupiter');
    expect(store.completedRows[1]?.visible.value).toBe(false);
    expect(store.activeRow.visible.value).toBe(false);
    expect(store.structuralRebuildCount).toBe(rebuilds + 1);
  });

  it('rebinds from a smaller valid view to a larger valid view', () => {
    const smaller = new InstrumentedBurnLogView(1);
    smaller.entries.push(burnEntry(1));
    const store = createBurnLogSignalStore(smaller);
    const larger = new InstrumentedBurnLogView(2);
    larger.entries.push(burnEntry(2), burnEntry(3));

    store.rebind(larger);

    expect(store.completedCount.value).toBe(2);
    expect(store.completedRows[0]?.signals.startTimeSec.value).toBe(30);
    expect(store.completedRows[1]?.signals.startTimeSec.value).toBe(20);
  });

  it('rejects invalid candidate structure without changing the bound view or signal state', () => {
    const invalidViews = [
      new InstrumentedBurnLogView(Number.NaN),
      new InstrumentedBurnLogView(1.5),
      new InstrumentedBurnLogView(0),
      new InstrumentedBurnLogView(DEFAULT_BURN_LOG_CAPACITY + 1),
      new InstrumentedBurnLogView(1),
    ];
    invalidViews[4]?.entries.push(burnEntry(7), burnEntry(8));

    for (let index = 0; index < invalidViews.length; index += 1) {
      const original = new InstrumentedBurnLogView(1);
      const mutableOriginal = burnEntry(1) as {
        -readonly [Key in keyof BurnLogEntry]: BurnLogEntry[Key];
      };
      original.entries.push(mutableOriginal);
      original.activeBurn = burnEntry(2);
      const store = createBurnLogSignalStore(original);
      const rows = store.completedRows;
      const rowZero = rows[0];
      const active = store.activeRow;
      const rebuilds = store.structuralRebuildCount;

      expect(() => store.rebind(invalidViews[index] as BurnLogView)).toThrow(RangeError);

      expect(store.completedRows).toBe(rows);
      expect(store.completedRows[0]).toBe(rowZero);
      expect(store.activeRow).toBe(active);
      expect(store.completedCount.value).toBe(1);
      expect(store.completedRows[0]?.signals.startTimeSec.value).toBe(10);
      expect(store.activeRow.signals.startTimeSec.value).toBe(20);
      expect(store.structuralRebuildCount).toBe(rebuilds);

      mutableOriginal.startTimeSec += 1;
      expect(store.publish()).toBe(true);
      expect(store.completedRows[0]?.signals.startTimeSec.value).toBe(11);
    }
  });
});
