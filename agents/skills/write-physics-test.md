# Skill: Write a Physics Test

How physics gets tested in this repo. The spec of record is `docs/physics-spec.md` — §7 lists the mandatory suite.

## Principles

1. **Tolerances come from the spec.** Never invent a tolerance to make a test pass; if the spec's bound is wrong, change the spec (ADR) — not the assertion.
2. **Test against analytic truth wherever it exists:** two-body Kepler solutions, vis-viva, Hohmann Δv (LEO→GEO = 3.90 km/s), conservation laws (energy, angular momentum for coast arcs).
3. **Regression against baked reality:** rails vs `data/ephemerides-check.json` (real Horizons vectors).
4. **Golden files for the rest:** propagations with no closed form live in `tests/golden/` as stored trajectories. Changing a golden requires a dedicated commit `golden: <reason>` and reviewer attention.

## Patterns

```ts
// tests mirror src structure: src/sim/propagation/dp54.ts → tests/sim/propagation/dp54.test.ts
// cite the spec in the describe block:
describe('dp54 — physics-spec §3.1 / §7.2', () => { ... })
```

- Pure functions only (sim/ has no side effects) — no mocks needed; construct states inline.
- Property-style checks where cheap: energy drift over N periods, |h| conservation, symmetry (time-reversal for coast arcs).
- Numeric comparisons: use relative error `|a−b|/max(|a|,|b|)` for large quantities (positions in km), absolute for near-zero quantities.
- Long integrations in tests: keep under ~1 s runtime each; use coarser tolerance profiles only if the spec defines them.

## Launch-phase tests

The 2D launch sim is fixed-step RK4 → **bit-reproducible**. Regression: the scripted ascent profile in `tests/sim/launch/profile.ts` must reach 200±5 km orbit with golden Δv ±1% and max-q ±2% (spec §7.4).
