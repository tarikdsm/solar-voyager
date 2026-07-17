# T0051 Ship Thrust and Attitude Design

## Scope

Connect the existing `Commands` intent state to relativistic propulsion and
attitude behavior without changing the seven-component `(r,u,tau)` integration
state or the ADR-024 snapshot shape. T0051 implements throttle, manual angular
rates, prograde/retrograde/normal/antinormal/radial/target hold directions,
current thrust/power snapshot values, and synchronous trajectory invalidation
when a command changes active thrust.

Energy accumulation and burn history remain T0053. Warp lockout and clamp
policy remain T0052. Dominant-body hysteresis and osculating rendering remain
T0057.

## Configuration and conventions

`SimulationCoreOptions` gains optional `maxProperAccelerationMS2`, defaulting
to standard gravity `9.80665 m/s²`. Rest mass remains the existing positive
`shipMassKg`. Simulation calculations convert acceleration once to km/s².

Attitude quaternion storage is `[x,y,z,w]`. It rotates the ship-local `+X`
nose/drive axis into the inertial ecliptic frame. Hold modes choose only a
forward direction; the minimum rotation from `+X` fixes roll deterministically.
The antiparallel case uses a 180-degree rotation about local `+Z`.

## Reference frame and hold modes

At every derivative evaluation, the attitude evaluator selects the body with
maximum instantaneous `mu/|r-r_i|²`. This reuses the dominant-body formula from
`physics-spec.md` section 6 without claiming T0057's SOI hysteresis or exposed
dominant-body state.

Relative position and velocity are computed against that reference body:

- prograde / retrograde: `±normalize(v-v_body)`;
- radial out / in: `±normalize(r-r_body)`;
- normal / antinormal: `±normalize((r-r_body) × (v-v_body))`;
- target: `normalize(r_target-r)` when a valid target exists;
- manual: current quaternion's local `+X` direction.

Degenerate automatic directions retain the previous forward direction. This
keeps every output finite at zero relative velocity or collinear states.

## Manual rotation

`Commands.rotate(pitch,yaw,roll)` stores body-frame angular rates in rad/s.
During a `step`, the starting quaternion and rates stay fixed. Each DP54 stage
evaluates the exact constant-body-rate solution
`q(t)=normalize(q0 * axisAngle(omega, |omega|*(t-t0)))`; the successful endpoint
becomes the next private attitude. A failed propagation does not publish or
commit a partial attitude.

Automatic hold modes derive their direction at every DP54 stage from that
stage's ship and rails state, so prograde hold follows a curved orbit rather
than freezing the frame-start tangent.

## Thrust and snapshot data

For throttle `f` and maximum proper acceleration `alphaMax`:

```text
alpha = f * alphaMax
du/dt = g + alpha * forward
F_N = m_kg * alpha_m/s²
P_W = |F_N| * c_m/s
```

The proper-acceleration vector enters `createRelativisticDerivative` directly.
At the published endpoint the same evaluator fills attitude, proper
acceleration, thrust-vector newtons, and power watts. No ledger total changes in
this task.

## Predictor invalidation

`SimulationCoreOptions.onTrajectoryInvalidated` is an optional stable callback.
The command controller calls it synchronously when throttle changes. While
throttle is nonzero, changes to attitude mode, manual rates, or a target used by
target hold also call it. Repeating an identical command does not. This event
path allocates nothing and does not change `Commands` or `SimSnapshot`.

## Performance and failure behavior

All derivative-stage attitude/thrust work writes into preallocated Float64Array
scratch. There are no frame-loop arrays, objects, closures, strings, or Date
instances. Configuration and callback validation happen during setup or command
invocation. Integration failure leaves the private ship state, attitude, clock,
and published snapshot unchanged.

## Verification

Tests will prove:

1. quaternion forward-axis mapping and exact constant-rate manual rotation;
2. every hold mode and finite degeneracy fallback;
3. prograde thrust remains tangent through a propagated circular orbit;
4. parallel coordinate acceleration at gamma 2 equals `alpha/gamma³`;
5. force and photon-drive power use correct SI conversions;
6. active-thrust command changes invalidate once, identical/no-thrust changes do
   not, and a failed step does not commit attitude;
7. the frame loop still reuses exactly two snapshots and retains no heap growth.

