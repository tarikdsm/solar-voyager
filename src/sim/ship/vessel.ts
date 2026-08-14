/**
 * Immutable per-session vessel definition (ADR-034).
 *
 * Rest mass is constant: the photon drive is propellantless (ADR-007), so no
 * field here changes while a session runs. Every quantity the ledger prices —
 * `E = m*alpha*c*dt` and `P = m*alpha*c` (physics-spec.md §3.0.1, §5) — is
 * derived from `restMassKg`, which is why the vessel travels inside the
 * persistent state instead of being re-supplied by the caller on restore.
 */
export interface VesselConfig {
  /** Constant rest mass in kilograms; finite and positive. */
  readonly restMassKg: number;
  /** Absolute drive limit in m/s^2 — the largest proper acceleration the sim will command. */
  readonly alphaMaxMS2: number;
  /** Manual-regime ceiling in m/s^2; stored by the sim, applied by the flight controller (T0108). */
  readonly alphaManualMaxMS2: number;
  /** Hold-mode angular slew limit in rad per simulated second; consumed by T0107. */
  readonly maxSlewRadPerSimS: number;
}

/**
 * Torchship baseline: 10 t, 10 g absolute, 2 g manual, 15 deg/s hold slew.
 *
 * Accelerations are written as exact decimal literals rather than multiples of
 * standard gravity because `10 * 9.80665` is not bit-identical to `98.0665` in
 * float64; the literals are the contract (v2 plan §2).
 */
export const DEFAULT_VESSEL: VesselConfig = Object.freeze({
  restMassKg: 10_000,
  alphaMaxMS2: 98.0665, // 10 g
  alphaManualMaxMS2: 19.6133, // 2 g
  maxSlewRadPerSimS: 0.261799, // 15 deg/s
});

function requirePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`vessel ${label} must be finite and positive`);
  }
  return value;
}

/** Validates untrusted vessel data and returns a frozen ownership-safe copy. */
export function validateVesselConfig(source: VesselConfig): VesselConfig {
  const restMassKg = requirePositive(source.restMassKg, 'rest mass');
  const alphaMaxMS2 = requirePositive(source.alphaMaxMS2, 'maximum proper acceleration');
  const alphaManualMaxMS2 = requirePositive(source.alphaManualMaxMS2, 'manual proper acceleration');
  const maxSlewRadPerSimS = requirePositive(source.maxSlewRadPerSimS, 'maximum slew rate');
  if (alphaManualMaxMS2 > alphaMaxMS2) {
    throw new RangeError('vessel manual proper acceleration must not exceed the drive limit');
  }
  return Object.freeze({ restMassKg, alphaMaxMS2, alphaManualMaxMS2, maxSlewRadPerSimS });
}
