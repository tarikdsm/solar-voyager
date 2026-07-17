// physics-spec.md §1 / §3.2 — simulation time and warp contracts.

const J2026_DISPLAY_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

/** Canonical human-readable label for the simulation's TDB epoch. */
export const J2026_TDB_EPOCH_LABEL = '2026-01-01T00:00:00 TDB';

/** Exact time-warp factors allowed by physics-spec.md §3.2. */
export const WARP_LADDER = Object.freeze([1, 5, 10, 50, 100, 1e3, 1e4, 1e5, 1e6, 1e7] as const);

/** A time-warp factor selected from the canonical ladder. */
export type WarpFactor = (typeof WARP_LADDER)[number];

/** Highest canonical tier where player thrust may remain active. */
export const MAX_THRUST_WARP: WarpFactor = 1e3;

/** Mutable float64 simulation time, measured in TDB seconds since J2026. */
export interface SimClock {
  timeSec: number;
}

/** Snapshot of a requested warp and any effective clamp applied by the simulation. */
export interface WarpClampState {
  readonly requestedWarp: WarpFactor;
  readonly effectiveWarp: WarpFactor;
  readonly reason: string | null;
}

/** Creates caller-owned clock state; allocate once and advance it in place. */
export function createSimClock(initialTimeSec = 0): SimClock {
  return { timeSec: initialTimeSec };
}

/** Advances a clock in place without allocating and returns its new TDB time. */
export function advanceSimClock(clock: SimClock, wallDeltaSec: number, warp: WarpFactor): number {
  clock.timeSec += wallDeltaSec * warp;
  return clock.timeSec;
}

/**
 * Maps TDB seconds to a UTC-only display calendar.
 *
 * The spec fixes the J2026 civil fields but does not define an astronomical
 * TDB↔UTC offset model. This display mapping therefore anchors those fields to
 * UTC and must not be used for orbital calculations.
 */
export function tdbSecondsToUtcDate(timeSec: number): Date {
  return new Date(tdbSecondsToUtcTimeMs(timeSec));
}

/** Maps TDB seconds to the UTC display timestamp without allocating a Date. */
export function tdbSecondsToUtcTimeMs(timeSec: number): number {
  return J2026_DISPLAY_EPOCH_MS + timeSec * 1_000;
}

/** Inverts the UTC-only display mapping at JavaScript Date's millisecond precision. */
export function utcDateToTdbSeconds(date: Date): number {
  return (date.getTime() - J2026_DISPLAY_EPOCH_MS) / 1_000;
}

/** Formats a simulation time deterministically with an explicit UTC suffix. */
export function formatTdbSecondsAsUtc(timeSec: number): string {
  return tdbSecondsToUtcDate(timeSec).toISOString().replace('T', ' ').replace('Z', ' UTC');
}
