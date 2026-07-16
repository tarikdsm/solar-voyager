# ADR-015: Calibrate analytic-rails accuracy against the J2026 bake

**Status:** accepted (2026-07-16)

## Context

Physics-spec.md section 2 initially budgeted planet errors below 1,000 km at
+30 days and 20,000 km at +365 days, with still smaller values for Luna. Those
numbers predated the first JPL Horizons bake and were described as bounds to be
calibrated once regression data existed.

T0013 evaluated the corrected relative-two-body rails from ADR-014 against all
T0020 check vectors. The maximum errors were:

| Class | +30 days | +365 days | Dominant body |
|---|---:|---:|---|
| Planets | 34,077.13 km | 1,159,878.88 km | Earth |
| Luna | 30,934.66 km | 1,158,676.61 km | Moon |

The epoch error remains below 1 km for every body. The later divergence is not
a unit, frame, epoch, or mean-motion defect: after correcting the two-body GM,
it is dominated by perturbations intentionally omitted by ADR-001. Earth and
Moon are especially affected by their mutual acceleration; the outer planets
also accumulate third-body perturbations. A fixed two-body conic cannot match
a full JPL n-body ephemeris at the original bounds.

## Decision

Keep ADR-001's deterministic O(1) analytic rails and calibrate conservative
regression ceilings for the currently baked planet/Luna classes:

- +30 days: 50,000 km;
- +365 days: 1,500,000 km.

The less-than-1-km epoch acceptance remains unchanged. T0021 must remeasure and,
if necessary, explicitly recalibrate bounds for newly baked dwarfs, asteroids,
comets, and giant-planet moons rather than assuming the current rows apply.

## Consequences

- Tests now distinguish implementation regressions from the documented model
  error of unperturbed osculating conics.
- Long-horizon body positions remain physically plausible but are not a
  navigation-grade JPL ephemeris. UI/help text must not claim otherwise.
- The looser one-year ceiling is an explicit limitation, not permission to
  weaken epoch accuracy or introduce numerical drift.
- A future high-accuracy mode would require a different model (periodically
  rebased elements, perturbation series, or ephemeris interpolation) and its own
  performance/data ADR.

## Alternatives considered

- **Keep the pre-bake bounds.** Rejected because valid section-2 rails fail them
  deterministically by more than an order of magnitude.
- **Fit corrections to the three check samples.** Rejected because that would
  overfit test points, script trajectories, and undermine arbitrary-time rails.
- **Replace rails with JPL interpolation.** Rejected for v1 because it changes
  ADR-001's data size, arbitrary-time, save determinism, and high-warp design.

