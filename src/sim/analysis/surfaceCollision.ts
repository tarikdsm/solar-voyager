// physics-spec.md section 6 / ADR-036 — ship-vs-surface contact for the live sim.

import { coordinateVelocityInto, STATE_RX, STATE_RY, STATE_RZ } from '../ship/relativity.js';
import { smallestUnitRoot } from './trajectoryImpact.js';

/** Bisection stops once the contact time is bracketed this tightly (ADR-036). */
export const CONTACT_TIME_TOLERANCE_SEC = 1e-3;

/**
 * Interior samples used to bracket a contact that the chord found but that
 * neither the chord's root time nor the segment endpoint confirms. Sixteen
 * resolves a penetration lasting ~1/16 of an accepted step; anything shorter is
 * a pass that clips the sphere and leaves within one step, reported as a miss.
 */
const BRACKET_SAMPLE_COUNT = 16;

/** Outcome of one accepted-step scan. `bodyIndex < 0` means no contact. */
export interface SurfaceContact {
  bodyIndex: number;
  timeSec: number;
  /** Closing speed against the body centre at contact, km/s. */
  speedKmS: number;
  /** Width of the final bracket, for tests that assert the 1 ms bound. */
  bracketSec: number;
  /** The segment already began at or inside the sphere (ADR-036 section 3.4). */
  startedInside: boolean;
}

/** Writes the propagated ship state at `timeSec`; returns false if it cannot. */
export type ContactStateEvaluator = (timeSec: number, outputState: Float64Array) => boolean;

/** Refreshes the caller's rails positions and velocities to `timeSec`. */
export type ContactRailsEvaluator = (timeSec: number) => void;

/** Setup-allocated scratch for the frame-loop collision scan. */
export interface SurfaceCollisionWorkspace {
  readonly bodyCount: number;
  readonly segmentStartBodyPositionsKm: Float64Array;
  readonly contact: SurfaceContact;
  /** Chord crossing fraction of the last `scanSurfaceCollisionChord` hit. */
  chordFraction: number;
  readonly contactVelocityKmS: Float64Array;
}

/** Allocates the per-core collision scratch once, at construction. */
export function createSurfaceCollisionWorkspace(bodyCount: number): SurfaceCollisionWorkspace {
  if (!Number.isInteger(bodyCount) || bodyCount < 0) {
    throw new RangeError('surface collision body count must be a non-negative integer');
  }
  return {
    bodyCount,
    segmentStartBodyPositionsKm: new Float64Array(bodyCount * 3),
    contact: {
      bodyIndex: -1,
      timeSec: Number.NaN,
      speedKmS: Number.NaN,
      bracketSec: Number.NaN,
      startedInside: false,
    },
    chordFraction: Number.NaN,
    contactVelocityKmS: new Float64Array(3),
  };
}

/** Records the rails positions that open the next accepted step. */
export function captureCollisionSegmentStart(
  workspace: SurfaceCollisionWorkspace,
  bodyPositionsKm: Float64Array,
): void {
  if (bodyPositionsKm.length !== workspace.segmentStartBodyPositionsKm.length) {
    throw new RangeError(
      `surface collision body positions must contain ${workspace.segmentStartBodyPositionsKm.length} components`,
    );
  }
  workspace.segmentStartBodyPositionsKm.set(bodyPositionsKm);
}

function squaredDistanceKm2(
  xKm: number,
  yKm: number,
  zKm: number,
  bodyPositionsKm: Float64Array,
  offset: number,
): number {
  const dxKm = xKm - (bodyPositionsKm[offset] as number);
  const dyKm = yKm - (bodyPositionsKm[offset + 1] as number);
  const dzKm = zKm - (bodyPositionsKm[offset + 2] as number);
  return dxKm * dxKm + dyKm * dyKm + dzKm * dzKm;
}

/**
 * Conservative chord scan over every body, reusing the predictor's root solver.
 *
 * Writes the crossing fraction to `workspace.chordFraction` and returns the
 * candidate body index, or -1. Deliberately a SUPERSET of the true answer: the
 * chord of a gravitating arc sags toward the attractor (~0.31 km over a typical
 * LEO accepted step, against a 7.7 m contact tolerance), so it reads closer than
 * the ship ever gets. Callers MUST confirm with `refineSurfaceContactInto`;
 * dropping that pass turns every close pass into a crash.
 *
 * All bodies are scanned, not just the dominant one: the dominant-body selector
 * is hysteretic by design (ADR-029), so descending onto a moon while its primary
 * is still published as dominant is the ordinary case (ADR-036 section 3.3).
 */
