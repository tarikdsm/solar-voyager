# ADR-035: Attitude slew + wall-time rotation authority

**Status:** accepted (2026-08-14)

## Context

Two attitude defects were harmless in v1 because nothing rendered the ship, and
are not harmless in v2 (ADR-032 pillar 1: the ship is visible in third person).

1. **Hold modes snap.** `SimulationCore.evaluateAttitudeAndAcceleration` solved
   the commanded hold direction (ADR-025 §3) and immediately wrote
   `writeQuaternionFromForwardInto` into the published attitude. The ship *was*
   its target at every DP54 stage; a retrograde command reversed the nose in zero
   time. T0116's flip manoeuvre is a 180° slew and had no duration to render.
2. **Manual rates are sim-time rates.** `Commands.rotate` takes rad per
   *simulated* second and the exact constant-rate solution advances them over
   `timeSec − stepStartTimeSec`. At warp W the same stick deflection spins the
   ship W times faster in wall time — v1's uncontrollable high-warp tumble.

`VesselConfig.maxSlewRadPerSimS` (ADR-034 §8) was added and persisted for exactly
this task, defaulting to `0.261799 rad/s` (15°/s). ADR-034 fixed the field name,
its units, and its value; this ADR may not move them.

Three constraints shaped the design.

- **The golden trajectories are inviolable** (ADR-017, coding-standards).
- **The energy ledger's warp-invariance regression** (`energyLedger.test.ts`,
  1x over 1000 frames vs 100x over 10 frames agreeing to 1e-12) is the sharpest
  determinism instrument in the repo, and a slew that behaves differently per
  frame size is exactly the kind of change that breaks it.
- **`SimulationCore.step()` is not a fixed-step integrator.** One frame runs an
  adaptive DP54 through an ascending warp ladder: stage times are arbitrary,
  steps are rejected and retried, and a partially completed tier is rolled back
  to `checkpointShipState` (physics-spec §3.2). Any notion of "per step" is
  therefore not well defined from outside the integrator.

## Decision

1. **Hold modes pursue; they do not snap.** With the target quaternion
   `q_target(t)` unchanged from today (ADR-025 §3, physics-spec §3.0.1):

   ```
   Δt      = t − t_frame_start
   θ_err   = 2·atan2(|vec(q_rel)|, |w(q_rel)|),  q_rel = conj(q_frame_start) ⊗ ±q_target(t)
   θ_step  = min(θ_err, maxSlewRadPerSimS · Δt)
   q(t)    = slerp(q_frame_start, q_target(t), θ_step / θ_err)
   ```

   implemented as `writeSlewLimitedQuaternionInto` in `sim/ship/attitude.ts`.
   The target is sign-folded onto `dot ≥ 0` so the slew always takes the short
   way round the double cover.

2. **The budget is anchored to the frame, never to the integrator.** The v2 plan
   §3.2 says "bounded angular step per accepted integrator segment". That is
   rejected. Per-segment accumulation would make the published attitude a
   function of how the controller happened to subdivide the interval: a rejected
   step would leave permanent residue, a rolled-back warp tier would leave half a
   slew behind, and lowering the tolerance would change the flight path. Instead
   the attitude is a **pure function of `(q_frame_start, t_frame_start, t,
   state(t))`**, the same form manual body rates already use. `dtSimSec` means
   elapsed simulation time since the start of the frame, and nothing else.

3. **Thrust follows the attitude actually held**, not the target — otherwise the
   ship would accelerate in a direction it is visibly not pointing. Concretely,
   `attitudeDirection` is re-derived from the published quaternion
   (`writeForwardFromQuaternionInto`) rather than reusing the solved direction
   vector. The old code fed the solved vector straight to
   `writeProperAccelerationInto`, so thrust and the published attitude could
   differ by the normalize round trip; they are now exactly consistent, which is
   what a visible ship requires. The cost is that the thrust direction moves by
   at most that round trip against the old law — measured worst case **5.6e-8
   rad** over 5·10⁵ sampled directions, and flat across the `−X̂` neighbourhood.

