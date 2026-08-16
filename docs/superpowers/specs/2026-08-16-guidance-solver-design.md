# Constant-acceleration relativistic intercept solver — per-task design (T0114)

Spec of record: `docs/superpowers/specs/2026-08-14-v2-free-flight-design.md` §4.3.
Plan: `docs/superpowers/plans/2026-08-14-v2-free-flight.md` §2, §3.3, §T0114.
Decision record: `docs/decisions/ADR-037-constant-accel-intercept.md` (same PR).
Formulas: `docs/physics-spec.md` §8 (added by this task).
Depends on: T0104 (`VesselConfig` supplies `alphaMaxMS2`).

## Problem

The CruiseDirector (T0116) has to answer four questions the moment a player clicks
a body: **when do I arrive, when do I flip, how much clock do I lose, and how fast
do I get?** All four have closed forms under constant proper acceleration, and none
of them exist in the codebase. The ship's dynamics (physics-spec §3) is

```
du/dt = g(r,t) + α û ,   dr/dt = u/γ ,   dτ/dt = 1/γ ,   γ = √(1+|u|²/c²)
```

which is *linear in celerity* for a fixed thrust axis with `g` dropped. That is the
whole reason this task is tractable analytically rather than as a shooting problem:
`u(t) = u₀ + α t û` is exact, and every quantity of interest is one quadrature away.

The target, however, is on rails and moves during the trip, so the time of flight
appears on both sides of the problem. Plan §3.3.2 fixes the resolution: a fixed-point
iteration on the coordinate time of flight.

## Decision summary

- Two modules, both pure and allocation-free: `sim/guidance/constantAccelIntercept.ts`
  (the vector solve) and `sim/guidance/brakingEnvelope.ts` (the exact stop distance).
- The 1D profile is **relativistically exact** in closed form (physics-spec §8.1–8.2);
  the vector correction is the plan's **first-order drift subtraction**, iterated.
- The solve is **thrust-only**. Gravity is deliberately not modelled; the
  CruiseDirector's mid-course re-solve is the closed loop (plan §3.3.4).
- Arrival is **at rest in the ship's initial drift frame**, not relative to the
  target. The residual is `v₀ − v_target(t_arrival)`; T0116's insert phase removes it.
- `ok=false` gains one condition beyond plan §3.3.2's non-convergence: a **conditioning
  guard** `κ = |v_residual| / (αT/2) ≤ 0.1`. Measured evidence below shows this is the
  line between a departure solve (κ ≤ 0.036, converges in ≤ 3 iterations) and a
  mid-cruise re-solve (κ ≥ 0.24, which either fails to converge *or converges to a
  spurious fly-past root*). Without it the solver silently returns plausible garbage.
- `InterceptSolution` gains two fields the plan's §2 sketch lacks — `iterations` and
  `aimUnit` — and plan §2 is updated in the same commit per its own naming rule.

## 1. The decision space actually faced

### 1.1 Where the initial velocity goes (the only real modelling choice)

The ship never starts at rest: a 400 km LEO carries ~30 km/s of inherited
heliocentric velocity. A boost–flip–brake profile with a *fixed* thrust axis has
exactly one direction and one flip time to spend, so it cannot both arrive at a
moving target's position and match that target's velocity. Something must give.
Three candidates:

| # | Formulation | Arrives at | Flip time |
|---|---|---|---|
| A | **Drift frame** — subtract the full `v₀·T` from the required displacement | the aim point, at velocity `v₀` | exactly `T/2` |
| B | Along-LOS asymmetric — keep `v₀`, solve boost/brake split for `v∥` | the aim point, at velocity `v₀⊥` | `≠ T/2` |
| C | Two-axis (boost on one axis, brake on another) | position *and* velocity | `≠ T/2`, flip `≠ 180°` |

**Chosen: A.** It is what plan §3.3.2 literally specifies
(`d_k = |r_t(t₀+T_k) − r₀ − v₀·T_k|`), it keeps the profile symmetric, and in the
frame drifting at `v₀` the ship genuinely starts at rest, so the §8.2 rest-to-rest
closed form applies without approximation to the *powered* part of the motion.

C is the only formulation that arrives at true relative rest, but it contradicts
plan §3.3.3's "flip (attitude reversal via hold-mode slew)" — a 180° flip is a
single-axis profile by construction — and it would make the flip a general slew of
unknown angle, which the director cannot budget against ADR-035's 12.0 s reversal.
Rejected as out of scope; recorded in ADR-037 as the upgrade path if open-loop
accuracy ever has to beat the mid-course loop.

**Plan §3.3.3's "flipAt = T/2 (adjusted for initial v∥)" is a no-op under
formulation A** and this is worth stating plainly, because it reads like a missing
term: `v₀` — including its LOS component `v∥` — has *already* been removed inside
`d_k`. The adjustment lives in the distance, not in the flip time. The plan text is
clarified in the same commit.

