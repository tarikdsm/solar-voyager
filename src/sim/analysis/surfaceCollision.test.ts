import { describe, expect, it } from 'vitest';

import { SPEED_OF_LIGHT_KM_S } from '../../core/constants.js';
import {
  captureCollisionSegmentStart,
  createSurfaceCollisionWorkspace,
  refineSurfaceContactInto,
  scanSurfaceCollisionChord,
  CONTACT_TIME_TOLERANCE_SEC,
} from './surfaceCollision.js';
import { smallestUnitRoot } from './trajectoryImpact.js';

const MU_KM3_S2 = 398_600.4418;
const RADIUS_KM = 6_371;

function workspaceAtOrigin(bodyCount = 1) {
  const workspace = createSurfaceCollisionWorkspace(bodyCount);
  captureCollisionSegmentStart(workspace, new Float64Array(bodyCount * 3));
  return workspace;
}

function stateAt(xKm: number, yKm: number, zKm: number): Float64Array {
  return new Float64Array([xKm, yKm, zKm, 0, 0, 0, 0]);
}

/** Position on a circular orbit of radius `radiusKm` after `timeSec`. */
function circularPoint(radiusKm: number, timeSec: number): { xKm: number; yKm: number } {
  const rateRadS = Math.sqrt(MU_KM3_S2 / radiusKm ** 3);
  return {
    xKm: radiusKm * Math.cos(rateRadS * timeSec),
    yKm: radiusKm * Math.sin(rateRadS * timeSec),
  };
}

describe('surfaceCollision chord scan - ADR-036 section 3.1', () => {
  it('shares the predictor root solver rather than re-deriving one', () => {
    // |r0 + f d|^2 = R^2 with r0 = (2,0,0), d = (-2,0,0), R = 1 crosses at f = 0.5.
    expect(smallestUnitRoot(-4, 4, 3)).toBeCloseTo(0.5, 15);
  });

  it('detects a chord that crosses the sphere', () => {
    const workspace = workspaceAtOrigin();
    const hit = scanSurfaceCollisionChord(
      workspace,
      RADIUS_KM + 100,
      0,
      0,
      stateAt(RADIUS_KM - 100, 0, 0),
      new Float64Array(3),
      new Float64Array([RADIUS_KM]),
    );

    expect(hit).toBe(0);
    expect(workspace.chordFraction).toBeCloseTo(0.5, 12);
  });

  it('reports a segment that opens inside the sphere at fraction zero', () => {
    const workspace = workspaceAtOrigin();
    const hit = scanSurfaceCollisionChord(
      workspace,
      RADIUS_KM - 10,
      0,
      0,
      stateAt(RADIUS_KM - 20, 0, 0),
      new Float64Array(3),
      new Float64Array([RADIUS_KM]),
    );

    expect(hit).toBe(0);
    expect(workspace.chordFraction).toBe(0);
  });

  it('ignores bodies with no collision radius', () => {
    const workspace = workspaceAtOrigin();
    const hit = scanSurfaceCollisionChord(
      workspace,
      1,
      0,
      0,
      stateAt(-1, 0, 0),
      new Float64Array(3),
      new Float64Array([0]),
    );

    expect(hit).toBe(-1);
  });

  /**
   * The load-bearing claim of ADR-036 section 3.1, made executable: over a long
   * accepted step the chord of a circular orbit sags below the true arc by far
   * more than the clearance a low pass has, so the chord test fires on a pass
   * that never touches the surface. Anything that deletes the confirmation pass
   * in `refineSurfaceContactInto` turns this false positive into a crash.
   */
  it('fires on a 100 m graze whose true arc never touches the surface', () => {
    const orbitRadiusKm = RADIUS_KM + 0.1;
    const stepSec = 20;
    const workspace = workspaceAtOrigin();
    const start = circularPoint(orbitRadiusKm, 0);
    const end = circularPoint(orbitRadiusKm, stepSec);

    const hit = scanSurfaceCollisionChord(
      workspace,
      start.xKm,
      start.yKm,
      0,
      stateAt(end.xKm, end.yKm, 0),
      new Float64Array(3),
      new Float64Array([RADIUS_KM]),
    );

    expect(hit).toBe(0);
    // Every point of the true arc is 100 m clear, so this is purely chord sag.
    const midpointRadiusKm = Math.hypot((start.xKm + end.xKm) / 2, (start.yKm + end.yKm) / 2);
    expect(orbitRadiusKm - midpointRadiusKm).toBeGreaterThan(0.1);
  });
});

