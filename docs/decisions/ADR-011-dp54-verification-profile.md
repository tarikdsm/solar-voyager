# ADR-011: Separate DP54 verification and operational tolerance profiles

**Status:** accepted (2026-07-15)

## Context

ADR-002 selects DP54 with the operational ship profile `relTol = 1e-9`,
`absTol = 1e-6 km` for position, and `1e-9 km/s` for celerity. That profile
controls local embedded-pair error and lets both physics-spec §7.2 ten-period
orbits complete well inside the 4,000 accepted-step budget.

The implemented full-precision DP54 tableau nevertheless accumulates more global
phase and invariant error over ten periods than the independent §7.2 limits permit.
The measured position error is approximately 4.3 m for the circular case and 33 m
for the `e = 0.7` case, while energy and angular-momentum drift are of order `1e-8`.
Local error tolerance and accumulated global trajectory error are different
contracts, so one numeric profile cannot honestly be presented as proving both.

## Decision

Keep the ADR-002 operational ship profile unchanged. It is the production
accuracy/performance tradeoff and must cover the circular and eccentric ten-period
scenarios within 4,000 accepted steps.

Use a named, test-only two-body verification profile for physics-spec §7.2:

- `relTol = 2e-11`
- position `absTol = 2e-8 km`
- velocity `absTol = 2e-11 km/s`
- at most 4,000 accepted steps

The §7.2 analytic error and invariant limits are unchanged. Tests must exercise
the production profile and the verification profile separately and must not imply
that the production profile satisfies the stricter accumulated global-error gate.

## Consequences

- The game retains the intended per-frame DP54 cost and warp behavior.
- The analytic regression remains strict enough to detect tableau, stage-time,
  FSAL, controller, and long-horizon convergence defects.
- Future production accuracy requirements must be evaluated separately. If the
  operational profile needs the §7.2 global error over long horizons, ADR-002's
  documented DOP853 upgrade path should be evaluated instead of silently tightening
  every game-frame propagation.

## Alternatives considered

- **Tighten the production profile to the verification values.** Rejected because
  it changes the performance/warp contract to satisfy a test-only convergence gate.
- **Relax §7.2 limits.** Rejected because the existing analytic truth thresholds
  are valuable regression evidence.
- **Hide stricter literals inside the regression.** Rejected because it obscures
  the distinction that caused the original review failure.