4. **The converged branch copies the target verbatim.** When
   `!(θ_err > θ_step_budget)` the target quaternion is copied bit for bit rather
   than reconstructed by a unit-fraction slerp. This is load-bearing three times:

   - Where the hold converges (see the scope note below), the branch is taken at
     *every* stage and the **published quaternion** is `q_target(t)` — not an
     approximation of the pre-ADR-035 expression but literally that expression,
     bit for bit. (The *thrust direction* additionally carries decision 3's
     ≤ 5.6e-8 rad round trip; the quaternion does not.)
   - It therefore makes a converged hold exactly frame-size independent, which
     is what preserves warp invariance where warp invariance is contractual.
   - It makes the pursuit **rate-independent** once converged: `maxSlewRadPerSimS
     → ∞` reproduces the pre-ADR-035 *law* up to decision 3's round trip, which
     is how the LEO regression obtains a baseline to diff against without
     committing a new fixture. That diff isolates the slew rate, not the whole
     change — see "Scope of the pre-change equivalence" below.

   **Scope: convergence is not universal.** The claim needs
   `|dq_target/dt| < maxSlewRadPerSimS`. Every hold *direction* in the game
   rotates far below 15°/s (LEO orbital rate ≈ 1.1e-3 rad/s, four hundred times
   slower), but the zero-roll *target map* `writeQuaternionFromForwardInto` has a
   coordinate singularity at inertial `−X̂`, and its roll rate is unbounded
   there. For a hold direction passing at angular distance `ε` and rate `ω`:

   ```
   |dq_target/dt| ≈ 2ω/ε   ⇒  the copy branch is lost for ε < 2ω / maxSlewRadPerSimS
   ```

   At the LEO rate that is `ε ≈ 8.6e-3 rad ≈ 0.5°`. Measured against the shipped
   function: 0.0225 rad/s at `ε = 0.1` (9% of the limit), 0.0754 at `0.03` (29%),
   0.2262 at `0.01` (86%), 0.7540 at `0.003` (288%). Inside that neighbourhood
   the hold lags and the published quaternion is frame-size dependent at high
   warp.

   This breaks no contract: only the *roll* component runs away, as `O(ω/ε)`.
   The heading component stays `O(ω)` and bounded, so `û`, thrust, the ledger and
   the trajectory are unaffected — the lag is almost pure roll, and what notices
   it is the rendered roll and any *convergence predicate*.

   **Dwelling and transiting are different failures, and only one is a failure.**
   A hold target that *dwells* inside the neighbourhood — a target body held near
   inertial `−X̂`, a station-keeping hold there — never clears its roll error, so
   a quaternion-separation predicate never fires: that is an indefinite hang. A
   target merely *transiting* the neighbourhood, which is the ordinary case for
   an orbiting reference sweeping through, produces a bounded, self-resolving
   transient: roll error accumulates for the crossing and then unwinds at the
   full 15°/s once the target's roll rate drops back under the limit. A transit
   is not something to design around.

   Scoped rather than fixed because fixing it means replacing the zero-roll
   target map, which is ADR-025 §4 contract surface and would move the navball
   and every restored attitude. See the handoff note in Consequences.

   The `!(x > y)` spelling routes `θ_err === 0` to the copy branch instead of
   through a zero division. A non-positive or non-finite budget is treated as
   zero, holding the current attitude.

5. **The rate comes from the vessel in force, not from `DEFAULT_VESSEL`.**
   `SimulationCore` caches `this.vessel.maxSlewRadPerSimS` at construction, and
   `this.vessel` is the *persisted* vessel after a restore (ADR-034 §4). A saved
   session flown with a non-default slew rate resumes at that rate.

