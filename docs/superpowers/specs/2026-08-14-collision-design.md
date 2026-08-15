# Surface collision, restore points, respawn — per-task design (T0111)

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §4.4.
Plan: `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §2, §3.4, §T0111.
Decision record: `docs/decisions/ADR-036-collision.md` (same PR).
Depends on: T0104 (`VesselConfig`).

## Problem

The ship flies through planets. `trajectoryPredictor` raises an `Impact` event and
`TrajectoryImpactWarning` renders "collision course", and then the ship passes
through the body and out the other side. Two consequences:

1. v2's scope decision is "no landing, but low flybys ARE a supported experience"
   (ADR-032). A supported low pass needs a floor; without one there is no
   difference between a 50 km pass and a pass through the core.
2. `evaluateNBodyAccelerationInto` divides by `|r − rᵢ|³`. At a body's exact
   centre that is `0/0`; the ship state goes NaN and every downstream consumer
   (osculating elements, navball, HUD, renderer) goes with it.

The predictor's detection cannot be reused as-is for two reasons. It is
**thrust-free** by construction (`predictThrustFreeTrajectory` hardcodes a zero
proper-acceleration evaluator), so a powered descent is invisible to it; and it
runs in a worker against a *forecast*, not against the state the sim actually
integrated.

## Decision summary

- Collision is detected in `SimulationCore`, per **accepted DP54 step**, against
  **every** catalog body, using a two-stage test: a cheap conservative chord test
  reusing `trajectoryImpact.smallestUnitRoot`, then a confirmation pass against
  genuinely propagated states, bisected to ≤ 1 ms of simulation time.
- On a confirmed contact the integrator **freezes**: `step()` becomes a no-op,
  warp is forced to 1×, throttle is forced to 0, and the snapshot carries the
  four new impact fields.
- Recovery is a **game-layer** concern and reuses the existing save-load
  replacement path, so a restored or respawned core is validated by exactly the
  rules `copyAndValidateSimulationPersistentState` applies to a loaded save.
- `data/bodies.json` gains `surface.atmosphereTopKm` for the four giants only.

## 1. Collision radius (data)

The runtime contract already exists and is not changed:

```
radius_col(body) = meanRadiusKm + (surface.atmosphereTopKm ?? 0)
```

(`predictorWorkerRuntime.ts`, physics-spec §6.) `atmosphereTopKm` is an
**altitude above the mean radius**, not an absolute radius — a distinction that
matters because the plan's shorthand "Jupiter 71492+5000" reads as an absolute
radius and cannot be entered literally. Jupiter's catalog `meanRadiusKm`
(69,911 km) is *already* the 1-bar volumetric mean radius, so "+5000" against it
would be a second, undocumented margin on top of the one the mean radius already
encodes.

**The rule adopted instead:** the collision sphere is the *smallest sphere that
contains the body's 1-bar oblate spheroid*, i.e. its **equatorial radius at
1 bar**. For a sphere that is the only choice that guarantees the ship stops at
or above the 1-bar level *everywhere*, including over the equator, where the
1-bar level sits above the volumetric mean. A mean-radius sphere would let an
equatorial pass descend 1,581 km below Jupiter's 1-bar level before contact.

```
atmosphereTopKm = equatorialRadius(1 bar) − meanRadiusKm
```

| Body | mean (km) | equatorial @ 1 bar (km) | `atmosphereTopKm` |
|---|---|---|---|
| Jupiter | 69,911 | 71,492 | **1,581** |
| Saturn | 58,232 | 60,268 | **2,036** |
| Uranus | 25,362 | 25,559 | **197** |
| Neptune | 24,622 | 24,764 | **142** |

Sources are per-body NASA planetary fact sheets, cited individually in ADR-036.
Terrestrial bodies keep `atmosphereTopKm: null`: their catalogued mean radius is
already a solid surface, and adding an atmospheric shell would make "collision"
mean "entry interface", which is a different feature (T0140's atmosphere
contract) with different UX.

A 5,000 km cloud-top margin was considered and rejected: on Neptune it would put
contact at 1.2 body radii, which removes the low pass the feature exists to
support.

`tools/bake_ephemerides.py` carries the values in `BODY_DEFINITIONS` so a
re-bake reproduces them. Hand-editing `bodies.json` alone would be silently
reverted by the next `python tools/bake_ephemerides.py`.

## 2. Where the test runs

`SimulationCore.step()` runs an adaptive DP54 through an **ascending warp-tier
ladder**. The structure matters, so it is stated exactly:

```
for warpIndex 0..requestedWarpIndex:
    candidateTime = frameStart + wallDelta · WARP_LADDER[warpIndex]
    propagate(next, checkpoint, segmentStart, candidateTime, …)
    if reachedEnd: checkpoint ← next; segmentStart ← candidateTime; completedWarp ← candidate