### 1.2 Exact or approximate reporting of τ and β_peak

The plan (§3.3.5) gives the rest-to-rest forms `τ = 2(c/α)·asinh(αT_h/c)` and
`β_peak = tanh(asinh(αT_h/c))`. These ignore `u₀`. For a departure from LEO the
difference is `O(β₀²) ≈ 1e-8` — invisible.

But a **mid-course re-solve at cruise speed** would report `β_peak` as if the ship
started at rest, and on a Neptune run the ship passes 0.07 c. The rest-to-rest form
would under-report the peak by the entire cruise speed. Since the drift-aware forms
are four lines (physics-spec §8.4) and reduce *identically* to the plan's forms at
`u₀ = 0`, the exact ones are implemented. Verified against DP54: the closed-form τ
matches the integrated τ to 1.3e-7 s over a 4.97-day Neptune profile (3e-13
relative).

### 1.3 What `rails` means in the plan's signature

Plan §2 writes `rails: CompiledRails`. **No such type exists** — the codebase has
`CompiledRailsCatalog` (immutable SoA), `RailsState` (a mutable per-time cache) and
`RailsWorkspace` (Kepler scratch). Evaluating a *future* target position needs all
three, and an allocation-free solver cannot create the last two per call.

`CompiledRails` is therefore defined here as the bundle, matching the plan's name
exactly: `{ catalog, scratchState, scratchWorkspace }` with a `createCompiledRails`
factory. The catalog is shared and read-only; the other two are private scratch.

**Landmine:** the scratch must never be `SimulationCore`'s live `RailsState`. That
cache is keyed on `(timeSec, catalog)` and holds the *current frame's* body
positions; evaluating `t₀ + T` through it would overwrite them for every consumer
downstream in the same frame. The factory allocates its own, and the field names say
`scratch` so a future caller has to work at getting this wrong.

### 1.4 Where the arrival stand-off radius comes from

Plan §3.3.3 wants `meanRadius·3` for planets and moons, `outermost ring radius ×
1.2` for ringed giants, and `25 R☉` for the Sun. The compiled catalog carries
`collisionRadiiKm` (physics-spec §6: `meanRadiusKm + atmosphereTopKm`) but **no ring
data** — `data/rings.json` is loaded in the game layer, and `sim/` may not reach for
it.

Split accordingly: the solver owns the *rule*

```
R_arr = max( R_col , h > 0 ? R_col + h : (arrival === 'orbit' ? 3·R_col : R_col) )
```

and the caller owns the *table*. The `max` is a hard floor — the solver will never
aim inside a body's collision sphere no matter what altitude it is handed. The ring
table is transcribed into physics-spec §8.5 and ADR-037 so T0116 has the numbers.

This matters: `3 × R_col` for Jupiter is 214,476 km, which is **inside** the Thebe
gossamer ring (270,000 km). The class default is wrong for all four ringed giants,
which is exactly why the plan carved out the override.

### 1.5 Rejected: making the solver exact

The exact drift-aware displacement of the symmetric profile has a startlingly clean
closed form (derived in physics-spec §8.4):

```
Δr∥ = (2c²/α)(γ_flip − γ₀)        Δr⊥ = u⊥ · τ
```

Three equations, three unknowns (`T` and the two angles of `n̂`) — a Newton solve
would be exactly determined and would drive the open-loop miss from `1e-6` to
round-off. It was **not** implemented: plan §3 algorithm specs are binding and the
measured miss is already three orders of magnitude inside the acceptance gate. The
identity is documented in physics-spec §8.4 anyway, because it is what *bounds* the
miss, and it is the natural upgrade if T0120's goldens ever need it.

## 2. Measured evidence

α = 98.0665 m/s² (10 g, `DEFAULT_VESSEL.alphaMaxMS2`), start = 400 km prograde LEO at
J2026 t = 0, profile flown open-loop by DP54 with the production ship tolerance and a
zero gravity evaluator.

| Route | R_arr (km) | iters | T (d) | d (km) | β_peak | miss / d | κ |
|---|---:|---:|---:|---:|---:|---:|---:|
| LEO→Moon, orbit (3 R) | 5,212.2 | 3 | 0.0448 | 3.674e5 | 5.65e-4 | 9.1e-7 | 0.036 |
| LEO→Mars, orbit (3 R) | 10,168.5 | 2 | 1.4037 | 3.606e8 | 1.98e-2 | 8.5e-7 | 0.011 |
| LEO→Jupiter, rings ×1.2 | 324,000 | 2 | 1.8605 | 6.334e8 | 2.63e-2 | 1.2e-6 | 0.0032 |
| LEO→Neptune, rings ×1.2 | 75,528.6 | 3 | 4.9685 | 4.512e9 | 6.99e-2 | 8.7e-6 | 0.0019 |
| LEO→Sun, flyby 25 R☉ | 17,392,500 | 2 | 0.8420 | 1.297e8 | 1.19e-2 | 5.0e-7 | 0.011 |
| polar LEO→Sun, 25 R☉ | 17,392,500 | 2 | 0.8437 | 1.303e8 | 1.19e-2 | 4.3e-7 | 0.0087 |