6. **`MANUAL_ATTITUDE_MAX_WARP = 100`, exported from `core/time.ts`**, beside
   `MAX_THRUST_WARP`. `Commands.rotate` forces rates to zero above it, and
   `Commands.setWarp` clears rates already commanded when it crosses it.
   Clearing on `setWarp` is not optional: the v1 tumble is caused by rates
   commanded *before* a warp increase surviving it, so a lockout that only
   filtered new commands would be decorative.

   **Rejected, not thrown.** The task's acceptance wording is "rejected by
   `Commands` validation", and the chosen reading is the one `setThrottle`
   already implements for `MAX_THRUST_WARP`: an out-of-range *value* throws
   (`rotate` still throws on non-finite input), but a *regime* lockout silently
   forces the commanded quantity to zero. T0108's `FlightController` calls
   `rotate` every frame from live input; a throw on that path is a crash, not a
   validation. Both classes are covered by tests.

7. **The wall-time normalization stays in the game layer.**
   `rateSimRadS = clamp(inputRateWallRadS / effectiveWarp, ±0.6)` is T0108's
   job (plan §3.1). The sim owns the constant, the lockout, and the documented
   contract in physics-spec §3.0.1 — nothing more, because the sim has no wall
   clock and must not acquire one.

8. **No `SimSnapshot` or `Commands` shape change.** Surfacing "rotation locked"
   in the HUD is T0112's decision and would need its own ADR; the state is
   derivable from `effectiveWarp` today.

## Warp invariance — precisely what holds

Stated exactly, because "warp-invariant" is doing real work here.

- **The ledger is invariant unconditionally, for any attitude path.**
  `writeLedgerDerivativeRates` integrates `dE/dt = m·|α|·c` and
  `dΔv/dt = |α|/γ`, and `|α| = f·α_max` is a magnitude that does not contain the
  attitude. `energySpentJ` and `properDeltaVMS` cannot be moved by this change.
  The existing 1x/100x regression additionally never leaves manual mode with zero
  rates, so it does not even reach the changed code. Its 1e-12 tolerance is
  untouched, and a new hold-mode counterpart at the same 1e-12 was added.
- **A converged hold is invariant exactly** (decision 4).
- **The slew transient is not exactly invariant**, at `O(ω_target·Δt_frame)` per
  frame, for the handful of frames a transient lasts. This is irreducible: the
  continuous law "rotate toward a moving target at a bounded rate" has no closed
  form, so every discretization of it is frame-dependent while pursuing.

  The alternative that *would* be exactly invariant — anchoring the budget to the
  mode-engagement time rather than the frame — was rejected: the accumulated
  budget grows without bound, so any discontinuity in the target (a
  dominant-body/SOI change, a retarget, a mode flip after a long hold) would be
  followed instantly. Removing that snap is the entire point of the task.

  Nothing in the repo's warp-invariance contract (physics-spec §3.2 and §5,
  ADR-026) covers attitude transients; it covers coordinate-time advance and the
  energy ledger, both of which remain exact. A slew is a rendered manoeuvre, not
  a conserved quantity.

## Corrected acceptance arithmetic

The v2 plan §3.2 and the T0107 acceptance list both state "at warp ≥ 5x a full
180° flip completes in ≤ 0.24 / 0.25 s wall". With the ADR-034 contract rate that
is impossible, and the two clauses contradict each other:

```
180° flip = π / 0.261799 = 12.000 s of SIMULATION time, at every warp tier
wall time = 12.000 s / warp   ⇒  12.0 s at 1x, 2.40 s at 5x, 0.240 s at 50x
```

0.24 s is the **50x** figure; the plan lost a factor of ten. Reaching 0.25 s at
5x would require 2.51 rad/s (144°/s), contradicting the same sentence's "visible
15°/s slew at 1x". The rate is not changed to chase the typo. The regression
asserts the whole table — the 12 s sim-time cost at 1x, 5x and 50x, the
`wall = sim / warp` identity, ≤ 2.5 s wall at 5x, and ≤ 0.25 s wall at 50x — so
both published figures are verified at the tier where each is true.

