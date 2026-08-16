# CruiseDirector — design (T0116)

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §4.3; plan
`docs/superpowers/plans/2026-08-14-v2-free-flight.md` §2 and §3.3; physics-spec §8 (all of it,
§8.5 and §8.7 in particular); ADR-035 (slew), ADR-037 (intercept solver).

This document records the decisions the task actually forced, not a restatement of the plan.

---

## 1. The problem the `Commands` surface creates

`Commands` is five methods: `setThrottle`, `setAttitudeMode`, `rotate`, `setWarp`, `setTarget`.
The director needs to point the ship along an **arbitrary inertial axis** — physics-spec §8.4's
`n̂ = Δ(T)/|Δ(T)|`, which is the drift-corrected line of sight, not the line of sight. None of the
eight `AttitudeMode`s can express it:

| mode | direction | can it be `n̂`? |
|---|---|---|
| `target` | ship → target **centre**, live | no: `n̂` carries the `−v₀T` lead correction |
| `prograde`/`retrograde` | ±v relative to the max-gravity body | no, and it *rotates* as the ship burns |
| `normal`/`antinormal`/`radialOut`/`radialIn` | local-orbital frame of the max-gravity body | no |
| `manual` | whatever the quaternion says | yes — the quaternion is the free parameter |

So attitude authority for the director is `manual` + `Commands.rotate(...)`. Two consequences fall
straight out of `SimulationCommands`:

- `rotate()` is **forced to zero above `MANUAL_ATTITUDE_MAX_WARP` (100×)**, and `setWarp` above 100×
  additionally *clears* the standing rates. Every slew therefore has to happen at ≤ 100×.
- `setThrottle()` is forced to zero above `MAX_THRUST_WARP` (1000× today, T0115 retunes it). Every
  burn therefore has to happen at ≤ `MAX_THRUST_WARP`.

In `manual` mode with zero rates the attitude is *constant in inertial space* and the sim thrusts
along it (`writeAttitudeDirectionInto` returns the quaternion forward). That is exactly the fixed
thrust axis §8.4 assumes, so the boost and brake legs can run at the full thrust-warp ceiling with
no attitude traffic at all.

### 1.1 "flip uses hold-mode slew" — what that means here

The plan and the task file both say the flip uses hold-mode slew. Taken literally as "engage one of
the eight `AttitudeMode`s", it is unimplementable: the brake axis is `−n̂`, and the closest hold mode
(`retrograde`) is off by `|v₀|/(αT/2)` — the very κ of ADR-037, 0.2°–4° at the flip and diverging to
90° and beyond as the brake leg removes the ship's speed and `v_rel` rotates. `retrograde` would
also make the brake leg chase its own tail.

Read instead as ADR-035's *slew law and its budget* — which is what §3.2 and physics-spec §8.7
actually quantify — it is exact and implementable. The director reproduces the sim's hold pursuit
through manual rates:

```
θ_err  = angle(nose, aim)                       (quaternionSeparationRad)
ω_cmd  = min(maxSlewRadPerSimS, θ_err / dtSim)  rad per SIMULATED second, about the error axis
```

A 180° flip therefore costs `π / 0.261799 = 12.000 s` of **sim** time at every warp tier, which is
the number ADR-035 §3.2 fixes and the number physics-spec §8.7 tells the director to budget around
`T/2`. `θ_err / dtSim` is the same clamp ADR-035 applies as `min(θ_err, ω·dt)`; without it a 100×
frame is 1.6 s of sim time and 24° of slew, which would limit-cycle around a 0.1° tolerance.

`Commands.rotate` takes **sim**-frame rates, so no warp normalization is applied — the opposite of
`FlightController`, whose rates are wall-frame player intent divided by `effectiveWarp`
(physics-spec §3.0.1). This is why the director cannot drive the slew through
`FlightController.setRotationAxes`: full deflection at 100× is 0.006 rad/s of sim time, and a flip
would take 524 s of sim time instead of 12.

### 1.2 Arbitration with `FlightController`

Both write `rotate()` and `setThrottle()`, so exactly one of them may run per frame. The frame loop
branches: while `cruiseDirector.active`, the director's `update()` runs *instead of*
`flightController.update()`. `FlightInputRouter.apply()` keeps running so that player intent is
still latched (and so warp keys still work — pressing them is player input, which aborts anyway).

Releasing the ship is the part that has to be right, because "abort leaves a valid controllable
state" is an acceptance criterion:

