# T0017 Relativistic Kinematics Design

## Scope

Implement the pure special-relativistic ship kinematics defined by
`docs/physics-spec.md` sections 3, 6, 7.8, 7.9, and 7.11. The module will be
shared by `SimulationCore` and the trajectory predictor. It will not introduce
rendering, DOM, global state, or changes to `SimSnapshot` or `Commands`.

## Module boundary

Create `src/sim/ship/relativity.ts`. The module owns the seven-component ship
state layout `(rx, ry, rz, ux, uy, uz, tau)` through exported numeric indices
and a dimension constant. Callers retain ownership of every state and output
buffer.

The public API provides:

- scalar helpers for Lorentz factor, speed as a fraction of light speed, and
  relativistic kinetic energy;
- buffer-writing helpers for converting celerity to coordinate velocity and
  calculating relativistic momentum;
- a derivative factory that combines caller-supplied gravity and proper-thrust
  acceleration evaluators into a DP54-compatible derivative.

The gravity and thrust evaluators write into reusable three-component buffers
owned by the derivative workspace. Creating a derivative allocates those
buffers once. Evaluating it allocates nothing.

## Equations and data flow

For celerity `u`, the module evaluates:

```text
gamma = sqrt(1 + |u|^2 / c^2)
v = u / gamma
dr/dt = v
du/dt = g(r, t) + alpha
dtau/dt = 1 / gamma
```

Here `g` is the caller's Newtonian gravity field and `alpha` is the
caller-provided proper-acceleration vector, already resolved into the active
attitude direction. Both use km/s^2. The module does not own body lookup,
attitude, throttle, mass, or force calculation.

Momentum is `p = m*u`, equivalent to `gamma*m*v`, with mass in kilograms and
the resulting units documented as kg km/s. Kinetic energy converts the exact
light speed constant from km/s to m/s before applying
`(gamma - 1) * m * c^2`, producing joules.

## Numerical and performance behavior

All calculations use JavaScript numbers and `Float64Array` storage. Norms use
`Math.hypot` to avoid avoidable overflow in intermediate squares. Celerity is
unbounded while the derived coordinate speed remains strictly below `c` for
every finite nonzero input.

The derivative does not validate or clamp physical inputs during integration;
non-finite values remain visible to DP54's existing failure reporting. Zero
mass is accepted by the generic momentum and energy helpers because those
helpers only multiply by mass. Callers remain responsible for domain
validation at configuration boundaries.

## Verification

Add `tests/sim/ship/relativity.test.ts` with specification citations and these
independent checks:

1. Constant proper acceleration from rest reaches Lorentz factor 10 and
   matches the analytic velocity and proper-time solutions within `1e-9`
   relative error using DP54.
2. A ten-period circular LEO coast propagated through the relativistic
   derivative ends within `5e-8` relative position separation of the pure
   Newtonian propagation, accounting for the physical phase drift in ADR-012.
3. One coordinate year at constant Lorentz factor 2 integrates proper time to
   `t/2` within `1e-9` relative error.
4. Conversion helpers preserve direction, produce exact relationships between
   celerity, gamma, velocity, momentum, and energy, and keep coordinate speed
   strictly below light speed under high-celerity integration stress.
5. Gravity and thrust contributions are summed component-wise without
   allocating in the derivative evaluation path.

The full repository gates remain `npm run lint`, `npm run typecheck`,
`npm test`, `npm run build`, `npm run check:tasks`, and
`npm run check:budgets`.

## Non-goals

This task does not implement the n-body field, ship attitude modes, drive power,
energy-ledger integration, barycenter analysis, or `SimulationCore`. Those
remain in their dependent tasks.