describe('surfaceCollision refinement - ADR-036 section 3.2', () => {
  const bodyPositionsKm = new Float64Array(3);
  const bodyVelocitiesKmS = new Float64Array(3);
  const collisionRadiiKm = new Float64Array([RADIUS_KM]);
  const noRails = (): void => {};

  /** Straight-line descent at 1 km/s from R + 100 km, crossing at t = 100 s. */
  function descentEvaluator(startRadiusKm: number, speedKmS: number) {
    return (timeSec: number, out: Float64Array): boolean => {
      out[0] = startRadiusKm - speedKmS * timeSec;
      out[1] = 0;
      out[2] = 0;
      out[3] = -speedKmS;
      out[4] = 0;
      out[5] = 0;
      out[6] = timeSec;
      return true;
    };
  }

  it('bisects the contact time to the 1 ms tolerance and stops outside', () => {
    const workspace = workspaceAtOrigin();
    workspace.chordFraction = 0.5;

    const contact = refineSurfaceContactInto(
      workspace,
      0,
      0,
      200,
      descentEvaluator(RADIUS_KM + 100, 1),
      noRails,
      bodyPositionsKm,
      bodyVelocitiesKmS,
      collisionRadiiKm,
      new Float64Array(12),
    );

    expect(contact.bodyIndex).toBe(0);
    expect(contact.bracketSec).toBeLessThanOrEqual(CONTACT_TIME_TOLERANCE_SEC);
    expect(Math.abs(contact.timeSec - 100)).toBeLessThanOrEqual(CONTACT_TIME_TOLERANCE_SEC);
    // Reported at the low bracket endpoint, so the ship is never left inside.
    expect(contact.timeSec).toBeLessThanOrEqual(100);
    expect(contact.startedInside).toBe(false);
  });

  it('reports the closing speed from celerity, not from raw state components', () => {
    const workspace = workspaceAtOrigin();
    workspace.chordFraction = 0.5;
    const speedKmS = 3;

    const contact = refineSurfaceContactInto(
      workspace,
      0,
      0,
      100,
      descentEvaluator(RADIUS_KM + 150, speedKmS),
      noRails,
      bodyPositionsKm,
      bodyVelocitiesKmS,
      collisionRadiiKm,
      new Float64Array(12),
    );

    // Celerity 3 km/s is coordinate velocity 3 km/s to within 5e-10 relative.
    expect(contact.speedKmS).toBeCloseTo(speedKmS, 9);
  });

  it('rejects a chord candidate whose propagated states never penetrate', () => {
    const workspace = workspaceAtOrigin();
    workspace.chordFraction = 0.5;
    const clearanceKm = 0.1;

    const contact = refineSurfaceContactInto(
      workspace,
      0,
      0,
      20,
      (timeSec, out) => {
        const point = circularPoint(RADIUS_KM + clearanceKm, timeSec);
        out[0] = point.xKm;
        out[1] = point.yKm;
        out[2] = 0;
        out[3] = 0;
        out[4] = 0;
        out[5] = 0;
        out[6] = timeSec;
        return true;
      },
      noRails,
      bodyPositionsKm,
      bodyVelocitiesKmS,
      collisionRadiiKm,
      new Float64Array(12),
    );

    expect(contact.bodyIndex).toBe(-1);
  });

  it('treats a segment opening inside the sphere as contact at its start time', () => {
    const workspace = workspaceAtOrigin();
    workspace.chordFraction = 0;

    const contact = refineSurfaceContactInto(
      workspace,
      0,
      50,
      70,
      descentEvaluator(RADIUS_KM - 5, 0),
      noRails,
      bodyPositionsKm,
      bodyVelocitiesKmS,
      collisionRadiiKm,
      new Float64Array(12),
    );

    expect(contact.bodyIndex).toBe(0);
    expect(contact.timeSec).toBe(50);
    expect(contact.bracketSec).toBe(0);
    expect(contact.startedInside).toBe(true);
  });

  it('catches a dip that enters and leaves inside a single accepted step', () => {
    // Neither the chord root time nor the segment end is inside; only the
    // interior sweep finds it. A powered descent that pulls up can do this.
    const workspace = workspaceAtOrigin();
    workspace.chordFraction = 0.02;
    const dipDepthKm = 40;

    const contact = refineSurfaceContactInto(
      workspace,
      0,
      0,
      20,
      (timeSec, out) => {
        const phase = Math.sin((Math.PI * timeSec) / 20);
        out[0] = RADIUS_KM + 20 - dipDepthKm * phase;
        out[1] = 0;
        out[2] = 0;
        out[3] = 0;
        out[4] = 0;
        out[5] = 0;
        out[6] = timeSec;
        return true;
      },
      noRails,
      bodyPositionsKm,
      bodyVelocitiesKmS,
      collisionRadiiKm,
      new Float64Array(12),
    );

    expect(contact.bodyIndex).toBe(0);
    expect(contact.bracketSec).toBeLessThanOrEqual(CONTACT_TIME_TOLERANCE_SEC);
    expect(contact.timeSec).toBeGreaterThan(0);
    expect(contact.timeSec).toBeLessThan(20);
  });

  it('counts a fail-open instead of hiding it', () => {
    // A probe that cannot produce a state reports "no contact". That is the
    // right default over inventing a crash, but it must not be invisible.
    const workspace = workspaceAtOrigin();
    workspace.chordFraction = 0.5;
    expect(workspace.probeFailureCount).toBe(0);

    const contact = refineSurfaceContactInto(
      workspace,
      0,
      0,
      200,
      () => false,
      noRails,
      bodyPositionsKm,
      bodyVelocitiesKmS,
      collisionRadiiKm,
      new Float64Array(12),
    );

    expect(contact.bodyIndex).toBe(-1);
    expect(workspace.probeFailureCount).toBeGreaterThan(0);
  });

  it('counts a confirmed contact discarded by a failing final re-evaluation', () => {
    // The most consequential fail-open: the bisection proved a penetration and
    // the closing evaluation drops it.
    const descend = descentEvaluator(RADIUS_KM + 100, 1);
    const refine = (evaluator: typeof descend, workspace = workspaceAtOrigin()) => {
      workspace.chordFraction = 0.5;
      const contact = refineSurfaceContactInto(
        workspace,
        0,
        0,
        200,
        evaluator,
        noRails,
        bodyPositionsKm,
        bodyVelocitiesKmS,
        collisionRadiiKm,
        new Float64Array(12),
      );
      return { contact, workspace };
    };

    // Count the evaluations a converging search makes, so the failure lands on
    // the closing one rather than on a guessed iteration.
    let totalCalls = 0;
    const baseline = refine((timeSec, out) => {
      totalCalls += 1;
      return descend(timeSec, out);
    });
    expect(baseline.contact.bodyIndex).toBe(0);
    expect(baseline.workspace.probeFailureCount).toBe(0);

    let calls = 0;
    const { contact, workspace } = refine((timeSec, out) => {
      calls += 1;
      if (calls === totalCalls) return false;
      return descend(timeSec, out);
    });

    expect(contact.bodyIndex).toBe(-1);
    expect(workspace.probeFailureCount).toBe(1);
  });

  it('rejects a workspace sized for a different catalog', () => {
    const workspace = createSurfaceCollisionWorkspace(2);

    expect(() => captureCollisionSegmentStart(workspace, new Float64Array(3))).toThrow(RangeError);
    expect(() => createSurfaceCollisionWorkspace(-1)).toThrow(RangeError);
  });
});

/** Guards the assumption the graze scenario relies on. */
describe('surfaceCollision sanity', () => {
  it('keeps a circular orbit subluminal in the test helper', () => {
    expect(Math.sqrt(MU_KM3_S2 / RADIUS_KM) / SPEED_OF_LIGHT_KM_S).toBeLessThan(1e-4);
  });
});
