# ADR-017: Daily full-state contract for golden trajectories

**Status:** accepted (2026-07-16)

## Context

Physics-spec §7.6 requires committed 30-day LEO, Earth–Mars coast, and Jupiter-flyby trajectories, but did not define sampling cadence, comparison limits, or how the per-call DP54 budget applies to a long regression. A final-state-only check can hide transient or compensating drift, while storing every adaptive step makes baselines depend on controller internals and produces impractical diffs.

The production DP54 profile controls local error and caps each propagation call at 4,000 accepted steps. A 30-day LEO coast cannot honestly be treated as one gameplay call, but daily calls exercise the same production path without changing that budget.

## Decision

- Start all scenarios at the catalog's J2026 epoch and use the production rails, full n-body field, relativistic ship derivative, and §3.1 DP54 profile.
- Store the initial state plus one sample per day through day 30.
- Propagate each day as a separate call. Any segment that does not reach its endpoint within the production 4,000-step budget is a regression failure.
- Compare all seven state components. The LEO history uses absolute drift limits of `2e-2 km` for position, `2e-5 km/s` for celerity, and `1e-6 s` for proper time. The Earth–Mars transfer and Jupiter flyby retain `1e-3 km`, `1e-9 km/s`, and `1e-6 s`, respectively.
- Record construction parameters and resolved initial float64 state in each golden file. Regeneration requires an explicit command flag and a reviewable `golden:` commit.

The stable-scenario limits reuse the established §3.1 absolute scales. Position is relaxed from the local micrometer scale to the existing §7.2 millimeter long-horizon scale; celerity and proper time retain their operational absolute scales.

The initial CI run demonstrated that the LEO contract needs a separate cross-runtime envelope. Comparing the complete Windows Node 25.8.2 baseline with a Linux Node 22.23.1 regeneration showed maximum 30-day LEO differences of `0.00821 km` in position and `9.31e-6 km/s` in celerity after roughly 40,000 adaptive accepted steps. The transfer was bit-identical and the flyby remained inside the stable limits. The LEO limits are therefore a little over twice the measured platform envelope, while remaining about `3e-6` relative to orbital radius and speed. Proper time showed only `2.19e-8 s` maximum drift and keeps the stricter limit.

## Consequences

- The regression catches both long-horizon drift and localized flyby changes with compact 31-state files.
- Stable transfer/flyby histories are not weakened to accommodate the adaptive LEO platform envelope.
- Golden histories validate integration of existing production components; they do not replace analytic unit tests or claim independent physical truth.
- Deliberate physics or catalog changes may require baseline updates, whose component-level diffs remain human-reviewable.

## Alternatives considered

- **One 30-day propagation call:** rejected because LEO can legitimately exhaust the per-frame budget even though gameplay advances it through multiple calls.
- **Only the final state:** rejected because transient errors and compensating drift can be hidden.
- **Every accepted step:** rejected because adaptive controller changes would create noisy, oversized baselines.
- **Relative-only comparison:** rejected because near-zero components make relative limits unstable and opaque.
