# ADR-002: Dormand–Prince 5(4) adaptive integrator for the ship

**Status:** accepted (2026-07-15)

## Decision

The ship is propagated with an embedded Dormand–Prince RK5(4) pair (FSAL), PI step-size control, relTol 1e-9 / absTol 1e-6 km, exposed as a pure `propagate(state, t0, t1, accelFn, tol)` shared verbatim by the main sim and the predictor worker. Fixed-step RK4 at 100 Hz is used only for the 2D launch phase (reproducibility).

## Why

- Adaptivity is the killer feature for warp: multi-day steps in deep space (high warp nearly free), seconds-scale steps skimming a periapsis — automatically.
- Symplectic integrators lose their advantage here: thrust is non-conservative and horizons are per-frame; DP54's local error control matters more.
- ~80 lines, standard published tableau, every agent can understand and test it.

## Alternatives

DOP853 (8th order) — documented upgrade path if precision tests demand it; the propagator interface makes it a drop-in. Symplectic leapfrog — used where it belongs: the optional mutual-n-body bodies mode (ADR-001).