```

Each tier **continues forward** from the previous tier's endpoint; it does not
re-propagate the same interval at a higher rate. So the ladder is a monotone
forward march in coordinate time, and a contact detected anywhere along it is a
real event on the flown path — never a speculative one that a rollback might
discard. (Contrast ADR-035, where per-segment *accumulation* was rejected
precisely because a rejected step would leave residue. Detection is not
accumulation: it is a predicate on a segment the integrator has already
accepted.)

Two candidate hook points were considered.

- **Rejected: the predictor's `maxAcceptedSteps: 1` loop.** `propagate` resets
  `hasFirstDerivative` on entry, so calling it once per accepted step recomputes
  `k1` instead of reusing `k7` through FSAL. The value is bit-identical (the
  derivative is a deterministic function of `(t, y)`), but it costs a seventh
  extra derivative evaluation per step — ≈ 14% more work in the frame loop, paid
  on every step forever to service an event that fires approximately never.
- **Chosen: an optional accepted-step observer on `propagate`.**

```ts
export type Dp54AcceptedStepObserver = (timeSec: number, state: Float64Array) => boolean;
```

passed as a trailing optional parameter and invoked *after* a step has been
accepted and `outputState` updated. Returning `false` halts the propagation and
sets a new `Dp54Result.halted` flag.

**The observer is provably non-numeric.** It is invoked after the accept/reject
branch has already been taken and after `outputState`/`k1` are written; it takes
no part in the error norm, the controller factor, `stepSec`, or the accept
decision; it adds no derivative evaluation; and when it is absent (`undefined`)
the only added work is one comparison per accepted step. Every existing caller
omits it, so the golden harness, the predictor, and `SimulationCore`'s own
numerics are unchanged by construction. `budgetExhausted` gains `&& !halted` so
a halt on the budget boundary is not misreported as a clamp.

## 3. The two-stage test

### 3.1 Stage one — conservative chord test (shared solver)

Per accepted step from `(t₀, y₀)` to `(t₁, y₁)`, for every body, with rails
evaluated at both endpoints, solve the physics-spec §6 quadratic in the body's
linearly interpolated relative frame:

```
r₀ = ship₀ − body₀ ,  r₁ = ship₁ − body₁ ,  d = r₁ − r₀
|r₀ + f·d|² = R²  ,  f ∈ [0,1]
```

via `smallestUnitRoot(halfB, a, c)`, which is **exported from
`trajectoryImpact.ts`** rather than reimplemented. It is the numerically stable
form (it computes `q = −halfB − sign(halfB)·√disc` and takes `q/a` and `c/q`,
avoiding the catastrophic cancellation of the schoolbook root when `4ac ≪ b²`),
and having two of them would guarantee they eventually disagree.

**This stage is deliberately a superset, not an answer.** The chord is a straight
line; the true trajectory is an arc that, under a central force, bulges *away*
from the attracting centre relative to its own chord. The chord therefore reads
as *closer* to the body than the ship ever gets. The sagitta of a DP54 step in
LEO is not small compared to the accuracy this feature promises:

```
LEO accepted step ≈ 17 s → arc ≈ 130 km → sagitta ≈ L²/(8r) ≈ 0.31 km
```

whereas 1 ms of contact-time tolerance is ≈ 7.7 m of travel. A chord test alone
would fire on any pass within ~300 m of the surface — including the
periapsis = R + 0.1 km graze that the acceptance criteria require *not* to fire.

> **Do not "optimise" stage two away.** The chord test is wrong by ~300 m in the
> unsafe direction. Deleting the confirmation pass would make every close pass a
> crash and would silently break the graze case.

### 3.2 Stage two — confirmation and bisection against real states

When stage one reports a candidate, refine against genuinely propagated states.
`f(t) = |r_ship(t) − r_body(t)| − R`, where `r_ship(t)` comes from a DP54
sub-propagation from `(t₀, y₀)` using a **separate preallocated workspace** (the
outer `propagate` is mid-flight and owns `integrationWorkspace`; the derivative
closure is re-entrant because nested evaluation runs to completion before the
outer loop resumes, and rails caching is keyed on time so it simply refreshes).

```
tGuess = t₀ + f_chord·(t₁ − t₀)
bracket:  lo = t₀ (known outside)            hi = first of {tGuess, t₁, 16 uniform samples} with f < 0
          no such hi  ⇒  no contact this step; the chord fired on the sagitta. Resume.