export function scanSurfaceCollisionChord(
  workspace: SurfaceCollisionWorkspace,
  startXKm: number,
  startYKm: number,
  startZKm: number,
  endShipState: Float64Array,
  endBodyPositionsKm: Float64Array,
  collisionRadiiKm: Float64Array,
): number {
  const endXKm = endShipState[STATE_RX] as number;
  const endYKm = endShipState[STATE_RY] as number;
  const endZKm = endShipState[STATE_RZ] as number;
  const startBodyPositionsKm = workspace.segmentStartBodyPositionsKm;
  let bestBodyIndex = -1;
  let bestFraction = Number.POSITIVE_INFINITY;
  workspace.chordFraction = Number.NaN;

  for (let bodyIndex = 0; bodyIndex < workspace.bodyCount; bodyIndex += 1) {
    const radiusKm = collisionRadiiKm[bodyIndex] as number;
    if (!(radiusKm > 0)) continue;
    const offset = bodyIndex * 3;
    const r0xKm = startXKm - (startBodyPositionsKm[offset] as number);
    const r0yKm = startYKm - (startBodyPositionsKm[offset + 1] as number);
    const r0zKm = startZKm - (startBodyPositionsKm[offset + 2] as number);
    const c = r0xKm * r0xKm + r0yKm * r0yKm + r0zKm * r0zKm - radiusKm * radiusKm;
    if (c <= 0) {
      // Already at or inside the sphere. `trajectoryImpact` skips this case
      // because a forecast that starts underground has no entry crossing; the
      // sim must not, or a state placed below a surface would never collide.
      workspace.chordFraction = 0;
      return bodyIndex;
    }

    const r1xKm = endXKm - (endBodyPositionsKm[offset] as number);
    const r1yKm = endYKm - (endBodyPositionsKm[offset + 1] as number);
    const r1zKm = endZKm - (endBodyPositionsKm[offset + 2] as number);
    const dxKm = r1xKm - r0xKm;
    const dyKm = r1yKm - r0yKm;
    const dzKm = r1zKm - r0zKm;
    const fraction = smallestUnitRoot(
      r0xKm * dxKm + r0yKm * dyKm + r0zKm * dzKm,
      dxKm * dxKm + dyKm * dyKm + dzKm * dzKm,
      c,
    );
    if (fraction < bestFraction) {
      bestFraction = fraction;
      bestBodyIndex = bodyIndex;
    }
  }

  if (bestBodyIndex < 0) return -1;
  workspace.chordFraction = bestFraction;
  return bestBodyIndex;
}

/** Probes one time; true when the propagated ship is at or inside the sphere. */
function penetratesAt(
  timeSec: number,
  offset: number,
  squaredRadiusKm2: number,
  evaluateShipState: ContactStateEvaluator,
  evaluateRails: ContactRailsEvaluator,
  bodyPositionsKm: Float64Array,
  scratchState: Float64Array,
): boolean {
  if (!evaluateShipState(timeSec, scratchState)) return false;
  evaluateRails(timeSec);
  return (
    squaredDistanceKm2(
      scratchState[STATE_RX] as number,
      scratchState[STATE_RY] as number,
      scratchState[STATE_RZ] as number,
      bodyPositionsKm,
      offset,
    ) <= squaredRadiusKm2
  );
}

/**
 * Confirms a chord candidate against genuinely propagated states and bisects the
 * contact time to `CONTACT_TIME_TOLERANCE_SEC`.
 *
 * `contact.timeSec` is the LOW bracket endpoint — the last time the ship is known
 * to be at or outside the sphere — so a frozen ship never rests inside a body and
 * `nbodyForces`' central singularity stays unreachable for it (ADR-036 section 6).
 * The true crossing lies inside the bracket, so the reported time is within
 * `CONTACT_TIME_TOLERANCE_SEC` of it.
 */