## Tests whose expectations changed

Exactly one existing expectation changed. It is listed with what it was
checking and why the change preserves that.

| Test | Change | Why the original meaning is preserved |
|---|---|---|
| `src/sim/energyLedger.test.ts` — *"prices the analytic impulsive Hohmann LEO-to-GEO proper delta-v within 1%"* | Inserted a zero-throttle alignment coast of `π/2 / maxSlewRadPerSimS + 1 ≈ 7.0 s` between `setAttitudeMode('prograde')` and `setThrottle(1)`. **No tolerance was touched.** | The test verifies that a two-burn Hohmann transfer priced by `SimulationCore` reproduces the analytic Δv, the analytic energy, and a GEO apogee (physics-spec §7.7/§7.10). It never intended to verify attitude. The ship starts nose-radial, 90° off prograde, and the first burn is only 2.43 s long — under the new law it burned 53.7° off-axis and the apogee error was 78%. Coasting until the hold converges is what "impulsive prograde burn" means for a ship that has to turn first. Once converged the published quaternion is bit-identical to the pre-change snap and the thrust direction differs by at most decision 3's 5.6e-8 rad, six orders below the 1% bounds asserted here; so the burn, the ledger arithmetic, and every asserted number are unchanged, and only the epoch of the manoeuvre shifts by 7 s on a rotationally symmetric circular orbit. |

Expectations deliberately **not** changed, having been checked to still hold for
their original reason:

- `energyLedger.test.ts` warp-invariance 1x/100x at 1e-12 — untouched; manual
  mode, and direction-independent quantities regardless.
- `energyLedger.test.ts` continuous 90° turn — manual body rates, not a hold.
- `simulation.test.ts` *"keeps prograde hold tangent…"* — the frame is a quarter
  orbit, so the budget covers the 90° error hundreds of times over and the
  published endpoint attitude is still exactly prograde at `1 − 1e-12`.
- `simulation.test.ts` *"publishes proper acceleration, thrust, and photon-drive
  power"* — every asserted quantity is a magnitude (`|α|`, `|F|`, `P`, `E`), and
  the 10 s horizon converges the 90° slew at 6 s.
- `simulation.test.ts` *"keeps equivalent physical horizons stable across warp
  changes"* — both cores are single frames with the same anchor and endpoint, so
  they evaluate the same attitude function of `t`; still agrees to 7 places.
- `simulation.test.ts` / `sessionController.test.ts` save-restore equality — a
  restored hold now resumes from the persisted quaternion (budget `Δt = 0`)
  instead of re-snapping to the target, which is strictly more faithful to the
  saved document; both sides of every comparison move together.
- `simulationSnapshot.test.ts` *"retains validated intent…"* — sets warp to
  exactly 100, which is not *above* `MANUAL_ATTITUDE_MAX_WARP`, so rates survive.
- `tests/golden/*` — see below.

## Consequences

- **Goldens are byte-identical**, verified with `git diff -- tests/golden/`, not
  by eye. Structurally they cannot move: the harness drives
  `createRelativisticDerivative` directly with a hardcoded zero
  proper-acceleration evaluator and never constructs `SimulationCore`, so no
  attitude code is reachable from it (same argument as ADR-034 §7).
- Autopilot manoeuvres now take time. Any future code that engages a hold and
  immediately expects to be pointing there must wait `θ/maxSlewRadPerSimS` — the
  Hohmann regression is the first instance and will not be the last. T0114/T0116
  must budget the slew into their profiles; the flip leg already does.
- `SimulationCore` gains one preallocated `Float64Array(4)` at construction and
  one cached scalar. Frame-loop allocation stays zero and `bench:sim`
  `averageStepMs` moves 0.0809 → 0.0813 (+0.5%, inside run-to-run noise; budget
  is 2 ms).
