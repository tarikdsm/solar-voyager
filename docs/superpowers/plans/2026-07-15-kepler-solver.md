# T0012 Kepler Solver Implementation Plan

**Goal:** Implement deterministic elliptic/hyperbolic Kepler solvers and
allocation-conscious osculating-elements/state-vector conversions that meet
`physics-spec.md` §2 and §7.1.

**Architecture:** Keep all orbital math pure in `src/sim/bodies/`, consuming
only `src/core/vec3.ts`. Separate anomaly solving from orbital-element
conversion so the rails propagator can reuse both without importing render,
DOM, or I/O code. Hot-path conversion APIs write into caller-owned outputs.

## 1. Kepler solvers — RED then GREEN

- Add `src/sim/bodies/kepler.test.ts` with elliptic samples spanning
  `e = 0..0.99`, hyperbolic samples spanning `e = 1.01..5`, positive/negative
  mean anomalies, and the exact residual bound `< 1e-12` from §7.1.
- Implement `solveKeplerElliptic` and `solveKeplerHyperbolic` in
  `src/sim/bodies/kepler.ts` with the initial guesses, Newton updates,
  convergence threshold, and 30-iteration cap specified in §2.
- Return convergence metadata through a caller-owned result so failures are
  explicit without allocating or throwing in the propagation loop.

## 2. Elements to Cartesian state — RED then GREEN

- Add tests for a circular equatorial orbit, a general inclined eccentric
  orbit, and a hyperbolic orbit using vis-viva and orientation invariants.
- Define unit-explicit public types in `orbitalElements.ts`.
- Implement perifocal position/velocity followed by
  `Rz(Ω)·Rx(i)·Rz(ω)` into caller-owned position/velocity vectors.

## 3. Cartesian state to elements — RED then GREEN

- Add state round-trip tests using the §7.1 relative tolerance `1e-10`.
- Implement angular-momentum, node, and eccentricity-vector reconstruction.
- Canonicalize degeneracies: zero RAAN for equatorial states; zero argument of
  periapsis for circular states; preserve physical longitude/argument of
  latitude in mean anomaly so state round-trips remain stable.
- Cover elliptic and hyperbolic anomaly recovery without wrapping hyperbolic
  mean anomaly.

## 4. Verification and delivery

- Run focused tests, lint, typecheck, full tests, build, formatting, task schema,
  asset budgets, and `git diff --check`.
- Record TDD evidence and numerical coverage in the task handoff and PR.
- Require a different agent to review formulas, degeneracies, allocation
  behavior, spec citations, and CI before `DONE`/merge.