bisect:   until hi − lo ≤ 1e-3 s             contact ← lo
```

Contact is taken at **`lo`**, the last bracket endpoint at or outside the sphere.
The ship therefore never comes to rest *inside* a body, which is what makes the
NaN claim in §6 hold. Since the true crossing lies in `[lo, hi]` and the bracket
is ≤ 1 ms wide, `|t_contact − t_crossing| ≤ 1 ms` — the acceptance bound.

Cost is bounded and paid once: ~15 bisection iterations of one DP54 step each,
on the frame where the ship crashes.

### 3.3 Which bodies

**All of them**, every accepted step. Justification, since the obvious
optimisation is to test only the dominant body:

- The dominant-body selector is *hysteretic on purpose* (ADR-029): a descendant
  only takes over at `g_C > 1.1·g_D` **and** `|r−r_C| ≤ 0.9·r_SOI,C`. A ship
  descending onto Io while Jupiter is still published as dominant is the normal
  case, not a corner case.
- The Sun is dominant almost nowhere interesting yet is the one body a lost ship
  most plausibly falls into.
- Ring-system and moon-system flight paths pass close to bodies that are not and
  will not become dominant.
- It costs nothing: 43 bodies × ~20 flops, with an early `continue` on the
  common `c > 0, discriminant < 0` miss. Measured cost in §8.

This also keeps the sim consistent with the predictor, which already scans all
bodies — a divergence there would show up as "the warning fired but nothing
happened", which is the exact defect this task exists to remove.

### 3.4 Starting inside

`findFirstTrajectoryImpactInto` skips a body when `c ≤ 0` (ship already inside
the sphere) because a predictor polyline that starts underground has no
meaningful entry crossing. For the sim that skip is a fall-through hole: a
hand-edited or migrated save placing the ship below a surface would never
collide with it.

The new module therefore checks `|r₀| ≤ R` **before** the root solve and reports
an immediate contact at `t₀` — a distinct, testable branch. `trajectoryImpact`'s
own behaviour is left alone; the shared piece is `smallestUnitRoot`, not the
loop.

## 4. Freeze semantics

On confirmed contact, within the same `step()`:

1. abandon the tier ladder;
2. `nextShipState` ← the bisected contact state, `clock.timeSec` ← contact time;
3. `effectiveWarp = 1`, `commandState.requestedWarp = 1`;
4. throttle → 0 through the existing `handleThrottleChange` path, which
   synchronizes and closes the active burn so the ledger stays consistent;
5. publish with `impactOccurred = 1`, `impactBodyIndex`, `impactSpeedKmS`,
   `impactSimTimeSec`.

**`completedWarp === null` is now a reachable, valid outcome.** Today
`if (completedWarp === null) throw new Error('ship propagation exhausted the
integration budget')` — that path is taken when tier 0 itself fails. A contact
during tier 0 is the *common* case (contact ends the first tier it occurs in), so
the impact branch must be tested before that throw. Getting this wrong turns
every crash into an exception.

`impactSpeedKmS` is `|v_ship − v_body|` in coordinate velocity at contact — the
closing speed against the body's centre-of-mass motion. Surface rotation is
excluded (the catalog has `siderealRotationPeriodSec` but the sim has no surface
velocity field, and including it would imply a landing model this task does not
have).

Subsequent `step()` calls return the published snapshot unchanged without
touching the clock, the ledger, or the burn log. `CommandState` gains an
`impactFrozen` flag so `setThrottle`, `rotate` and `setWarp` clamp to
0 / 0 / 1× while frozen, mirroring the existing `MAX_THRUST_WARP` and
`MANUAL_ATTITUDE_MAX_WARP` lockouts rather than inventing a third idiom. Without
it a UI throttle command would open a new burn log entry at a frozen timestamp.

## 5. Recovery

Both recovery paths are **game-layer**, and both build a
`SimulationPersistentState` and hand it to the existing
`GameSessionController.createSimulation` — the same function `loadLocal` and
`importJson` use. That is what "valid by the same rules a loaded save must
satisfy" means operationally: the state passes
`copyAndValidateSimulationPersistentState` or the recovery fails cleanly and the
freeze stays.

- **`restoreFromState(state)`** — replaces the core from a restore-point slot.
  No settings write, no save-repository write; `onSimulationReplaced` fires so
  the flight controller re-points (T0108 contract: assign `currentSimulation`
  before the callback).
- **`respawnInOrbit(bodyIndex)`** — builds a circular orbit at **2 × the body's
  mean radius**, prograde in the body's orbital plane, via a new
  `createCircularOrbitState` in `sim/ship/initialState.ts` (a generalisation of
  the existing `createNewGameLeoState`). Simulation time, the kinetic-energy
  baseline and the completed burn log are preserved — the mission continues, the
  ship is relocated. Throttle is 0 and the active burn is dropped, because
  `copyAndValidateSimulationPersistentState` requires `throttle > 0` and an
  active burn to agree.

### Restore ring (`src/game/restorePoints.ts`)

Six slots, one capture per 10 s of accumulated **wall** time, driven by the
frame loop's `wallDtSec` (no wall clock enters `sim/`; `game/` accumulates the
delta it is already given). Captures are skipped while frozen, so the ring never
fills with post-impact states.

