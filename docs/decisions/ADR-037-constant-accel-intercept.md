# ADR-037: Constant-acceleration relativistic intercept (physics-spec §8)

**Status:** accepted (2026-08-16)

## Context

v2's headline system is a cruise autopilot that answers, the moment a player clicks a
body: when do I arrive, when do I flip, how much clock do I lose, and how fast do I
get? Nothing in the codebase answers any of them. The plan
(`docs/superpowers/plans/2026-08-14-v2-free-flight.md` §3.3) fixes the shape of the
answer — a constant-proper-acceleration boost–flip–brake profile, relativistically
exact in one dimension, vector-corrected by a fixed-point iteration on the time of
flight — and this ADR records what that means precisely, what it deliberately does
not model, and how it fails.

Three properties of the existing simulation constrain everything:

- **Celerity is linear in coordinate time.** physics-spec §3 integrates
  `du/dt = g + α·û`, so with `g` dropped and a fixed thrust axis, `u(t) = u₀ + αt·n̂`
  *exactly*. Every quantity of interest is then one quadrature away, and the solver
  needs no shooting method.
- **Bodies are on analytic rails** (§2, ADR-001), evaluable at any future time — but
  `evaluateRailsInto` **throws** on a non-finite time, and its `RailsState` is a
  per-time cache that the live simulation owns.
- **A 180° flip is not free.** ADR-035 fixed the hold slew at 15°/s, so a reversal
  costs 12.0 s of simulation time at every warp tier.

## Decision

### 1. The model, and its scope

physics-spec gains **§8**, which derives, in the symbols of `sim/ship/relativity.ts`:
hyperbolic motion under constant proper acceleration (§8.1); the rest-to-rest
brachistochrone `T_h = √(d²/4c² + d/α)`, with `γ_peak`, `β_peak` and `τ` in closed
form (§8.2); the exact braking envelope `D_stop = (c²/α)(γ−1)` and `t_stop = u/α`
(§8.3); the vector iteration against a rails target (§8.4); the arrival stand-off
radius (§8.5); convergence and failure (§8.6); and the model's limits with the
pursuit fallback (§8.7).

The solve is **thrust-only**. Gravity is not in it. Over an Earth→Mars leg the Sun
displaces the ship ≈ 9e3 km and Earth's field adds ≈ 3 km/s of unmodelled Δv near
LEO — both orders of magnitude above the solver's own kinematic residual, and both
absorbed by the CruiseDirector's mid-course re-solve (plan §3.3.4). Guidance computes
a *schedule*; the closed loop flies it.

### 2. The initial velocity goes into the distance, not into the flip time

Following plan §3.3.2 the iterated displacement is
`Δ(T) = r_j(t₀+T) − r₀ − v₀T`, which places the solve in the frame drifting at the
ship's initial coordinate velocity. In that frame the ship starts at rest, §8.2
applies to the powered motion without approximation, and **the flip is at exactly
`T/2`**.

Plan §3.3.3's "`flipAt = T/2` (adjusted for initial v∥)" is therefore a **no-op**: the
parallel component of `v₀` is already removed inside `Δ`, and applying a second
correction to the flip time would double-count it. The plan text is clarified in the
same commit series rather than left to be rediscovered by T0116.

The consequence is explicit and must not be forgotten downstream: the profile arrives
at the stand-off point **at rest in the drift frame, not relative to the target**. The
residual `v₀ − v_j(t_arrival)` measured 6.8–63.5 km/s across the canonical routes and
is the insertion phase's to remove, at a cost of `t_stop` and `D_stop` (§8.3).

A two-axis profile (boost on one axis, brake on another) *would* match both arrival
position and arrival velocity. It was rejected: it contradicts plan §3.3.3's
"attitude reversal via hold-mode slew" — a 180° flip is single-axis by construction —
and it would make the flip a slew of unknown angle, which the director cannot budget
against ADR-035's fixed 12.0 s reversal. §8.4 records the exact displacement identity
`Δr∥ = (2c²/α)(γ_flip − γ₀)`, `Δr⊥ = u_⊥·τ`, which is what a future exact Newton
solve would be built on if the mid-course loop ever proves insufficient.

