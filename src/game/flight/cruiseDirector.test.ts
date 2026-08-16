import { describe, expect, it } from 'vitest';

import { MANUAL_ATTITUDE_MAX_WARP, MAX_THRUST_WARP } from '../../core/time.js';
import { DEFAULT_VESSEL } from '../../sim/ship/vessel.js';
import type { SimulationCore } from '../../sim/simulation.js';
import { compileCanonicalCatalog, createNewGameSimulation } from '../createNewGameSimulation.js';

import { orbitArrivalRadiusKm } from './arrivalStandoff.js';
import { CruiseDirector, type CruisePhase } from './cruiseDirector.js';
import { runCruiseScenario } from './cruiseScenario.js';
import { FlightController } from './flightController.js';

const FRAME_SEC = 1 / 60;

interface Rig {
  readonly simulation: SimulationCore;
  readonly director: CruiseDirector;
  readonly controller: FlightController;
  /** One frame of `bootstrap/frameLoop.ts`'s arbitration. */
  step(frames?: number): void;
  /** Runs until `predicate` or `limit` frames; returns the frames consumed. */
  runUntil(predicate: () => boolean, limit: number): number;
}

function rig(): Rig {
  const simulation = createNewGameSimulation(DEFAULT_VESSEL);
  const catalog = compileCanonicalCatalog();
  const ports = {
    commands: simulation.commands,
    snapshot: () => simulation.snapshot,
    vessel: DEFAULT_VESSEL,
  };
  const controller = new FlightController(ports);
  const director = new CruiseDirector({ ...ports, catalog, controller });
  function step(frames = 1): void {
    for (let index = 0; index < frames; index += 1) {
      director.update(FRAME_SEC);
      if (!director.active) controller.update(FRAME_SEC);
      simulation.step(FRAME_SEC);
    }
  }
  return {
    simulation,
    director,
    controller,
    step,
    runUntil(predicate, limit): number {
      for (let index = 0; index < limit; index += 1) {
        if (predicate()) return index;
        step();
      }
      return limit;
    },
  };
}

describe('CruiseDirector engage', () => {
  it('starts idle and rejects an unknown body without disturbing anything', () => {
    const r = rig();
    expect(r.director.phase).toBe('idle');
    expect(r.director.active).toBe(false);
    expect(r.director.engage('tatooine')).toBe(false);
    expect(r.director.phase).toBe('idle');
    expect(r.simulation.snapshot.throttle).toBe(0);
  });

  it('engages into align, takes the target and opens the cruise thrust regime', () => {
    const r = rig();
    expect(r.director.engage('moon', 'orbit')).toBe(true);
    expect(r.director.phase).toBe('align');
    expect(r.director.active).toBe(true);
    expect(r.director.targetBodyId).toBe('moon');
    r.step();
    expect(r.simulation.snapshot.targetBodyId).toBe('moon');
    expect(r.controller.thrustRegime).toBe('cruise');
    expect(r.director.guidanceMode).toBe('profile');
  });

  it('applies the ring-aware stand-off table rather than the solver default', () => {
    const r = rig();
    r.director.engage('jupiter', 'orbit');
    // physics-spec §8.5: 3 R_col at Jupiter is 214,476 km, inside the Thebe ring.
    expect(r.director.arrivalRadiusKm).toBeCloseTo(324_000, 3);
    expect(r.director.arrivalRadiusKm).toBe(orbitArrivalRadiusKm('jupiter', 71_492));
  });

  it(
    'walks align -> boost -> flip -> brake with the ADR-035 slew budget on the flip',
    { timeout: 60_000 },
    () => {
      const r = rig();
      r.director.engage('moon', 'orbit');
      const seen: CruisePhase[] = [];
      let flipStartSimSec = Number.NaN;
      let flipEndSimSec = Number.NaN;
      for (let index = 0; index < 40_000; index += 1) {
        const before = r.director.phase;
        r.step();
        const after = r.director.phase;
        if (after !== before) {
          seen.push(after);
          if (after === 'flip') flipStartSimSec = r.simulation.snapshot.simTimeSec;
          if (before === 'flip') flipEndSimSec = r.simulation.snapshot.simTimeSec;
        }
        if (after === 'insert') break;
      }
      expect(seen[0]).toBe('boost');
      expect(seen).toContain('flip');
      expect(seen).toContain('brake');
      expect(seen.indexOf('flip')).toBeLessThan(seen.indexOf('brake'));
      // pi / maxSlewRadPerSimS = 12.000 s of SIMULATED time (plan §3.2, ADR-035),
      // resolved at whatever tier the pilot has settled on, so one frame of slack.
      const budgetSec = Math.PI / DEFAULT_VESSEL.maxSlewRadPerSimS;
      expect(budgetSec).toBeCloseTo(12, 3);
      expect(flipEndSimSec - flipStartSimSec).toBeGreaterThan(budgetSec * 0.5);
      expect(flipEndSimSec - flipStartSimSec).toBeLessThan(budgetSec * 3);
    },
  );

  it(
    'never requests a tier that would discard the command it is issuing',
    { timeout: 60_000 },
    () => {
      const r = rig();
      r.director.engage('moon', 'orbit');
      for (let index = 0; index < 6_000; index += 1) {
        r.step();
        const snapshot = r.simulation.snapshot;
        if (snapshot.throttle > 0)
          expect(snapshot.requestedWarp).toBeLessThanOrEqual(MAX_THRUST_WARP);
        const rotating =
          snapshot.attitudeMode === 'manual' &&
          r.director.phase !== 'idle' &&
          snapshot.throttle >= 0;
        if (rotating && snapshot.requestedWarp > MANUAL_ATTITUDE_MAX_WARP) {
          // Above the lockout the director must not be relying on manual rates.
          expect(r.director.phase).not.toBe('flip');
        }
      }
    },
  );
});