Capture calls `SimulationCore.exportPersistentState()` and retains the result.
This **allocates** — approximately one `SimulationPersistentState` per 600
frames. That is a deliberate, recorded exception to the zero-allocation rule,
argued and measured in ADR-036 §"Allocation": the rule binds the per-frame path,
the CI heap gate measures *retained* growth across a forced double-GC, and the
alternative (a parallel non-allocating `captureInto` path through
`SimulationCore` and `ledger.ts`) creates two persistence paths that must agree
forever — the coupling class that produced T0104's one defect. The per-capture
byte and microsecond cost is measured and recorded rather than asserted.

## 6. The NaN path

After this task the singularity in `evaluateNBodyAccelerationInto` is
**unreachable for the ship**, subject to one stated precondition.

- Contact is taken at `lo`, strictly outside the sphere (§3.2).
- Every catalog body has `meanRadiusKm > 0` (schema: `exclusiveMinimum: 0`), so
  every collision sphere has positive radius and strictly contains its centre.
- A segment that starts inside is caught by §3.4 and frozen at `t₀`.
- While frozen no propagation runs at all.

Precondition: the *initial* state handed to `SimulationCore` must not be at a
body centre. That is a construction-time input, not a reachable dynamic state,
and the constructor's collision audit surfaces it on the first step rather than
as a NaN.

The guard in `nbodyForces` stays. It is cheap, it still protects the predictor
(which propagates a forecast with no freeze), and removing it would trade a
defensive branch for a class of crash.

## 7. Save / load

An impacted session **saves and loads**, and the impact fields are **not
persisted**. `SimulationPersistentState` and save envelope v3 are untouched — no
migration in this PR.

The justification is that the freeze is *derived geometry*, not physical state.
On load the ship is at `R + ε` with its full impact velocity still in the state
vector, pointed inward; the first `step()` re-detects the same contact against
the same body and re-freezes. Round-tripping is therefore automatic rather than
serialized, and §3.4's start-inside guard closes the one hole (`ε` rounding to
zero or negative) that would otherwise let a reloaded crash fall through.

## 8. Verification

| Claim | How |
|---|---|
| Head-on LEO decay fires within 1 ms of the analytic crossing | radial free-fall from a known altitude; analytic crossing from energy integral; compare `impactSimTimeSec` |
| Graze at periapsis = R + 0.1 km does not fire | tuned circular-ish orbit through periapsis; assert `impactOccurred === 0` across the pass |
| Thrusting descent fires though the predictor missed it | `predictThrustFreeTrajectory` on the same state reports no impact; the powered core impacts |
| Contact bisected ≤ 1 ms | bracket width assertion in the collision unit tests |
| Restore is deterministic | restore → step 0 → snapshot field-by-field identical to the captured frame |
| Respawn gives `e < 1e-3` | osculating elements of the respawned core |
| Freeze holds | repeated `step()` leaves `simTimeSec`, ship state, ledger unchanged |
| Warp forced to 1× | snapshot `effectiveWarp`/`requestedWarp` after impact |
| Impacted save round-trips | export → validate → construct → step → freezes on the same body |
| Goldens byte-identical | `git diff -- tests/golden/` empty |
| Frame cost | `bench:sim` `averageStepMs` before/after, retained-heap delta with the ring active |