Trip times land on plan §3.3's reference figures (Moon ≈ 1.1 h vs 1.07 h measured;
Jupiter ≈ 1.9 d vs 1.86 d; Neptune ≈ 4.9 d vs 4.97 d). Mars comes out at 1.40 d
rather than the plan's ≈ 1.0 d because Earth and Mars are 2.4 AU apart at J2026, not
the 0.52 AU the plan assumed — geometry, not a discrepancy in the math.

Iteration counts are 2–3 against an acceptance budget of 12 and a hard cap of 25.
The contraction factor of the fixed point is `≈ |v_rel| / (αT/2)`, i.e. κ itself, so
"few iterations" and "well conditioned" are the same statement.

### 2.1 The spurious-root finding (the reason for the κ guard)

Re-solving from a state part-way along the flown Neptune profile:

| elapsed | \|u\| (km/s) | κ | result | T solved (d) | true remaining (d) |
|---|---:|---:|---|---:|---:|
| 10% | 4,173 | 0.245 | ok=true, 10 iters | 4.02 | 4.47 |
| 25% | 10,487 | 0.930 | ok=false, 25 iters | — | 3.73 |
| 40% | 16,802 | 1.615 | ok=false, 25 iters | — | 2.98 |
| 50% | 21,012 | 0.584 | ok=false, 25 iters | — | 2.48 |
| 60% | 16,802 | 0.585 | ok=false, 25 iters | — | 1.99 |
| 75% | 10,487 | 0.585 | **ok=true, 25 iters** | 4.23 | 1.24 |
| 90% | 4,173 | 0.586 | **ok=true, 24 iters** | 1.68 | 0.50 |

The bolded rows are the dangerous ones. They *are* real roots of the stated
equation — the ship drifts past Neptune, then boosts and brakes back to the aim
point — and the plan's convergence test cannot tell them apart from a departure
solve. The κ gap is unambiguous: **max accepted 0.036, min rejected 0.245**, a
factor of 6.9. `κ_max = 0.1` sits between them with ≥ 2.4× margin on both sides.

Operationally the same guard says: the ship must arrive slow compared with how fast
it flew. A solve at κ = 0.586 "arrives" at 4,172 km/s, which is not an arrival.

### 2.2 What the guard deliberately does *not* test

The obvious alternative guard — "the residual must be brakeable inside the stand-off
radius", `relativisticStopDistanceKm(|v_res|, α) ≤ R_arr` — was tried and
**rejected: it fails the canonical Mars route.** At J2026 the Earth/Mars velocity
difference makes the residual 63.5 km/s, whose stop distance is 2.02 × the 3-radius
Mars stand-off. The profile is nonetheless completely correct; only the *insert*
phase is longer than the stand-off sphere. Measured insert budgets, as a fraction of
R_arr: Moon 0.045, Jupiter 0.0099, Neptune 0.103, Sun 4.2e-4, **Mars 2.02**.

Conflating "the solution is unreliable" with "the insert burn is long" would have
thrown away a good solve. They are separated: κ guards the former, and T0116 sizes
the latter with `relativisticStopDistanceKm` itself.

## 3. Interfaces

```ts
// sim/guidance/brakingEnvelope.ts
export function relativisticStopDistanceKm(relSpeedKmS: number, alphaMS2: number): number;
export function relativisticStopCoordSec(relSpeedKmS: number, alphaMS2: number): number;

// sim/guidance/constantAccelIntercept.ts
export interface CompiledRails { catalog; scratchState; scratchWorkspace }
export function createCompiledRails(catalog: CompiledRailsCatalog): CompiledRails;
export interface InterceptSolution {
  ok: boolean; totalCoordSec: number; flipAtCoordSec: number; totalProperSec: number;
  peakBeta: number; arrivalRadiusKm: number;
  iterations: number;              // ADDED — acceptance requires proving "<= 12"
  readonly aimUnit: Float64Array;  // ADDED — 3 components, the boost thrust axis
}
export function createInterceptSolution(): InterceptSolution;
export function solveInterceptInto(out, shipState, rails, targetIndex, alphaMS2,
  arrival, arrivalAltitudeKm, startSimTimeSec): void;
export const MAX_INTERCEPT_ITERATIONS = 25;
export const INTERCEPT_CONVERGENCE_SEC = 0.5;
export const MAX_INTERCEPT_CLOSING_RATIO = 0.1;
export const ORBIT_ARRIVAL_RADIUS_FACTOR = 3;
```