- Roll unwinds along the same geodesic as heading, because
  `writeQuaternionFromForwardInto` returns the zero-roll quaternion. That is a
  consequence of the pre-existing target definition, not a new decision.
- A restored session honours its own slew rate, so vessel presets remain a
  purely additive future change.
- Manual rotation is unavailable above 100x. This is a deliberate capability
  reduction, acceptable only because all seven hold modes remain available
  there; if a later task needs fine attitude control at 1e3x it needs a new
  mechanism, not a raised constant.
- The v2 plan's §3.2 prose and the T0107 acceptance entry were corrected in the
  same PR, per plan §2's rule that a deviating agent updates the plan file. A
  reader who never opens `docs/decisions/` would otherwise still find the
  impossible 5x / 0.24 s figure, and T0114/T0116 are specified from that section.
- `quaternionSeparationRad` is exported with no production consumer today. It is
  kept, not inlined, because it is the natural "am I aligned yet?" predicate that
  T0116's `align` phase needs and T0114's flip leg will want, and because the
  slew function's correctness is only testable against an independent angle
  measurement. If V2M2 closes without either consumer, delete it.

### Handoff notes for T0108 / T0114 / T0116

- **`rotate`'s lockout keys on `requestedWarp`, not `effectiveWarp`.** Deliberate:
  command validation must be a pure function of commanded intent, not of an
  integrator outcome that is only known after `step()`. The consequence is that
  when the governor has clamped a requested 1e4x down to, say, 10x, manual
  rotation stays locked even though the simulation is running at a tier where it
  would be usable. `FlightController` should therefore gate its UI affordance on
  `requestedWarp` too, or the lock will look broken.
- **The `align` phase can fail to converge near inertial `−X̂`.** Per decision 4,
  within `ε < 2ω / maxSlewRadPerSimS` of the target map's singularity (≈ 0.5° at
  LEO rates) the zero-roll target's roll rate exceeds the slew limit and the hold
  lags in roll. A cruise director that waits for
  `quaternionSeparationRad(attitude, target) < tol` before advancing phase **will
  hang there if the target dwells inside the neighbourhood**; if the target
  merely transits it, the predicate is late by the crossing but recovers on its
  own. Gate on the *forward direction* — `dot(forward, targetDirection)` — which
  is convergent in both cases because the heading component stays bounded by `ω`,
  and which is what the thrust profile actually cares about. Do not raise the
  phase tolerance to paper over it: that trades a hang for a phase advance taken
  before the ship is pointing anywhere in particular.

## Alternatives considered

- **Accumulate the slew per accepted integrator step** (the literal plan
  wording). Rejected: makes the published attitude depend on rejected steps,
  warp-ladder rollback, and tolerance — the sim would stop being reproducible.
- **Anchor the budget at mode engagement.** Exactly warp-invariant, and
  rejected anyway: the budget grows without bound, so the first discontinuous
  target after a long hold snaps instantly, reintroducing the defect.
- **Freeze `q_target` at the frame start.** Cheaper, and strictly worse: the
  target is held stale for the whole frame, so the error grows with frame size —
  precisely the wrong direction at high warp.
- **Integrate the attitude inside the DP54 state.** Rejected: it expands the
  seven-component state that ADR-025 §4 and ADR-002 deliberately keep closed, it
  would move golden trajectory state, and error control on a quaternion has no
  physical tolerance to cite.
- **Throw from `rotate` above the warp ceiling.** Rejected: the per-frame input
  path would crash instead of degrading, and it would diverge from the
  `setThrottle` lockout precedent for no gain.
- **Raise `maxSlewRadPerSimS` so a 180° flip fits in 0.25 s wall at 5x.**
  Rejected: it needs 144°/s, contradicting both the plan's own "visible 15°/s at
  1x" and the ADR-034 contract value. The arithmetic error is corrected in this
  ADR instead.
- **Loosen the ledger warp-invariance tolerance.** Never required; the test does
  not reach the changed code and the quantities it compares are
  direction-independent.
</content>
