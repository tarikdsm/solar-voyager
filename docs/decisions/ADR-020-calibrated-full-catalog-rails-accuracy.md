# ADR-020: Calibrated full-catalog rails vector accuracy

**Status:** accepted (2026-07-16)

## Context

ADR-019 introduced conservative position-only ceilings so the 43-body J2026
catalog could ship with fail-closed coverage. It explicitly deferred tighter
empirical limits to T0023 through a follow-up ADR and specification update.

The baked Horizons checks contain heliocentric position and velocity vectors at
J2026, +30 days, and +365 days. Analytic rails reproduce the epoch within one
kilometer, but their deliberate omission of mutual perturbations produces
class-dependent error growth at the later samples. Position-only limits would not
detect regressions in the velocity used by barycentric HUD state and ship setup.

## Decision

- Regress both Euclidean 3D position error in km and velocity error in km/s at
  +30 and +365 days.
- Keep the four physically motivated classes from ADR-019: planets and Luna;
  dwarfs, Mars moons, and Charon; giant-planet moons; asteroids and comets.
- Set each limit to the measured class maximum multiplied by 1.10 and rounded
  upward to two significant digits. `docs/physics-spec.md` section 2 records each
  measured maximum beside its resulting limit.
- Require the Sun to remain exact.
- Map catalog ids to classes explicitly and fail closed when a new id has not been
  calibrated. Pin the expected check offsets to `[0, 30, 365]` days so reordered or
  missing samples cannot silently select the wrong bound.

## Consequences

- All 43 J2026 bodies have reviewable position and velocity envelopes at both
  non-epoch samples.
- The prior provisional ceilings are superseded; most position limits become
  tighter, and velocity gains an explicit contract.
- The 10% rule makes future recalibration reproducible. A catalog rebake that moves
  an envelope must update this decision/spec contract rather than relax tests
  silently.
- The bounds document the accuracy of fixed osculating rails, not
  navigation-grade ephemerides or a change to the propagation model.

## Alternatives considered

- **One global vector limit.** Rejected because giant-moon errors would mask
  regressions in planets and small bodies.
- **One limit per body.** Rejected because 43 per-body envelopes would overfit the
  pinned bake and make the physics specification difficult to audit.
- **Keep position-only checks.** Rejected because velocity is a consumed part of
  every rails state and can regress independently of position.