## 9. Files

| File | Change |
|---|---|
| `data/bodies.json` | `surface.atmosphereTopKm` for four giants |
| `tools/bake_ephemerides.py` | `atmosphere_top_km` in `BodyDefinition`, emitted |
| `data/bodies.test.ts` | value + null-elsewhere assertions |
| `src/sim/propagation/dp54.ts` | optional accepted-step observer, `Dp54Result.halted` |
| `src/sim/propagation/rails.ts` | `collisionRadiiKm` compiled into the catalog |
| `src/sim/analysis/trajectoryImpact.ts` | export `smallestUnitRoot` |
| `src/sim/analysis/surfaceCollision.ts` | NEW — chord scan, confirmation, bisection |
| `src/sim/simulationSnapshot.ts` | 4 impact fields, `impactFrozen` command lockout |
| `src/sim/simulation.ts` | observer wiring, freeze, contact publish |
| `src/sim/ship/initialState.ts` | `createCircularOrbitState` |
| `src/game/restorePoints.ts` | NEW — 6-slot ring |
| `src/game/sessionController.ts` | `restoreFromState`, `respawnInOrbit` |
| `src/ui/impactSignals.ts`, `src/ui/ImpactOverlay.tsx` | NEW — freeze overlay |
| `src/ui/App.tsx`, `src/ui/app.css`, `src/main.ts` | wiring |
| `tools/tests/impactOverlayRegression.mjs`, `tests/render/impactOverlay.*` | NEW harness |
| `.github/workflows/ci.yml` | harness wired |
| `docs/physics-spec.md` §6 | collision semantics |
| `docs/decisions/ADR-036-collision.md` | NEW |

## 10. Corrections after implementation

This document was written before the code. Five claims above needed correcting;
`docs/decisions/ADR-036-collision.md` is the record of record.

1. **§1's "a re-bake reproduces them" is true for the new field and false for the
   file.** The four `atmosphereTopKm` values are now in `BODY_DEFINITIONS`, but
   `visual.polarRadiusRatio` is committed in `bodies.json` for the giants while
   the baker only sets it for Earth — a pre-existing drift that would flatten
   them to 1.0 on a re-bake, contradicting ADR-021. Not fixed here (touching
   another catalog field is what this task was told not to do); recorded in
   ADR-036 §1 to be filed.

2. **§3.2's bracket search is simpler than described in one place and the
   `probe` closure is gone.** The described "16 uniform samples" fallback is
   implemented, but the probes are called positionally rather than through a
   local helper closure: a pass low enough to trip the chord runs the refinement
   on *every* accepted step, so a per-call closure would have been a frame-loop
   allocation during exactly the low pass the feature exists to support.

3. **§3.2 said "propagate from `(t₀, y₀)` using a separate workspace"; it also
   needs a separate `RailsState`.** The probes move rails to arbitrary times, and
   the scan needs the segment endpoints, so `SimulationCore` carries
   `collisionRailsState` distinct from `gravityRailsState`. This is the dominant
   cost of the change (+0.0135 ms/step, one extra 43-body rails evaluation);
   `docs/bench/T0111-summary.md` records the cache-sharing optimisation that was
   declined and why.

4. **§8's "restore → snapshot field-by-field identical" is false for the attitude
   quaternion, for a pre-existing reason.** `writeSlewLimitedQuaternionInto` does
   not short-circuit a zero slew budget; it composes an identity rotation and
   renormalizes, so a core rebuilt from a persisted document publishes a
   quaternion ~1 ULP per component off the persisted one. It does not accumulate.
   `collisionRecovery.test.ts` asserts everything else exactly, the quaternion to
   15 decimal places, and restore-twice bit-exactly.

5. **§8's graze case had to be re-tuned to discriminate.** At the 1 s frames
   originally used, the chord sagitta is 1.2 m against 100 m of clearance, so the
   chord never fired and the test passed without reaching the confirmation pass
   it exists to cover. It now uses 20 s frames, and
   `surfaceCollision.test.ts` asserts the chord *does* fire on that geometry.

Two defects were found only by the Playwright harness, both invisible to unit
tests: the overlay's buttons were inert because `.app-overlay` is
`pointer-events: none` and the panel had not opted back in, and the harness page
was measuring unstyled block layout until it imported `app.css`.
