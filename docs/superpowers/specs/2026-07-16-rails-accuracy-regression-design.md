# T0023 Rails Accuracy Regression Design

## Goal

Replace the provisional full-catalog rails ceilings with a reproducible accuracy
regression for every J2026 catalog body at +30 and +365 days. Record both the
measured error and the reviewable safety margin in `docs/physics-spec.md`.

## Scope

- Compare heliocentric position and velocity produced by analytic rails with the
  baked JPL Horizons vectors.
- Cover all 43 catalog bodies at both non-epoch check samples.
- Preserve the existing J2026 reconstruction check and fail-closed catalog
  classification.
- Do not change rails propagation, catalog data, or runtime interfaces.

## Chosen approach

Use explicit body classes with one bound per class and sample age. A global bound
would hide regressions in more accurate classes; per-body limits would make the
physics specification noisy and expensive to maintain. The existing four classes
remain appropriate because their perturbation environments explain the observed
error scales:

1. planets and Luna;
2. dwarfs, Mars moons, and Charon;
3. giant-planet moons;
4. asteroids and comets.

The Sun is handled separately and must remain exact.

## Calibration policy

For each class and check epoch, compute the maximum Euclidean position error in km
and velocity error in km/s across all class members. A regression limit is the
measured maximum multiplied by 1.10 and rounded upward to two significant digits.
The specification records `measured / limit` values so reviewers can see both the
evidence and the margin. Exact-zero reference cases retain an exact-zero limit.

This policy deliberately ties tolerances to the pinned J2026 bake. A later catalog
rebake that changes the envelope must update the measured table explicitly rather
than silently relaxing a test.

## Test structure and data flow

`tests/sim/propagation/rails.test.ts` loads `data/bodies.json` and
`data/ephemerides-check.json`, compiles the production rails catalog, and evaluates
one reusable state/workspace per sample. Small helpers calculate 3D position and
velocity errors. An explicit body-to-class mapping selects the documented bounds;
an unknown id throws so catalog growth cannot bypass calibration.

The suite will:

- retain the epoch reconstruction assertion;
- compare every body at +30 and +365 days against its position and velocity limit;
- assert that every baked body has a calibrated class;
- retain a direct unknown-body fail-closed assertion.

## Failure behavior

Failures identify the body, epoch, quantity, measured error, and applicable limit
through Vitest assertion labels. Missing samples, missing reference states, or
unknown body ids fail rather than being skipped.

## Documentation

`docs/physics-spec.md` section 2 will replace ADR-019's provisional ceilings with
the measured maxima and calibrated regression limits for position and velocity.
No ADR is required because no formula, schema, command, or snapshot interface is
changing; this task calibrates an already specified regression contract.
