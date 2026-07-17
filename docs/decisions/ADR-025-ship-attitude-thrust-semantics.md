# ADR-025: Ship attitude, thrust, and predictor invalidation semantics

**Status:** accepted (2026-07-17)

## Context

ADR-007 defines celerity dynamics and photon-drive power, while ADR-024 reserves
attitude, throttle, thrust, power, and command fields. T0051 must make those
fields operational without expanding the seven-component relativistic state,
allocating in DP54 stages, or coupling pure simulation code to render/UI.

Quaternion order, ship forward axis, orbital hold reference, manual-rate
integration, maximum acceleration, and predictor invalidation were not yet
fixed. These semantics affect the public `Commands`/`SimSnapshot` contract even
though their TypeScript shapes do not change.

## Decision

1. Attitude uses quaternion `[x,y,z,w]`; local `+X` is the nose and thrust axis.
2. The default maximum proper acceleration is standard gravity, `9.80665 m/s²`,
   overridable at `SimulationCore` setup. Throttle is a fraction in `[0,1]`.
3. Orbital hold modes use state relative to the instantaneous maximum-gravity
   body (`argmax mu/d²`). T0057 later adds shared hysteresis and exposed
   dominant-body analysis without changing these direction definitions.
4. Automatic hold directions are evaluated at every DP54 stage. Manual
   body-frame angular rates use the exact constant-rate quaternion solution at
   each stage and commit only after a successful step. With `+X` forward, roll
   is rotation about `+X`, pitch about `+Y`, and yaw about `+Z`.
5. Proper acceleration enters `du/dt` as ADR-007 specifies. Snapshot force is
   `m*alpha` in newtons and current photon-drive power is `|F|*c` in watts.
   Ledger accumulation remains T0053.
6. `SimulationCoreOptions` accepts an optional synchronous trajectory-
   invalidation callback. Active thrust changes invoke it exactly once per
   changed command; identical commands do not. `Commands` and `SimSnapshot`
   retain their ADR-024 shapes.

## Consequences

- Prograde hold follows local orbital velocity in LEO instead of Earth's
  heliocentric velocity.
- Manual rotation remains exact for constant rates without adding quaternion
  components to DP54 or changing golden trajectory state.
- Attitude has deterministic roll suitable for later rendering and navball
  work; authored ship assets must map their nose to local `+X`.
- Predictor integration can subscribe without importing game/worker code into
  `src/sim`.
- T0052 must suppress effective throttle above its warp lockout while retaining
  the command; T0053 integrates the already exposed power over substeps.