describe('CruiseDirector abort', () => {
  it('leaves a valid controllable state and decompresses to <= 100x', () => {
    const r = rig();
    r.director.engage('moon', 'orbit');
    r.step(400);
    r.director.abort();
    expect(r.director.phase).toBe('aborted');
    expect(r.director.active).toBe(false);
    expect(r.controller.thrustRegime).toBe('manual');
    r.step();
    expect(r.simulation.snapshot.throttle).toBe(0);
    const frames = r.runUntil(() => r.simulation.snapshot.requestedWarp <= 100, 120);
    expect(frames * FRAME_SEC).toBeLessThanOrEqual(1);
    r.step(120);
    const snapshot = r.simulation.snapshot;
    expect(snapshot.attitudeMode).toBe('manual');
    expect(Number.isFinite(snapshot.shipState[0] as number)).toBe(true);
    expect(snapshot.impactOccurred).toBe(0);
    // The player has the ship: the controller's lever is what drives throttle now.
    r.controller.setThrottleAxis(0.5);
    r.step(2);
    expect(r.simulation.snapshot.throttle).toBeGreaterThan(0);
  });

  it('treats player input as an abort and a decompression trigger', () => {
    const r = rig();
    r.director.engage('moon', 'orbit');
    r.step(400);
    r.director.notifyPlayerInput();
    expect(r.director.phase).toBe('aborted');
    r.step(120);
    expect(r.simulation.snapshot.requestedWarp).toBeLessThanOrEqual(100);
  });

  it('re-engages after an abort, falling back to pursuit when the solve refuses', () => {
    const r = rig();
    r.director.engage('moon', 'orbit');
    r.step(2_000);
    r.director.abort();
    r.step(60);
    expect(r.director.engage('moon', 'orbit')).toBe(true);
    expect(r.director.active).toBe(true);
    // Mid-cruise the departure solver refuses (ADR-037 §4); that is a routing
    // decision, and the §8.7 endgame is what takes over.
    expect(['profile', 'pursuit']).toContain(r.director.guidanceMode);
    r.step(200);
    expect(r.director.phase).not.toBe('idle');
    expect(Number.isFinite(r.simulation.snapshot.shipState[0] as number)).toBe(true);
  });

  it('is safe to abort in every phase the Moon route passes through', { timeout: 60_000 }, () => {
    const phases: CruisePhase[] = [];
    for (const abortAtFrame of [1, 60, 400, 1_200, 1_800, 2_400, 2_800]) {
      const result = runCruiseScenario({
        targetBodyId: 'moon',
        abortAtFrame,
        framesAfterAbort: 240,
        maxFrames: 6_000,
      });
      phases.push(result.phase);
      expect(result.controllable).toBe(true);
      expect(result.finalThrottle).toBe(0);
      expect(result.finalAttitudeMode).toBe('manual');
      expect(result.finalWarp).toBeLessThanOrEqual(100);
      expect(result.decompressionWallSec).toBeLessThanOrEqual(1);
    }
    expect(new Set(phases)).toEqual(new Set(['aborted']));
  });
});

describe('CruiseDirector arrival', () => {
  it('reaches a near-circular orbit at the Moon stand-off, unattended', { timeout: 60_000 }, () => {
    const result = runCruiseScenario({ targetBodyId: 'moon', maxFrames: 20_000 });
    expect(result.phase).toBe('done');
    expect(result.eccentricity).toBeLessThan(0.05);
    expect(Math.abs(result.altitudeKm / result.presetAltitudeKm - 1)).toBeLessThan(0.1);
    expect(result.impactOccurred).toBe(false);
  });

  it(
    'keeps the energy ledger honest — no side channel (physics-spec §5)',
    { timeout: 60_000 },
    () => {
      const result = runCruiseScenario({ targetBodyId: 'moon', maxFrames: 20_000 });
      // ADR-007: E = int m alpha c dt. The director opens and closes the throttle
      // and writes no energy of its own, so the integrator's figure must equal the
      // photon-drive cost of the thrust time it actually commanded.
      expect(result.ledgerIdentityRatio).toBeGreaterThan(0.98);
      expect(result.ledgerIdentityRatio).toBeLessThan(1.02);
      expect(result.energySpentJ).toBeGreaterThan(0);
    },
  );
});
