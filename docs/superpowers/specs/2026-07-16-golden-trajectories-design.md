# Golden Trajectory Harness Design

**Task:** T0016  
**Date:** 2026-07-16

## Goal

Make long-horizon changes to the production ship propagator reviewable by comparing three deterministic 30-day coasts against committed state histories.

## Scenarios

All scenarios start at J2026 (`timeSec = 0`), use the committed `data/bodies.json` catalog, evaluate analytic rails at every DP54 stage, and apply the allocation-free full n-body field to an unpowered relativistic ship state `(r, u, tau)`.

1. **400 km LEO:** Earth epoch state plus a 400 km circular prograde orbit. This stresses many short steps and repeated third-body perturbations.
2. **Earth-Mars transfer coast:** a Sun-centered Hohmann departure state placed 1,000 km beyond Earth's committed SOI along the Sun-Earth radial. This avoids an artificial Earth-center singularity while representing post-escape transfer coast.
3. **Jupiter flyby:** a 15 km/s Jupiter-relative approach beginning 15 million km upstream with a 1 million km impact parameter. This crosses a strong changing gravity field without intersecting Jupiter.

Initial-state construction inputs and the resolved float64 state are stored with each golden file.

## Sampling and comparison

Each file contains the initial state and 30 daily samples, including both endpoints. Every one-day interval is a separate production-profile DP54 call with the normal 4,000 accepted-step budget. A failed interval is a hard error that reports the scenario, interval, integrator flags, and step counts.

The comparison checks every component at every sample and reports the scenario, sample time, component, expected value, actual value, drift, and allowed drift. The proposed cross-runtime absolute limits are:

- position: `1e-3 km`;
- celerity: `1e-9 km/s`;
- proper time: `1e-6 s`.

These limits match the existing physics-spec absolute position/proper-time accuracy scale and celerity scale, while leaving JSON baselines stable across compliant JavaScript runtimes. They are added to physics-spec section 7.6 and justified in ADR-017.

## Regeneration safety

`npm run golden:regen -- --update-goldens` invokes a small Node guard, which refuses to run without the exact flag. The guard launches one dedicated Vitest regeneration entrypoint with an environment capability; ordinary `npm test` only reads and compares files. Golden JSON changes are committed separately with a `golden:` commit.

## Alternatives considered

- **Only compare final states.** Rejected because compensating drift or a localized flyby error could be hidden.
- **Store every integrator step.** Rejected because adaptive-step implementation details would dominate the diff and make review impractical.
- **Use idealized single-body fixtures.** Rejected because existing unit tests already cover analytic two-body behavior; these goldens must exercise the integrated rails + n-body + relativistic DP54 path.
- **Regenerate from a normal test mode.** Rejected because an accidental environment variable or test invocation could overwrite review evidence.