- `setThrottle(0)`, `rotate(0,0,0)`, `setAttitudeMode('manual')`, warp decompressed to ≤ 100×;
- `controller.setThrustRegime('manual')` — the player gets the 2 g manual ceiling back;
- `controller.resetAxes()` — **mandatory**. `FlightController.desiredQuaternion` was last seeded at
  engage time; without the reseed the first post-abort frame would slew the ship back to wherever
  its nose was pointing when cruise started. `resetAxes` does not touch the simulation, which is
  also what the restore path needs (T0108 handoff).

## 2. Guidance modes, and why there is no `pursuit` phase

Plan §2 fixes the phase vocabulary at `idle|align|boost|flip|brake|insert|done|aborted`. §3.3.6 and
physics-spec §8.7 add a pursuit rule that is "always available, also the abort-resume mode". Adding
a ninth phase would break the plan's contract for T0119's HUD, so instead the director carries a
**guidance mode** orthogonal to the phase:

| mode | when | boost means | brake means |
|---|---|---|---|
| `profile` | the §8.4 solve returned `ok` | fly `+n̂` open loop to `T/2` | fly `−n̂` open loop |
| `pursuit` | §8.7: the solve failed, or cruise was resumed mid-flight | close: aim at the lead point, full α | kill `v_rel`: aim `−v̂_rel`, full α |

`d_rel > 1.2·D_stop` selects boost, otherwise brake — the §8.7 branch, and the same 1.2 margin the
approach-brake assist (T0118) engages at. This is why the director never needs a phase the plan did
not name, and why an abort at 80 % of a Neptune run can be re-engaged and still arrive.

**A mid-cruise `ok = false` is a routing decision, not an error.** The κ guard is ADR-037's whole
point (T0114 handoff): re-solving from 75 % along a flown Neptune profile converges to a real
solution in which the ship drifts past Neptune and boosts back at 4,000 km/s. The director never
retries a failed solve harder and never widens κ; it either keeps the profile it is already flying
(a scheduled re-solve that fails changes nothing) or, if it has no profile at all, flies pursuit.

## 3. Phase machine

```
idle ──engage()──▶ align ──▶ boost ──▶ flip ──▶ brake ──▶ insert ──▶ done
                     ▲         │                  │          │
                     └── re-aim ┴──────────────────┴──────────┘        (align is re-entrant)
any phase ──abort()──▶ aborted ──engage()──▶ align (pursuit mode)
```

`align` is a **service phase with a resume target**: any phase that wants thrust and finds
`θ_err > 2°` cuts the throttle, records where it came from and slews. `flip` is the same service
with its own name (the HUD wants to say FLIP) and a 180° target. This is what keeps the machine at
eight phases while still allowing a re-aim in the middle of a pursuit brake.

Boost/flip/brake scheduling, in sim time, with `T` and `T/2` from the solve and
`t_slew = π / maxSlewRadPerSimS`:

```
boost   [t₀ + t_align ,   t₀ + T/2 − t_slew/2)
flip    [t₀ + T/2 − t_slew/2 ,  ~ + t_slew)       throttle 0
brake   [t₀ + T/2 + t_slew/2 ,  arrival)
```

The flip is centred on `T/2` so the impulse centroid stays where the profile put it; the ~1.18 km/s
of Δv the coast costs (12 s at 10 g) is small against the profile's own 10³–10⁴ km/s and is absorbed
by the closed-loop endgame rather than by a schedule correction.

Mid-course re-solve (plan §3.3.4, physics-spec §8.7): every **300 s of sim time**, on any phase
change, or when lateral drift exceeds **0.5 % of the remaining distance**. Lateral drift is measured
as the component of the current line of sight to the aim point perpendicular to `n̂`. Only accepted
while the phase is `align` or `boost` — that is the "still slow against its own profile" window; a
re-solve in `brake` is guaranteed to be a spurious root or a non-convergence and is not attempted.

## 4. Arrival: stand-offs, the residual, and insertion

### 4.1 Stand-off table (mandatory, physics-spec §8.5)

The solver defaults `orbit` to `3·R_col`, and `3·R_col` at Jupiter is 214,476 km, **inside the Thebe
gossamer ring** (`data/rings.json` outer radius 270,000 km). `sim/` may not read `rings.json`, so the
table is the director's:

| class | `R_arr` | expressed as `arrivalAltitudeKm` |
|---|---|---|
| ringed giants (Jupiter, Saturn, Uranus, Neptune) | 1.2 × outermost ring radius | `R_arr − R_col` |
| Sun | 25 R☉ = 17,392,500 km | `R_arr − R_col` |
| everything else | `3 · R_col` (solver default) | 0 |

Numbers: Jupiter 324,000 (h = 252,508), Saturn 168,734.4 (h = 108,466.4), Uranus 127,440
(h = 101,881), Neptune 75,528.6 (h = 50,764.6). Derived from `data/rings.json` at construction time,
not hard-coded, so a ring-data change moves the stand-off with it. `flyby` keeps the caller's
altitude and the solver's `R_col` floor.

