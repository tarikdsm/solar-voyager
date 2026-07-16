# T0014 N-body Gravity Field Design

## Goal and scope

Implement the Newtonian gravitational acceleration that the relativistic ship
feels from every body in the rails catalog. The pure TypeScript function is
shared by the main simulation and predictor worker and implements
physics-spec.md section 3 exactly:

`g(r) = sum_i μ_i (r_i - r) / |r_i - r|^3`.

Body positions are already evaluated for the requested time by T0013. This
module does not evaluate rails, apply thrust or relativistic transforms,
integrate state, soften gravity, detect impacts, or model mutual body forces.

## API and ownership

`src/sim/propagation/nbodyForces.ts` exports:

```ts
evaluateNBodyAccelerationInto(
  outputAccelerationKmS2: Float64Array,
  pointPositionKm: Float64Array,
  bodyMuKm3S2: Float64Array,
  bodyPositionsKm: Float64Array,
): Float64Array
```

The point array may be the seven-component DP54 ship state because only its
first XYZ components are read. The output requires at least three components.
Body positions use the T0013 packed XYZ layout (`bodyIndex * 3`) and must have
exactly three times as many components as the GM array. The function returns
the caller-owned output and permits output to alias the point because point XYZ
is copied to local scalars before any write.

Array shape validation happens before the hot loop. Invalid shapes throw
descriptive setup/programming errors. Empty body arrays are valid and write
zero acceleration.

## Numerical algorithm

For each body, compute the relative vector from the evaluation point to the
body, squared distance, inverse distance cubed, and three acceleration terms.
All inputs and accumulators are binary64 numbers. Three scalar Kahan compensated
sums reduce cancellation error near equilibrium points such as Earth-Sun L1
without allocating scratch arrays.

The valid call path contains only indexed loops, scalar locals, `Math.sqrt`, and
final writes. It creates no arrays, objects, closures, or callbacks.

No gravitational softening is applied: it would change the section-3 formula
and corrupt close approaches. At an exact body center the point-mass field is
undefined; the function writes `NaN` to all three output components and returns.
Impact detection and collision handling in later tasks must prevent integration
through body centers.

## L1 verification model

The production function remains inertial. The Earth-Sun L1 acceptance test
constructs an ideal circular two-body system in barycentric rotating
coordinates:

- separation `a` from Earth's J2026 semimajor axis;
- `n^2 = (μ_sun + μ_earth) / a^3`;
- barycentric Sun/Earth x positions from their GM ratios;
- an independently evaluated scalar root of
  `g_x(x) + n^2 x = 0` between the bodies.

At that independently solved L1 coordinate, the production n-body acceleration
plus centrifugal acceleration must have normalized residual below the exact
tolerance added to physics-spec.md section 7 by ADR-016. Coriolis acceleration
is zero for a stationary rotating-frame test point.

## Verification

- A single-body analytic test checks direction and inverse-square magnitude to
  the physics-spec.md section-7 relative tolerance.
- Tests cover vector direction in 3D, linear superposition/cancellation, empty
  fields, caller-owned output identity and aliasing, singular-center `NaN`, and
  invalid array shapes.
- The Earth-Sun rotating-frame regression verifies the L1 normalized residual
  and its expected location between Sun and Earth.
- Static inspection confirms zero valid-path allocations and no imports outside
  `core`/`sim` layering.
- Full lint, typecheck, test, format, build, task-schema, and budget gates run
  before independent review.
