# ADR-017: Daily full-state contract for golden trajectories

**Status:** accepted (2026-07-16)

## Context

Physics-spec §7.6 requires committed 30-day LEO, Earth–Mars coast, and Jupiter-flyby trajectories, but did not define sampling cadence, comparison limits, or how the per-call DP54 budget applies to a long regression. A final-state-only check can hide transient or compensating drift, while storing every adaptive step makes baselines depend on controller internals and produces impractical diffs.

The production DP54 profile controls local error and caps each propagation call at 4,000 accepted steps. A 30-day LEO coast cannot honestly be treated as one gameplay call, but daily calls exercise the same production path without changing that budget.

## Decision

- Start all scenarios at the catalog's J2026 epoch and use the production rails, full n-body field, relativistic ship derivative, and §3.1 DP54 profile.
- Store the initial state plus one sample per day through day 30.
- Propagate each day as a separate call. Any segment that does not reach its endpoint within the production 4,000-step budget is a regression failure.
- Compare all seven state components with absolute drift limits of `1e-3 km` for position, `1e-9 km/s` for celerity, and `1e-6 s` for proper time.
- Record construction parameters and resolved initial float64 state in each golden file. Regeneration requires an explicit command flag and a reviewable `golden:` commit.

The limits reuse the established §3.1 absolute scales. Position is relaxed from the local micrometer scale to the existing §7.2 millimeter long-horizon scale; celerity and proper time retain their operational absolute scales. This detects meaningful implementation drift while tolerating last-bit differences in conforming JavaScript math implementations.

## Consequences

- The regression catches both long-horizon drift and localized flyby changes with compact 31-state files.
- Golden histories validate integration of existing production components; they do not replace analytic unit tests or claim independent physical truth.
- Deliberate physics or catalog changes may require baseline updates, whose component-level diffs remain human-reviewable.

## Alternatives considered

- **One 30-day propagation call:** rejected because LEO can legitimately exhaust the per-frame budget even though gameplay advances it through multiple calls.
- **Only the final state:** rejected because transient errors and compensating drift can be hidden.
- **Every accepted step:** rejected because adaptive controller changes would create noisy, oversized baselines.
- **Relative-only comparison:** rejected because near-zero components make relative limits unstable and opaque.