### 3. Reported proper time and peak beta retain the initial celerity

Plan §3.3.5's `τ = 2(c/α)·asinh(αT_h/c)` and `β_peak = tanh(asinh(αT_h/c))` assume a
ship starting from rest. The drift-aware generalisations of §8.4 reduce to them
identically at `u₀ = 0` and cost four lines, so they are what the implementation
reports. The reason is not tidiness: a re-solve taken mid-cruise on a Neptune run
would otherwise report `β_peak` as though the ship were not already doing 0.07 c.

### 4. Failure contract, including a conditioning guard the plan does not have

`ok = false` means "do not fly this"; every numeric field is written NaN and the
thrust axis is zeroed, so a consumer that ignores `ok` fails loudly rather than
flying a plausible profile. The nine conditions are enumerated in §8.6. Eight are
input validation, geometry, or plan §3.3.2's 25-iteration cap.

The ninth is new. The iteration's contraction factor is
`κ = |v₀ − v_j(t₀+T)| / (αT/2)`, and the solver additionally requires `κ ≤ 0.1` at
convergence. This exists because the plain convergence test admits **spurious roots**.
Re-solving from a state part-way along a flown Neptune profile:

| elapsed | \|u\| (km/s) | κ | plain result | T solved (d) | true remaining (d) |
|---|---:|---:|---|---:|---:|
| 10% | 4,173 | 0.245 | ok, 10 iters | 4.02 | 4.47 |
| 25% | 10,487 | 0.930 | not converged | — | 3.73 |
| 50% | 21,012 | 0.584 | not converged | — | 2.48 |
| 75% | 10,487 | 0.585 | **ok, 25 iters** | 4.23 | 1.24 |
| 90% | 4,173 | 0.586 | **ok, 24 iters** | 1.68 | 0.50 |

The bolded rows are genuine solutions of the stated equation — the ship drifts past
the target and boosts back — and they "arrive" at thousands of km/s. Against them,
the five canonical departure solves sit at κ = 0.0019–0.036 and converge in 2–3
iterations. The threshold sits in a factor-6.9 gap with ≥ 2.4× margin either side.

The obvious alternative guard, "the residual must be brakeable inside the stand-off
radius", was tried and **rejected: it fails the canonical Mars route**, whose 63.5 km/s
residual needs 2.02 × the 3-radius Mars stand-off. That solve is entirely correct;
only its insertion burn is long. "The solution is unreliable" and "the insertion burn
is long" are different facts and are kept apart — κ guards the first, and T0116 sizes
the second with `relativisticStopDistanceKm` directly.

### 5. Arrival stand-off: rule in `sim/`, table in `game/`

The solver owns `R_arr = max(R_col, h > 0 ? R_col + h : (orbit ? 3·R_col : R_col))`,
with the outer `max` a hard floor against ever aiming inside a collision sphere. It
cannot own the class table, because the ringed-giant radii come from
`data/rings.json`, which is game-layer data. The table is transcribed into §8.5 so
T0116 has the numbers. It is not cosmetic: `3 · R_col` at Jupiter is 214,476 km,
inside the Thebe gossamer ring at 270,000 km.

### 6. Interface deviations from plan §2

Plan §2 is updated in the same commit series, per its own naming rule.

- **`CompiledRails` is defined by this task.** The plan names the parameter type but
  no such type exists; the codebase has `CompiledRailsCatalog`, `RailsState` and
  `RailsWorkspace`, and an allocation-free solver needs all three. `CompiledRails`
  bundles them, with a `createCompiledRails` factory. The catalog is shared and
  read-only; the state and workspace are the solver's **private scratch and must
  never be `SimulationCore`'s live `RailsState`**, which holds the current frame's
  body positions and would be silently corrupted by a future-time evaluation.
