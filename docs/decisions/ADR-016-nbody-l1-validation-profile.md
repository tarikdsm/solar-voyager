# ADR-016: Dimensionless validation profile for the n-body gravity field

**Status:** accepted (2026-07-16)

## Context

T0014 implements the section-3 point-mass field and requires analytic
single-body and Earth-Sun L1 regressions. The task acceptance described L1 as
approximately zero without a numeric tolerance, while repository physics tests
must take tolerances from physics-spec.md rather than invent them locally.

An inertial L1 point does not have zero gravitational acceleration. In the
circular barycentric rotating frame, a stationary point satisfies
`g_x + n² x = 0`; its Coriolis term is zero. Testing raw absolute residual alone
would depend on units and system scale, so the equilibrium needs a normalized
criterion.

## Decision

Add physics-spec.md section 7.12 with two validation requirements:

- a single point mass must match analytic inverse-square acceleration with
  relative error below `1e-14`;
- an independently solved ideal Earth-Sun L1 point must lie 1.4–1.6 million km
  from Earth and have normalized rotating-frame residual below `1e-10`:
  `|g_x + n²x| / max(|g_x|, |n²x|)`.

The single-body threshold is roughly 45 binary64 epsilons, leaving room for the
few multiply/square-root operations while still detecting a formula or unit
change. The L1 implementation measures `1.44e-15`; the `1e-10` ceiling leaves
five orders of magnitude for platform rounding and future catalog-constant
updates while remaining a stringent cancellation test.

The test obtains Sun/Earth GM and J2026 separation from the baked catalog,
constructs exact barycentric coordinates, and solves the scalar L1 equation
without calling production code. It then evaluates production gravity once at
that independent root and adds only the test-side centrifugal term.

Kahan compensated component sums are used in production to retain precision
when contributions nearly cancel. The field remains the exact unsoftened
section-3 point-mass formula. At an exact body center it is undefined and the
implementation returns explicit `NaN`; later collision logic prevents normal
integration through that singularity.

## Consequences

- The acceptance criterion is reproducible across machines and invariant to a
  uniform change of acceleration units.
- The 1.4–1.6 million km location band prevents a test from finding the wrong
  collinear equilibrium root while leaving ample margin around the physical
  Earth-Sun L1 distance.
- Centrifugal acceleration is not added to the production inertial field.
- No softening length or collision policy is introduced by this task.

## Alternatives considered

- **Absolute zero-acceleration tolerance.** Rejected because gravity at L1 is
  not zero inertially and an absolute threshold is scale/unit dependent.
- **Use the Hill approximation as the test point.** Rejected because it is only
  an initial estimate and does not satisfy a high-precision equilibrium test.
- **Solve L1 with the production evaluator.** Rejected because the resulting
  test would be circular: it could find a root of the same incorrect function
  it was meant to verify.
