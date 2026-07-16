# ADR-014: Use the relative two-body gravitational parameter on rails

**Status:** accepted (2026-07-16)

## Context

Physics-spec.md section 2 originally advanced mean anomaly with the parent GM
alone. That approximation is adequate for negligible test particles, but the
JPL Horizons osculating elements baked by T0020 use the relative two-body
parameter `μ_parent + μ_body`. The omitted body GM produces a deterministic
phase error for massive bodies: Jupiter's Horizons mean motion at J2026 is
`0.0830815262 deg/day`, while parent-only GM gives `0.0830419000 deg/day`.
That difference alone moves Jupiter roughly 14,000 km from its baked vector
after 30 days and 152,000 km after one year.

The same parameter determines perifocal velocity. Using parent-only GM for a
catalog generated with the relative parameter would make position phase and
velocity internally inconsistent even at the osculating epoch.

## Decision

Analytic rails use the standard relative two-body gravitational parameter:

`μ_orbit = μ_parent + μ_body`.

Mean motion is `sqrt(μ_orbit / |a|³)`, and element-to-state conversion receives
the same `μ_orbit`. The compiled catalog stores it as `orbitalMuKm3S2`; the
individual `muKm3S2` array remains unchanged for the n-body gravity field.

## Consequences

- Rails match the dynamical convention of the baked Horizons elements and
  remove avoidable mass-dependent phase drift.
- Test-particle behavior is unchanged in the limit `μ_body / μ_parent -> 0`.
- Perturbations from third bodies remain intentionally absent under ADR-001;
  their empirical residuals are an accuracy-bound concern, not a reason to
  alter the two-body formula.
- This formula change updates physics-spec.md section 2 and is regression-tested
  in T0013.

## Alternatives considered

- **Keep parent-only GM.** Rejected because it knowingly disagrees with the
  source elements and causes large, avoidable giant-planet drift.
- **Bake Horizons mean motion as another schema field.** Rejected because it is
  derivable from existing GM and semimajor-axis data, would require a schema
  migration, and could drift out of consistency with perifocal velocity.
