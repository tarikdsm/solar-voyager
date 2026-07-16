# ADR-019: Provisional full-catalog analytic-rails bounds

**Status:** accepted (2026-07-16)

## Context

ADR-015 calibrated the original planet/Luna catalog and required T0021 to remeasure every newly added class rather than silently reuse those limits. The 43-body J2026 bake adds dwarfs, Mars/Pluto moons, giant-planet moons, asteroids, and comets. Their analytic rails intentionally omit mutual perturbations and use one fixed osculating conic, so error against Horizons grows with time.

Evaluation of the production rails against all new heliocentric check vectors measured these class maxima:

| Class | +30 days | +365 days | Dominant body |
|---|---:|---:|---|
| Planets and Luna | 34,077 km | 1,159,879 km | Earth |
| Dwarfs, Mars moons, Charon | 65,375 km | 815,969 km | Pluto/Charon |
| Giant-planet moons | 186,936 km | 644,966 km | Mimas / Io |
| Asteroids and comets | 3,429 km | 645,328 km | Hygiea |

All 43 bodies reconstruct the J2026 epoch within one kilometer, so the frame, units, parent centers, and element conversion remain correct.

## Decision

Adopt conservative, fail-closed T0021 ceilings:

- planets and Luna: `50,000 km` at +30 d, `1,500,000 km` at +365 d;
- dwarfs, Mars moons, and Charon: `100,000 km`, `1,500,000 km`;
- giant-planet moons: `250,000 km`, `1,000,000 km`;
- asteroids and comets: `10,000 km`, `750,000 km`.

The regression enumerates every calibrated id. Adding an unknown body still fails until its class is explicitly measured. T0023 remains responsible for the dedicated complete regression and tighter empirical margins; it may replace these provisional ceilings through a follow-up ADR/spec update.

## Consequences

- T0021 can publish a complete catalog without skipping any new body in CI.
- The wide long-horizon limits document model error; they do not relax the sub-kilometer epoch gate.
- Giant-moon limits are substantially larger than the pre-bake estimate because fixed parent-relative conics omit resonances and higher-order perturbations.
- Navigation-grade body ephemerides remain out of scope for ADR-001 rails.

## Alternatives considered

- **Skip new bodies until T0023.** Rejected because the full catalog would merge without regression coverage.
- **Reuse planet/Luna limits for every class.** Rejected because valid Mimas and Io rails exceed them.
- **Fit per-body corrections.** Rejected for the same overfitting and arbitrary-time reasons recorded in ADR-015.