export function refineSurfaceContactInto(
  workspace: SurfaceCollisionWorkspace,
  bodyIndex: number,
  segmentStartTimeSec: number,
  segmentEndTimeSec: number,
  evaluateShipState: ContactStateEvaluator,
  evaluateRails: ContactRailsEvaluator,
  bodyPositionsKm: Float64Array,
  bodyVelocitiesKmS: Float64Array,
  collisionRadiiKm: Float64Array,
  scratchState: Float64Array,
): SurfaceContact {
  const contact = workspace.contact;
  contact.bodyIndex = -1;
  contact.timeSec = Number.NaN;
  contact.speedKmS = Number.NaN;
  contact.bracketSec = Number.NaN;
  contact.startedInside = false;

  const offset = bodyIndex * 3;
  const radiusKm = collisionRadiiKm[bodyIndex] as number;
  const squaredRadiusKm2 = radiusKm * radiusKm;
  const chordFraction = workspace.chordFraction;

  // A segment that opens inside the sphere is contact at its own start time;
  // there is no bracket to bisect and none is needed.
  if (chordFraction === 0) {
    if (!evaluateShipState(segmentStartTimeSec, scratchState)) return contact;
    evaluateRails(segmentStartTimeSec);
    writeContact(
      workspace,
      bodyIndex,
      segmentStartTimeSec,
      0,
      true,
      scratchState,
      bodyVelocitiesKmS,
      offset,
    );
    return contact;
  }

  const spanSec = segmentEndTimeSec - segmentStartTimeSec;
  let lowSec = segmentStartTimeSec;
  let highSec = Number.NaN;
  const chordTimeSec = segmentStartTimeSec + chordFraction * spanSec;

  // Probed positionally rather than through a local closure: a pass low enough
  // to trip the chord runs this every accepted step, and the frame loop
  // allocates nothing.
  if (
    penetratesAt(
      chordTimeSec,
      offset,
      squaredRadiusKm2,
      evaluateShipState,
      evaluateRails,
      bodyPositionsKm,
      scratchState,
    )
  ) {
    highSec = chordTimeSec;
  } else if (
    penetratesAt(
      segmentEndTimeSec,
      offset,
      squaredRadiusKm2,
      evaluateShipState,
      evaluateRails,
      bodyPositionsKm,
      scratchState,
    )
  ) {
    lowSec = chordTimeSec;
    highSec = segmentEndTimeSec;
  } else {
    // The chord fired on its own sag. Sweep the segment before concluding it
    // missed, so a short powered dip inside one accepted step is still caught.
    let previousSec = segmentStartTimeSec;
    for (let sample = 1; sample <= BRACKET_SAMPLE_COUNT; sample += 1) {
      const sampleTimeSec = segmentStartTimeSec + (spanSec * sample) / BRACKET_SAMPLE_COUNT;
      if (
        penetratesAt(
          sampleTimeSec,
          offset,
          squaredRadiusKm2,
          evaluateShipState,
          evaluateRails,
          bodyPositionsKm,
          scratchState,
        )
      ) {
        lowSec = previousSec;
        highSec = sampleTimeSec;
        break;
      }
      previousSec = sampleTimeSec;
    }
    if (Number.isNaN(highSec)) return contact;
  }

  while (highSec - lowSec > CONTACT_TIME_TOLERANCE_SEC) {
    const midSec = 0.5 * (lowSec + highSec);
    if (midSec <= lowSec || midSec >= highSec) break;
    if (
      penetratesAt(
        midSec,
        offset,
        squaredRadiusKm2,
        evaluateShipState,
        evaluateRails,
        bodyPositionsKm,
        scratchState,
      )
    ) {
      highSec = midSec;
    } else {
      lowSec = midSec;
    }
  }

  // Re-evaluate at the reported time: the probes left the scratch state and the
  // rails wherever the last one landed, which is not necessarily `lowSec`.
  if (!evaluateShipState(lowSec, scratchState)) return contact;
  evaluateRails(lowSec);
  writeContact(
    workspace,
    bodyIndex,
    lowSec,
    highSec - lowSec,
    false,
    scratchState,
    bodyVelocitiesKmS,
    offset,
  );
  return contact;
}

/** Fills the workspace contact record; `|v_ship - v_body|` excludes body spin. */
function writeContact(
  workspace: SurfaceCollisionWorkspace,
  bodyIndex: number,
  timeSec: number,
  bracketSec: number,
  startedInside: boolean,
  shipState: Float64Array,
  bodyVelocitiesKmS: Float64Array,
  offset: number,
): void {
  const velocityKmS = coordinateVelocityInto(
    workspace.contactVelocityKmS,
    shipState[3] as number,
    shipState[4] as number,
    shipState[5] as number,
  );
  const contact = workspace.contact;
  contact.bodyIndex = bodyIndex;
  contact.timeSec = timeSec;
  contact.bracketSec = bracketSec;
  contact.startedInside = startedInside;
  contact.speedKmS = Math.hypot(
    (velocityKmS[0] as number) - (bodyVelocitiesKmS[offset] as number),
    (velocityKmS[1] as number) - (bodyVelocitiesKmS[offset + 1] as number),
    (velocityKmS[2] as number) - (bodyVelocitiesKmS[offset + 2] as number),
  );
}
