import { describe, expect, it } from 'vitest';

import { StartupTracker } from './startupTracker.js';

function advanceWorld(tracker: StartupTracker): void {
  tracker.advance('context');
  tracker.advance('star-catalog');
  tracker.advance('asset-manifest');
  tracker.advance('hero-spheres');
  tracker.advance('flight-shaders');
  tracker.advance('map-shaders');
}

describe('StartupTracker', () => {
  it('publishes only the exact monotonic completed-milestone sequence', () => {
    const tracker = new StartupTracker(10);
    expect(tracker.stage).toBe('boot');
    expect(tracker.progress).toBe(0);

    tracker.advance('context');
    expect(tracker.progress).toBe(0.1);
    expect(() => tracker.advance('context')).toThrow(/expected star-catalog/iu);
    expect(() => tracker.advance('asset-manifest')).toThrow(/expected star-catalog/iu);
    tracker.advance('star-catalog');
    expect(tracker.progress).toBe(0.2);
  });

  it('records auto selection, resource/program evidence, and first playable once', () => {
    const tracker = new StartupTracker(10);
    advanceWorld(tracker);
    tracker.recordQuality(7, 'auto', 12.5);
    tracker.advance('post-ready');
    tracker.recordReady(210, {
      encodedBodyBytes: 300,
      programCount: 14,
      resourceCount: 6,
      transferBytes: 400,
    });

    expect(tracker.stage).toBe('ready');
    expect(tracker.progress).toBe(1);
    expect(tracker.firstPlayableMs).toBe(200);
    expect(tracker.selectedRung).toBe(7);
    expect(tracker.qualitySource).toBe('auto');
    expect(tracker.probeMeanMs).toBe(12.5);
    expect(tracker.programCountAtReady).toBe(14);
    expect(tracker.programCountAfterFirstFrame).toBeNull();
    tracker.recordFirstFrameProgramCount(14);
    tracker.recordFirstFrameProgramCount(19);
    expect(tracker.programCountAfterFirstFrame).toBe(14);
    expect(tracker.transferBytes).toBe(400);
    expect(() =>
      tracker.recordReady(220, {
        encodedBodyBytes: 0,
        programCount: 0,
        resourceCount: 0,
        transferBytes: 0,
      }),
    ).toThrow(/ready/iu);
  });

  it('requires manual selection to omit timing evidence', () => {
    const tracker = new StartupTracker(0);
    advanceWorld(tracker);
    expect(() => tracker.recordQuality(0, 'manual', 1)).toThrow(/manual/iu);
    tracker.recordQuality(0, 'manual', null);
    expect(tracker.probeMeanMs).toBeNull();
  });

  it('fails at the current truthful progress with a bounded sanitized error', () => {
    const tracker = new StartupTracker(0);
    tracker.advance('context');
    tracker.fail(new Error(`  network\n denied ${'x'.repeat(300)}  `));

    expect(tracker.stage).toBe('failed');
    expect(tracker.failedStage).toBe('context');
    expect(tracker.progress).toBe(0.1);
    expect(tracker.errorCount).toBe(1);
    expect(tracker.errorMessage).toMatch(/^network denied/u);
    expect(tracker.errorMessage?.length).toBeLessThanOrEqual(160);
    expect(() => tracker.advance('star-catalog')).toThrow(/failed/iu);
  });

  it('exposes a frozen getter-only null-prototype diagnostic', () => {
    const tracker = new StartupTracker(0);
    let currentProgramCount = 3;
    const diagnostic = tracker.createDiagnostic(() => currentProgramCount);
    tracker.advance('context');

    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.getPrototypeOf(diagnostic)).toBeNull();
    expect(diagnostic.stage).toBe('context');
    expect(diagnostic.progress).toBe(0.1);
    expect(diagnostic.programCountCurrent).toBe(3);
    expect(diagnostic.programCountAfterFirstFrame).toBeNull();
    currentProgramCount = 5;
    expect(diagnostic.programCountCurrent).toBe(5);
    expect(Reflect.set(diagnostic, 'stage', 'ready')).toBe(false);
    expect(diagnostic.stage).toBe('context');
  });
});
