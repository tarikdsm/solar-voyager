# Attitude slew + wall-time rotation authority — per-task design (T0107)

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §4.2, §12.2.
Plan: `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §3.1, §3.2, §T0107.
Decision record: `docs/decisions/ADR-035-attitude-slew.md` (same PR).
Depends on: T0104 (`VesselConfig.maxSlewRadPerSimS`).

## Problem

Two defects, both invisible in v1 because nothing rendered the ship.

1. **Hold modes snap.** `SimulationCore.evaluateAttitudeAndAcceleration` solves the
   commanded hold direction and calls `writeQuaternionFromForwardInto` — the
   attitude *is* the target, at every DP54 stage, with no dynamics in between.
   Engaging retrograde reverses the nose in zero time. With a third-person ship
   (T0109/T0110) that is unacceptable, and T0116's flip manoeuvre has no duration
   to render.
2. **Manual rates are integrated in sim time.** `commands.rotate()` takes rad per
   *simulated* second and `evaluateBodyRateQuaternionInto` advances them over
   `timeSec - stepStartTimeSec`. At warp W a stick deflection therefore spins the
   ship W times faster in wall time. At 1e4x the ship tumbles uncontrollably.

## Decision summary

- Hold modes pursue the solved direction along the shortest-path geodesic at
  `vessel.maxSlewRadPerSimS`, anchored at the **frame-start attitude and
  frame-start simulation time**. Thrust follows the *actual* attitude, never the
  target.
- The pursuit degenerates **exactly** to the old snap once the target is inside
  the step budget — the converged branch copies the target quaternion verbatim,
  bit for bit.
- `MANUAL_ATTITUDE_MAX_WARP = 100` is exported from `core/time.ts`. Above it,
  `Commands` forces manual rotation rates to zero, mirroring the existing
  `MAX_THRUST_WARP` throttle lockout. The wall-time *normalization*
  (`inputRateWallRadS / effectiveWarp`) belongs to T0108's `FlightController`;
  the sim owns only the constant, the lockout, and the documented contract.

## 1. The slew law (plan §3.2)

```
θ_err  = angle(q_frameStart, q_target(t))          # shortest path, ∈ [0, π]
θ_step = min(θ_err, maxSlewRadPerSimS · (t − t_frameStart))
q(t)   = slerp(q_frameStart, q_target(t), θ_step / θ_err)
```

`q_target(t)` is `writeQuaternionFromForwardInto(writeAttitudeDirectionInto(…))`
evaluated at the stage time `t` and the stage state — unchanged from today. Only
the last line is new.

### Why the anchor is the frame, not the integrator step

Plan §3.2 says "bounded angular step per accepted integrator segment". Taken
literally that is wrong, and the design deliberately deviates.

`SimulationCore.step()` runs an adaptive DP54 through a warp ladder. Within one
frame the derivative is evaluated at arbitrary stage times; steps are **rejected
and retried**; a partially completed warp tier is **rolled back** to
`checkpointShipState`. If the slew accumulated per evaluation, or per accepted
step, the published attitude would depend on how the controller happened to
subdivide the interval — two runs over the same physical horizon with different
tolerances would disagree, and a rejected step would leave permanent residue.

So the attitude is a **pure function of `(q_frameStart, t_frameStart, t,
state(t))`** with no hidden accumulator, exactly as manual body rates already are
(`evaluateBodyRateQuaternionInto` uses the same `timeSec − stepStartTimeSec`
form). Rejected steps cost nothing; rollback is automatic; re-evaluating any
stage yields the same quaternion. `dtSimSec` means *elapsed simulation time since
the start of this frame*, and nothing else.

### The converged branch is bit-identical to the old snap

```
if (!(θ_err > θ_step_budget)) out.set(q_target)   // verbatim copy, no slerp arithmetic
```

Copying rather than evaluating `slerp(·, ·, 1)` matters three times over:

1. **Steady-state hold is unchanged code-for-code.** Once a hold has converged,
   `q_frameStart = q_target(t_frameStart)`, so within the next frame
   `θ_err(t) ≈ ω_target·(t − t_frameStart)` while the budget is
   `0.261799·(t − t_frameStart)`. Every hold reference in the game rotates far
   slower than 15°/s (LEO orbital rate ≈ 1.1e-3 rad/s, four hundred times
   slower), so the branch is taken at *every* stage and `q(t) = q_target(t)` —
   literally the pre-change expression. A converged hold is not an approximation
   of the old behaviour; it *is* the old behaviour.
2. **It makes the transient's frame dependence the only frame dependence**
   (§2 below).
3. **`maxSlewRadPerSimS → ∞` reproduces the pre-change law exactly**, which is
   how the LEO regression gets a baseline to diff against without committing a
   new fixture (§4).

`!(θ_err > budget)` rather than `θ_err <= budget` so that `θ_err === 0` (and any
NaN that ever reached here) takes the copy branch instead of dividing by zero.

### Numerics

Shortest path first: if `dot(q_current, q_target) < 0` the target is negated for
the geodesic computation, so a slew never takes the long way round the double
cover. The relative quaternion `q_rel = conj(q_current) ⊗ ±q_target` then has
`w ≥ 0`, and

```
θ_err = 2·atan2(|q_rel.xyz|, q_rel.w)
```

`atan2` rather than `2·acos(|dot|)`: `acos` loses half its significant digits as
its argument approaches 1, which is precisely the regime a converged hold lives
in. The step is applied as an axis-angle composition
`q_next = normalize(q_current ⊗ [axis·sin(θ_step/2), cos(θ_step/2)])` reusing the
axis already in `q_rel.xyz`; that avoids the `1/sin θ` blow-up of the textbook
slerp formula near `θ_err → 0`, and `sinHalf > 0` is guaranteed because
`θ_err = 0` was already routed to the copy branch.

All scalars; no allocation; the one new buffer is a preallocated
`targetAttitudeQuaternion` on `SimulationCore`.

### Roll

`writeQuaternionFromForwardInto` returns the minimum-rotation, zero-roll
quaternion. Today a hold snaps roll to zero along with heading. Under the slew,
roll unwinds along the same geodesic over the same interval. That is a
consequence of the existing target definition, not a new decision.

## 2. Warp invariance — what is exact and what is not

This is the load-bearing property, so it is stated precisely rather than
asserted.

**Exactly invariant, unconditionally:** the two quantities the ledger publishes
as warp-invariant. `writeLedgerDerivativeRates` computes

```
dE/dt  = m·|α|·c          dΔv/dt = |α|/γ
```

and `|α| = f·α_max` is a **magnitude** — it does not contain the attitude at all.
`energySpentJ` and `properDeltaVMS` are therefore invariant to any attitude path
whatsoever, before and after this change. `src/sim/energyLedger.test.ts`'s
1x/100x case (1000 frames vs 10 frames, 1e-12) additionally never leaves manual
mode with zero rates, so it does not touch the changed code path at all. It is
unaffected twice over, and its tolerance is not touched.

**Exactly invariant:** a converged hold. Per §1, both a 1x and a 100x run
evaluate `q(t) = q_target(t, state(t))` at every stage, which is a function of
simulation time and state alone. Frame boundaries are invisible.

**Not exactly invariant: the slew transient itself.** While `θ_err > budget` the
attitude is a geodesic from `q_frameStart` toward a target that is itself moving,
so the path depends on where the frame boundaries fall, at
`O(ω_target · Δt_frame)` per frame — about 2e-3 rad per frame at warp 100 in LEO,
1.8e-5 rad at 1x, for the handful of frames a transient lasts.

This is irreducible, and the ADR records why: the continuous-time law
"rotate toward a moving target at a bounded rate" has no closed form, so *any*
discretization is frame-dependent during pursuit. The one law that would be
exactly frame-independent — anchoring the budget to the mode-engagement time
instead of the frame — was rejected because the accumulated budget grows without
bound, so a discontinuous target (a dominant-body/SOI change, a retarget) would
snap instantly. Eliminating that snap is the entire point of the task.

Nothing in the repo's warp-invariance contract (physics-spec §3.2, §5;
ADR-026) covers attitude transients. It covers coordinate-time advance and the
energy ledger, both of which stay exact. A slew is a rendered manoeuvre, not a
conserved quantity.

## 3. Wall-time rotation authority (plan §3.1)

```
MANUAL_ATTITUDE_MAX_WARP = 100          // core/time.ts, beside MAX_THRUST_WARP
```

`Commands` gains a lockout that mirrors the throttle lockout already in the same
class, because the failure mode is the same shape:

- `rotate(p, y, r)` above the ceiling stores **zeros**, exactly as `setThrottle`
  above `MAX_THRUST_WARP` stores zero rather than the requested fraction.
  Silent clamping, not a throw: `FlightController` will call `rotate` every
  frame, and a throw on a routine input path is not a validation strategy.
  Non-finite input still throws — that is a programming error, not a regime.
- `setWarp(w)` above the ceiling zeroes any rates already commanded, exactly as
  it already zeroes throttle. Without this the lockout is decorative: the v1
  tumble is caused by *existing* rates surviving a warp increase.
- Both paths fire `onTrajectoryInvalidated` at most once per call, and only when
  the change can actually alter the predicted trajectory (throttle > 0, manual
  mode) — the existing no-duplicate-events contract (ADR-025 §6) is preserved.

Hold modes are untouched by the lockout: above 100x the player still has all
seven automatic modes, which is what makes locking manual rotation acceptable.

`SimSnapshot` gains **no field**. Surfacing "rotation locked" in the HUD is
T0112's call and would require an ADR-gated snapshot change; the information is
derivable from `effectiveWarp` today.

## 4. Wall-clock timings

`maxSlewRadPerSimS` is per **simulated** second (ADR-034 fixed the name and the
value 0.261799 = 15°/s; this task may not move either). A 180° reorientation is
therefore `π / 0.261799 = 12.000 s` of simulation time at any warp, and

```
wall time = 12.000 s / warp
```

| warp | wall time for 180° |
|---|---|
| 1x | 12.00 s |
| 5x | 2.400 s |
| 50x | 0.240 s |
| 100x | 0.120 s |

**Discrepancy recorded, not silently resolved.** Plan §3.2 and the T0107
acceptance list both state "at warp ≥ 5x a full 180° flip completes in ≤ 0.24 /
0.25 s wall". With the contract constant that is arithmetically impossible —
0.24 s is the warp **50x** figure, and reaching 0.25 s at 5x would need
2.51 rad/s (144°/s), contradicting the same sentence's "visible 15°/s slew at
1x". The plan's "5x" is a lost factor of ten. The tests assert the *whole*
table above, so both the 12 s sim-time figure and the ≤ 0.25 s wall figure are
verified at the tier where each is true, and the ADR carries the correction.

## 5. Files

| File | Change |
|---|---|
| `src/sim/ship/attitude.ts` | NEW `quaternionSeparationRad`, `writeSlewLimitedQuaternionInto` |
| `src/sim/ship/attitude.test.ts` | slerp step vs analytic, shortest path, converged copy, degenerate cases |
| `src/sim/simulation.ts` | hold branch pursues instead of snapping; thrust follows actual attitude; axis-remap comment |
| `src/sim/simulation.test.ts` | slew-behaviour cases; revised expectations (enumerated in ADR-035) |
| `src/core/time.ts` | NEW `MANUAL_ATTITUDE_MAX_WARP` |
| `src/core/time.test.ts` | constant + ladder-membership assertions |
| `src/sim/simulationSnapshot.ts` | `rotate`/`setWarp` manual-rotation lockout |
| `src/sim/simulationSnapshot.test.ts` | lockout cases |
| `docs/physics-spec.md` §3.0.1 | slew law + manual warp authority |
| `docs/decisions/ADR-035-attitude-slew.md` | NEW |

`tests/golden/*.json` are **structurally unaffected** and must stay
byte-identical: the harness drives `createRelativisticDerivative` directly with a
hardcoded zero proper-acceleration evaluator and never constructs
`SimulationCore`, so no attitude code is reachable from it (same argument as
ADR-034 §7, re-verified here rather than assumed).

## 6. Verification

1. Unit: a 90° target with a 30° budget lands at exactly 30°, on the great
   circle; budget ≥ θ_err copies the target array bit for bit; a budget of 0
   returns the current attitude; the shortest path is taken for `dot < 0`.
2. Convergence at 1x equals `θ_err / maxSlewRadPerSimS` within one frame.
3. The full wall-clock table of §4 at 1x / 5x / 50x.
4. `maxSlewRadPerSimS = 1e9` reproduces the pre-change snap: a LEO prograde-hold
   burn diffs against it under 1e-3 km over one orbit once converged.
5. Hold-mode ledger invariance 1x vs 100x at 1e-12 (energy and proper Δv), plus
   the unchanged manual-mode case.
6. Lockout: rates rejected above 100x, retained at 100x, zeroed by a warp
   increase, holds unaffected.
7. `npm run bench:sim` before/after; goldens byte-identical via `git diff`.
</content>
</invoke>
