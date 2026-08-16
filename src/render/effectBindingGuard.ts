/**
 * Degrade policy for effect-only camera-relative bindings (T0129).
 *
 * `spaceScene.ts` validates every bound position and throws `RangeError` on a
 * non-finite value. That is correct for ship and body positions — a NaN there
 * means the integrator or the catalog is broken, and the frame loop should die
 * loudly rather than render a lie. It is the wrong policy for *effect* visuals
 * (photon plume, in-world markers, sky panorama), whose sources are derived
 * quantities: a divide-by-zero in a plume direction must not end the session.
 *
 * So the two policies are split, and this module owns the quiet half. When an
 * effect binding's source goes non-finite the scene skips that binding's write
 * for the frame, warns **once per binding**, and raises a telemetry flag.
 * `nonFiniteObserved` and `skippedBindCount` are deliberately monotonic: a flag
 * that clears itself is not evidence. `degradedBindingCount` is live, so a
 * recovered effect stops being counted.
 *
 * Nothing here converts to float32 — the `Math.fround` boundary contract stays
 * in `spaceScene.ts` alone (`tests/render/float32Boundary.test.ts`).
 */

/** Scene-wide counters for the effect-binding degrade path. */
export interface EffectBindingTelemetry {
  /** Effect bindings whose float64 source is non-finite right now. */
  degradedBindingCount: number;
  /** Label of the most recent binding to degrade; `null` before the first. */
  lastDegradedLabel: string | null;
  /** The flag: set the first time any effect binding degraded, never cleared. */
  nonFiniteObserved: boolean;
  /** Monotonic count of per-frame position writes the guard has skipped. */
  skippedBindCount: number;
}

/** Per-binding degrade bookkeeping, allocated once at bind time. */
export interface EffectBindingDegradeState {
  readonly label: string;
  degraded: boolean;
  warned: boolean;
}

export type EffectBindingWarner = (message: string) => void;

export function createEffectBindingTelemetry(): EffectBindingTelemetry {
  return {
    degradedBindingCount: 0,
    lastDegradedLabel: null,
    nonFiniteObserved: false,
    skippedBindCount: 0,
  };
}

export function createEffectBindingDegradeState(label: string): EffectBindingDegradeState {
  if (label.length === 0) throw new RangeError('Effect binding label cannot be empty.');
  return { label, degraded: false, warned: false };
}

/**
 * Records one skipped bind.
 *
 * The message is built inside the `warned` branch, so a binding that fails every
 * frame allocates exactly once for the whole session and the steady-state frame
 * path allocates nothing (`docs/performance-spec.md` §5).
 */
export function degradeEffectBinding(
  telemetry: EffectBindingTelemetry,
  binding: EffectBindingDegradeState,
  warn: EffectBindingWarner,
): void {
  telemetry.skippedBindCount += 1;
  telemetry.nonFiniteObserved = true;
  telemetry.lastDegradedLabel = binding.label;
  if (!binding.degraded) {
    binding.degraded = true;
    telemetry.degradedBindingCount += 1;
  }
  if (!binding.warned) {
    binding.warned = true;
    warn(
      `Effect visual "${binding.label}" has a non-finite camera-relative position; ` +
        'skipping its bind until the source recovers.',
    );
  }
}

/**
 * Clears the live degraded state of one binding.
 *
 * Called on every good frame and on unbind, so it must be cheap and idempotent.
 * `warned` is not reset: "one-time console warning" means one line per binding
 * per session, not one line per outage.
 */
export function restoreEffectBinding(
  telemetry: EffectBindingTelemetry,
  binding: EffectBindingDegradeState,
): void {
  if (!binding.degraded) return;
  binding.degraded = false;
  telemetry.degradedBindingCount -= 1;
}