Two additions to the plan's `InterceptSolution`, both load-bearing:

- **`iterations`** — acceptance criterion 3 is a bound on iteration count. With the
  plan's six fields it is unobservable, and a test that cannot see the quantity it
  asserts is not a test. It is also what T0116 should log when a route degrades.
- **`aimUnit`** — the profile is *defined* by its thrust axis; without it nothing can
  fly the profile, including this task's own arrival-miss test. Putting it in the
  out-struct rather than in a second function is deliberate: the axis is only
  meaningful for the converged `T`, and a separate call invites a stale pairing.

On `ok = false` every numeric field is written `NaN` and `aimUnit` is zeroed, so a
consumer that ignores `ok` fails loudly instead of flying a plausible profile.

## 4. Failure modes (all return `ok = false`)

| # | Condition | Why it cannot be flown |
|---|---|---|
| 1 | `alphaMS2` not finite or ≤ 0 | no drive, no profile |
| 2 | `targetIndex` not an integer in range | no target |
| 3 | ship state non-finite, or `β₀ ≥ 1` | not a physical state |
| 4 | `arrivalAltitudeKm` non-finite or negative | ambiguous stand-off |
| 5 | no stand-off resolvable (`R_col ≤ 0` and no altitude) | body size unknown |
| 6 | separation ≤ `max(2·R_col, R_arr)` at `t₀` | already there — task's "target = current dominant body within 2 radii" |
| 7 | any iterate gives `d ≤ 0` or a non-finite `T` | aim point inside the stand-off sphere |
| 8 | not converged in 25 iterations | plan §3.3.2 |
| 9 | `κ > 0.1` at convergence | §2.1 — spurious or ill-conditioned root |

Case 7 also protects `evaluateRailsInto`, which **throws** `RangeError` on a
non-finite time. A guidance solver that throws inside a director's `update()` would
take the frame loop with it, so every iterate is validated before it reaches rails.

## 5. Model scope — the honest limits

These are the things T0116 must not assume away.

1. **No gravity in the solve.** Over a Mars leg the Sun displaces the ship ≈ 9e3 km
   (0.012% of the trip) and Earth's field adds ≈ 3 km/s of unmodelled Δv during the
   first few hundred seconds near LEO. Both are far larger than the 1e-6 kinematic
   miss and are the *actual* reason plan §3.3.4's mid-course re-solve exists.
2. **Arrival is at `v₀`, not at the target's velocity.** Residual
   `|v₀ − v_j(t_arr)|` measured 6.8–63.5 km/s on the canonical routes; the insert
   burn costs `|Δv|/α` seconds and `relativisticStopDistanceKm(|Δv|, α)` kilometres.
3. **The flip is instantaneous in the profile.** Reality costs
   `π / maxSlewRadPerSimS = 12.0 s` of simulation time (ADR-035). T0116 splits that
   around `flipAtCoordSec`.
4. **Departure solver only.** §2.1. Re-solve while slow; fly the endgame on plan
   §3.3.6's pursuit rule, which needs no TOF solve and is specified in physics-spec
   §8.7 but implemented in T0116.

## 6. Test plan

Co-located unit tests (`src/sim/guidance/*.test.ts`) for closed forms, degenerate
inputs and allocation behaviour; scenario tests in `tests/sim/guidance/` because they
read `data/bodies.json` from disk, matching where `tests/golden/` and
`tests/sim/ship/relativity.test.ts` already live.

1. **§8.1 closed forms vs DP54** — from-rest 1D profile through β = 0.9; position,
   celerity, β and τ to 1e-9 relative, reusing the `createRelativisticDerivative` +
   `propagate` harness of `tests/sim/ship/relativity.test.ts`.
2. **§8.2 brachistochrone** — `T_h` inverts the distance relation to 1e-12; the
   Newtonian limit `√(d/α)` and the photon limit `d/2c` are approached from the
   correct side; `γ_peak = 1 + αd/2c²` exactly.
3. **§8.3 stop distance** — vs `(c²/α)(γ−1)` to 1e-12 across β ∈ [1e-9, 0.999];
   Newtonian limit `v²/2α` to 1e-9 at β = 1e-6; `α ≤ 0 ⇒ +∞`; β ≥ 1 ⇒ +∞.
4. **Convergence** — the six routes of §2, asserting `ok`, `iterations ≤ 12`, and
   the plan's reference trip times.
5. **Arrival miss** — fly each profile with DP54 and assert
   `miss < 0.001 × d` (measured ≤ 8.7e-6).
6. **Degenerate** — one test per row of §4.
7. **Allocation** — solve 200 times into the same out-struct and assert the retained
   heap does not grow (the pattern `simulation.performance.test.ts` uses).