### 4.2 The residual is the insert phase's whole job

§8.4: the profile arrives at rest **in the ship's initial drift frame**, not relative to the target.
The residual is `v₀ − v_j(t_arrival)`: 6.8 km/s (Moon), 63.5 (Mars), 25.0 (Jupiter), 39.2 (Neptune),
38.0 (Sun). On Mars that residual's stop distance is 2.02× the 3-radius stand-off, so the insert
burn **does not fit inside the arrival sphere on that route**. T0114 tried "residual must be
brakeable inside the stand-off" as a validity guard and rejected it because it kills the canonical
Mars route. This director therefore has no such guard: `insert` is allowed to overshoot the sphere
and fly back, and the pursuit rule handles it because pursuit needs no time of flight.

### 4.3 Insertion, in three steps

1. **`insert/kill`** — §8.7 pursuit against the target until `|v_rel| < 1e-3 km/s` and
   `|r_rel| − R_arr` is inside 1 % of `R_arr`. This is where the 6.8–63.5 km/s goes. Rails-relative
   rest, at the arrival radius, exactly as the task states.
2. **`insert/circularize`** — burn 1. From rest at radius `r`, a circular orbit needs
   `v_circ = √(μ/r)` perpendicular to `r̂` (physics-spec §2 two-body). The plane is
   `t̂ = unit(ẑ_ecliptic × r̂)`, falling back to `x̂` when `r̂ ∥ ẑ`: a prograde, near-equatorial orbit,
   deterministic and independent of which way the ship happened to arrive. Burn duration
   `γ_rel·v_circ/α` (§8.3's `t_stop`, run forwards).
3. **`insert/trim`** — burn 2, **computed from the osculating elements** the burn actually produced.
   The ship falls during burn 1, so the result is slightly eccentric: at Jupiter, 202 s of burn at
   10 g leaves a radial component of `−(2/3)g·T = −0.163 km/s` against 19.77 km/s tangential, an
   `e ≈ 0.008` and a 16 km radius loss. The trim burn removes the whole velocity error at the
   current radius, `Δv⃗ = v_circ(r)·t̂(r,v) − v⃗_rel`, which drives `e` to the slew and burn-timing
   residual. Trim is skipped when `e` is already below `1e-3`, and repeated at most twice.

Why not "coast to apoapsis and burn prograde", the textbook second burn: at Jupiter's stand-off the
orbital period is 1.19 days. Coasting a half-period costs 10 minutes of wall clock at 100×, and the
acceptance budget for the entire LEO→Jupiter run is 5 minutes. The trim burn is the same correction
applied in place.

### 4.4 Eccentricity is computed target-relative, not from the snapshot

`snapshot.osculatingElements` is measured against `dominantBodyIndex`, which uses a hysteretic
SOI heuristic and is *usually* but not *necessarily* the target during insertion. Control decisions
use `μ_target` from `rails.catalog.muKm3S2` and the target-relative state read straight out of the
snapshot's body arrays, so insertion cannot be steered by a body the player did not pick. The
snapshot elements remain the thing the browser gate asserts on, which is a genuine cross-check:
two independent computations have to agree for the gate to pass.

## 5. Warp piloting

Requested tier = the highest ladder tier that satisfies **all** of:

1. `≤ MAX_THRUST_WARP` whenever the throttle is or is about to be open (read from `core/time.ts`, not
   hard-coded — T0115 retunes it and the ladder may gain a tier);
2. `≤ MANUAL_ATTITUDE_MAX_WARP` (100×) whenever the phase slews (`align`, `flip`, and any burn whose
   attitude is still moving — i.e. every phase except a settled open-loop leg);
3. `≤` the tier the sim actually completed last frame when `warpClampReason === INTEGRATION_BUDGET`
   — the integration-budget clamp is respected by backing off one tier, not by re-requesting;
4. `≤ 100×` for one full second of wall clock after any decompression trigger;
5. no tier at all while `impactOccurred` — `setWarp` pins a frozen ship at 1× anyway.

**Decompression triggers** (`≤ 100×` within 1 s wall, acceptance criterion): any player input, any
`abort()`, an SOI change, a collision warning, and arrival. Implementation is a ramp of one ladder
tier per 100 ms wall, so the worst case on the current ladder (1e7 → 100, five tiers) is 500 ms;
a director that never requests above `MAX_THRUST_WARP` sees a single tier and decompresses in
100 ms. The ramp exists because the design spec asks for a *smooth* decompression; the acceptance
bound is what the ramp is sized against.

- **Player input** is reported to the director by the one module that already owns `InputFrame`,
  `FlightInputRouter`, via `notifyPlayerInput()`. Any nonzero look delta, any nonzero axis, any
  pressed action counts. This also aborts, per design §4.3 ("touching the stick … pauses cruise").
- **SOI change**: `snapshot.dominantBodyIndex` changing. `WarningFlag.SOI_CHANGE` exists in the
  snapshot contract but nothing sets it yet (T0111 left it declared); the dominant-body transition
  is the live detector, and the flag is honoured too so this keeps working when a later task emits
  it.
- **Collision warning**: physics-spec §8.3's own guard, `altitude < 1.5 · D_stop(closing speed)`
  against the dominant body — the form the spec says "fails *toward* warning". O(1) per frame, no
  predictor round trip. Suppressed for the target body during `insert`, where closing on a
  stand-off sphere at speed is the plan.

## 6. Ledger honesty

The director opens and closes the throttle and nothing else. It never writes energy, never keeps its
own Δv accumulator, and never bypasses `Commands`. Cruise energy is therefore `snapshot.energySpentJ`
by construction. The gate asserts it against the analytic bound of physics-spec §8.2,
`E = 2(γ_peak − 1)mc²`, within 2 %; the residual is the flip coast, the align slew and the insertion
burns, all of which are real thrust the ledger also counts.

## 7. Zero allocation

`update()` allocates nothing: every vector is a preallocated `Float64Array` field, the solution
record is `createInterceptSolution()` once at construction, and the rails handle is
`createCompiledRails(catalog)` once at construction.

**`createCompiledRails`, never `SimulationCore`'s live `RailsState`** (T0114 handoff, ADR-037 §6):
that cache is keyed on `(timeSec, catalog)` and holds the current frame's body positions; the solver
evaluates future times through it and would silently corrupt every downstream consumer in the same
frame. The director does not have access to the live state anyway — it is private — but the
temptation is real because `rails.catalog` and the sim's catalog are the same object, and passing
the sim's `RailsState` would "work".

## 8. Rejected alternatives

- **Drive the slew through `FlightController.setRotationAxes`.** Wall-frame authority divided by
  `effectiveWarp`: a 180° flip at 100× would take 524 s of sim time (§1.1). Rejected.
- **Use `retrograde` for the brake leg.** Off by κ at the flip and diverging to 90° as `v_rel` is
  removed (§1.1). Rejected.
- **A ninth `pursuit` phase.** Breaks plan §2's phase contract, which T0119's HUD is written
  against. Replaced by the orthogonal guidance mode (§2).
- **Re-solve during `brake` to correct accumulated error.** ADR-037 §4 exists precisely because that
  returns spurious roots. Replaced by the closed-loop pursuit endgame (§2, §4.3).
- **Guard `engage()` on "the arrival residual must brake inside the stand-off".** Kills the
  canonical Mars route (§4.2), and T0114 already tried and rejected it. Not implemented.
- **Textbook two-burn circularization at apoapsis.** 10 wall-minutes of coast at Jupiter against a
  5-minute acceptance budget (§4.3). Replaced by an in-place trim.
- **A `CruiseDirector`-owned energy accumulator for the HUD.** A side channel by definition, and the
  acceptance criterion is explicitly that there is none (§6). The HUD reads `snapshot.energySpentJ`.

## 9. Landmines found in existing code

1. `SimulationCommands.setWarp` **clears standing rotation rates** when the new tier exceeds 100×.
   A director that raised warp and then commanded a slew would command into a void. Slew first,
   compress second — enforced by the per-phase ceiling (§5.2).
2. `SimulationCommands.setThrottle` silently forces 0 above `MAX_THRUST_WARP` and returns normally.
   The director must therefore verify `snapshot.throttle`, not assume its command took, which it
   does by re-issuing from the phase's intent every frame (the call is a no-op when unchanged).
3. `FlightController.flushRotation` issues `rotate()` only on change against **its own** cached
   triple. If both it and the director ran in the same frame, the controller would appear inert
   while silently holding a stale cache. Hence the exclusive branch in the frame loop (§1.2).
4. `evaluateRailsInto` throws `RangeError` on a non-finite time. T0114 validates every iterate
   before it reaches rails; the director must do the same for its own rails evaluations
   (`arrivalSimSec` is derived from a solve and is finite by construction, but a resumed profile is
   re-validated).
5. `snapshot.osculatingElements` is dominant-body relative, not target relative (§4.4).
6. Earth–Mars is **2.4 AU at J2026**, not the 0.52 AU plan §3.3 assumed, so the Mars route is 1.40 d
   of sim time. The abort fuzz gate is sized against 1.40 d, not 1.0 d.