- **`InterceptSolution` gains `iterations`** — the task's convergence acceptance is a
  bound on iteration count, which the plan's six fields leave unobservable.
- **`InterceptSolution` gains `aimUnit`** (3 components, written in place) — the
  profile is defined by its thrust axis, and nothing, including this task's own
  arrival-miss test, can fly the profile without it. It lives in the out-struct
  rather than in a second function because the axis is only meaningful for the
  converged `T`.

### 7. Golden policy for cruise scenarios (T0120)

Cruise goldens are **two artefacts per scenario**, and the distinction is
load-bearing:

1. **A solution golden** — the solver's inputs (ship state, target id, `α`, arrival
   intent, altitude, `t₀`) and its outputs (`totalCoordSec`, `flipAtCoordSec`,
   `totalProperSec`, `peakBeta`, `arrivalRadiusKm`, `aimUnit`). Cheap, exact, and the
   thing that actually detects a change in the guidance math.
2. **A trajectory golden** — the flown profile sampled in ADR-017's daily format,
   which detects a change in the integrator or the rails underneath it.

Rules:

- **Scenarios** are the five of §8.2's table, at `t₀ = 0` (J2026), `α = 98.0665 m/s²`,
  from the standard 400 km LEO — plus the polar LEO variant for the Sun. Note that
  Earth and Mars are 2.4 AU apart at J2026, so the Mars scenario is a
  far-conjunction case; a near-conjunction Mars scenario at a later `t₀` is worth
  adding for coverage, not as a replacement.
- **Comparison is relative, never byte-identical.** `Math.asinh` and friends are not
  bit-reproducible across engines (ADR-017's cross-runtime finding applies here too).
  Solution goldens compare at **1e-9 relative** on times, radii and `peakBeta`, and
  1e-9 absolute per `aimUnit` component. That is ~7 orders looser than a libm ulp and
  ~6 orders tighter than any real regression.
- **`iterations` is never part of a golden.** It is a diagnostic, and the convergence
  test is a threshold on a difference, so a 1-ulp libm difference could in principle
  move it. It is bounded (`≤ 12`) as a contract instead.
- **Trajectory goldens** keep ADR-017's per-scenario absolute drift limits; the
  `τ/t` ratio is additionally checked against §8.2's closed form at 1e-6.
- **The solver's acceptance numbers are contract, not goldens**: `ok = true` on all
  five routes, `iterations ≤ 12`, open-loop miss `< 0.1%` of flown distance,
  `κ ≤ 0.1`. They may not be relaxed to make a route pass. A route that fails one is
  either a guidance bug or a genuinely degenerate geometry, and a degenerate geometry
  belongs on the §8.7 pursuit fallback, not in a widened tolerance.
- **Regeneration** follows plan §6: the feature change and the new golden are
  separate commits in the same PR, the second titled `golden: <reason>`.

## Consequences

- `sim/guidance/` is a new pure-sim directory with no dependencies beyond
  `core/constants`, `sim/propagation/rails` and `sim/ship/relativity`. It is read-only
  with respect to the catalog and holds no module-level state.
- T0116 inherits a hard boundary: **the solver is a departure solver.** Mid-cruise
  re-solves at cruise speed return `ok = false` by design, and the endgame is the
  §8.7 pursuit rule. The director must not treat `ok = false` as an error.
- T0118's approach-brake assist and T0116's brake phase share one exact envelope
  (`relativisticStopDistanceKm`), so the warning threshold and the flown brake can
  never drift apart.
- T0119 gets `peakBeta` and `totalProperSec` straight from the solution, so the
  dual-clock HUD shows the same numbers the profile was solved with.
- Nothing in `SimSnapshot` or `Commands` changes; no save-envelope change; no new
  runtime dependency.
