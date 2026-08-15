# Physics Specification — Solar Voyager

This is the contract all physics code and tests are written against. Implementations must cite the section they implement. If you need a formula that is not here, add it here in the same PR.

## 1. Units, frames, epoch

| Quantity | Unit |
|---|---|
| Length | km |
| Velocity | km/s |
| Time | s (float64 TDB seconds since epoch) |
| GM (μ) | km³/s² |
| Angles | rad internally; deg only at the UI boundary |
| Energy | J internally; **Wh on the HUD** (1 Wh = 3600 J), SI prefixes k…Y |
| Power | W (same prefix formatter) |

- **Epoch:** J2026 = 2026-01-01 00:00:00 TDB. Sim time `t` = seconds since this epoch (float64). Ship proper time τ integrated separately (§3).
- **c = 299792.458 km/s** (exact) in `core/constants.ts`.
- **Frame:** heliocentric, ecliptic J2000 (ICRF-aligned). +X toward the J2000 vernal equinox, +Z toward the north ecliptic pole.
- **All physics state is float64.** float32 exists only on the GPU side (see rendering-spec).
- Constants: `AU = 1.495978707e8 km`, `G` never used directly — bodies carry GM (more precise).
- Precision check: at Neptune (4.5e9 km) float64 resolution ≈ 1e-6 km = 1 mm. One global frame suffices.

## 2. Celestial bodies — analytic Keplerian rails (ADR-001)

Each body carries osculating elements at epoch, baked from JPL Horizons (`tools/bake_ephemerides.py` → `data/bodies.json`):

`{a, e, i, Ω, ω, M₀}` — heliocentric for planets/dwarfs/asteroids/comets; **parent-relative** for moons (Moon → Earth, Io → Jupiter, ...).

Position at time t:

1. Mean anomaly: `M = M₀ + n·(t − t₀)`, `n = √((μ_parent + μ_body)/a³)` (elliptic) or `√((μ_parent + μ_body)/(−a)³)` (hyperbolic).
2. Solve Kepler's equation by Newton–Raphson to |Δ| < 1e-12 rad, max 30 iterations:
   - Elliptic: `M = E − e·sin E`, start `E₀ = M` (or `π` if e > 0.8).
   - Hyperbolic objects: `M = e·sinh H − H` (body kind does not select the branch; the v1 comets are elliptic at J2026, ADR-018).
3. True anomaly, radius → perifocal position/velocity → rotate by `Rz(Ω)·Rx(i)·Rz(ω)` into the parent frame.
4. Moons: add parent's heliocentric state (evaluated recursively).

Properties: O(1) per body, exact evaluation at any t (no drift at any warp), deterministic saves.

**Accuracy bounds** (regression-tested vs `data/ephemerides-check.json` Horizons vectors;
cells show measured class maximum / regression limit):

| Body class | position @ +30 d (measured / limit) | position @ +365 d (measured / limit) |
|---|---:|---:|
| Planets and Moon (Luna) | 34,077.128 / 38,000 km | 1,159,878.882 / 1,300,000 km |
| Dwarfs, Mars moons, Charon | 65,375.338 / 72,000 km | 815,969.108 / 900,000 km |
| Giant-planet moons | 186,935.792 / 210,000 km | 644,966.151 / 710,000 km |
| Asteroids and comets | 3,428.256 / 3,800 km | 645,327.779 / 710,000 km |

| Body class | velocity @ +30 d (measured / limit) | velocity @ +365 d (measured / limit) |
|---|---:|---:|
| Planets and Moon (Luna) | 0.0376412 / 0.042 km/s | 0.252232 / 0.28 km/s |
| Dwarfs, Mars moons, Charon | 0.950343 / 1.1 km/s | 1.902382 / 2.1 km/s |
| Giant-planet moons | 14.653602 / 17 km/s | 25.025758 / 28 km/s |
| Asteroids and comets | 0.00267517 / 0.0030 km/s | 0.0475048 / 0.053 km/s |

Limits are the measured maximum multiplied by 1.10 and rounded upward to two
significant digits. The Sun remains exact. Every catalog id must belong to a
calibrated class, so catalog growth fails CI until this table and the regression are
updated. Errors come from neglected mutual perturbations; resulting orbits remain
physically plausible. ADR-015 records the original planet/Luna calibration and
ADR-019 records the provisional full-catalog ceilings superseded by the calibrated
position-and-velocity contract in ADR-020.

## 3. Ship dynamics — full n-body + thrust, special-relativistic (ADR-007)

The ship is relativistic; bodies are not (they stay on rails, §2). `c = 299792.458 km/s` (in `core/constants.ts`).

**State:** `(r, u, τ)` — position (km), **proper velocity (celerity) u = γv** (km/s), ship proper time τ (s). Derived:

```
γ = √(1 + |u|²/c²)        v = u/γ        (|v| < c always, by construction)
```

**Equations of motion** (coordinate time t):

```
dr/dt = v = u/γ
du/dt = g(r, t) + (F_thrust/m)·û          # thrust as PROPER acceleration α = F/m
dτ/dt = 1/γ                               # time dilation, integrated alongside
g(r, t) = Σ_i −μᵢ · (r − rᵢ(t)) / |r − rᵢ(t)|³     # Newtonian n-body field, ALL ~50 bodies
```

û = attitude unit vector, m = constant rest mass (propellantless drive, ADR-007). Approximations (documented limits): gravity is a Newtonian force on rest mass — no GR, no light-delay of the field; exact SR kinematics otherwise. At v ≪ c this reduces to the Newtonian model term-for-term (γ→1, u→v, τ→t).

**Emergent feel (do not script it):** coordinate acceleration parallel to v falls as α/γ³ — the drive feels "heavier" the faster you go; combined with E = c·|Δp| cost (§5), expensive maneuvers (plane changes, near-c pushes, ecliptic escapes) are *felt* as sluggish response, like a power-limited vehicle.

### 3.0.1 Attitude and commanded proper acceleration (ADR-025, ADR-034, ADR-035)

Attitude quaternion order is `[x,y,z,w]`; it rotates the ship-local `+X`
nose/drive axis into the inertial ecliptic frame. Both `α_max` and the rest mass
`m_kg` come from the session's `VesselConfig` (`sim/ship/vessel.ts`, ADR-034),
which is serialized with the simulation state. The default vessel is the 10 t
torchship with `α_max = alphaMaxMS2 = 98.0665 m/s² = 0.0980665 km/s²` (10 g);
before ADR-034 the default was standard gravity, `9.80665 m/s²`. The vessel also
carries `alphaManualMaxMS2 = 19.6133 m/s²` (2 g), a *regime* ceiling applied by
the flight controller in the game layer — the simulation itself commands only
against the absolute `α_max`. For throttle fraction `f ∈ [0,1]`:

```
α_vector = f · α_max · forward
F_N = m_kg · (1000 · |α_vector|)
P_W = F_N · (1000 · c_km/s)
```

Automatic orbital holds use the instantaneous maximum-gravity body
`argmax_i μ_i/|r-r_i|²` as reference. With `r_rel=r-r_body` and
`v_rel=v-v_body`: prograde/retrograde are `±normalize(v_rel)`, radial out/in
are `±normalize(r_rel)`, and normal/antinormal are
`±normalize(r_rel × v_rel)`. Target hold is `normalize(r_target-r)`.
Degenerate directions retain the previous finite forward vector.

#### Hold-mode slew (ADR-035)

The solved direction is a *target*, not the attitude. `q_target(t)` is the
minimum-rotation (zero-roll) quaternion taking `+X` to that direction, and the
ship pursues it along the shortest-path geodesic at no more than the vessel's
`maxSlewRadPerSimS` (default `0.261799 rad/s` = 15°/s, ADR-034):

```
Δt      = t − t_frame_start                      # elapsed SIM time in this frame
θ_err   = 2·atan2(|vec(q_rel)|, |w(q_rel)|),  q_rel = conj(q_frame_start) ⊗ ±q_target(t)
θ_step  = min(θ_err, maxSlewRadPerSimS · Δt)
q(t)    = slerp(q_frame_start, q_target(t), θ_step / θ_err)   ; = q_target(t) when θ_step = θ_err
```

`±q_target` is sign-folded so `dot ≥ 0`, keeping the slew on the shorter of the
two double-cover paths, so `θ_err ∈ [0, π]`. Thrust uses the attitude actually
held, `û = forward(q(t))`, not the target.

The budget is measured from the **start of the frame** and never accumulated per
derivative evaluation or per accepted step. The attitude is therefore a pure
function of `(q_frame_start, t_frame_start, t, state(t))`, so rejected DP54
steps, warp-ladder rollback (§3.2) and a change of tolerance all reproduce the
same quaternion. When the budget covers the whole separation the target is
adopted exactly, so a *converged* hold tracks its target exactly and is
unaffected by frame size. The slew *transient* is frame-size dependent at
`O(ω_target·Δt_frame)`; the ledger (§5) is not, because `E` and scalar `Δv`
depend on `|α|` only.

Convergence holds wherever `|dq_target/dt| < maxSlewRadPerSimS`, which is
everywhere except a small neighbourhood of the coordinate singularity of the
zero-roll target map. `writeQuaternionFromForwardInto` is undefined at inertial
`−X̂`; for a hold direction sweeping past it at angular distance `ε` and rate
`ω`, the target quaternion's *roll* rate is

```
|dq_target/dt| ≈ 2ω/ε          ⇒  copy branch is lost for ε < 2ω / maxSlewRadPerSimS
```

At the LEO rate `ω = 1.131e-3 rad/s` that threshold is `ε ≈ 8.6e-3 rad ≈ 0.5°`
(measured: 29% of the limit at `ε = 0.03`, 86% at `0.01`, 288% at `0.003`).
Inside it the hold lags and the published quaternion becomes frame-size
dependent. The lag is almost pure roll — the heading component stays bounded by
`ω` — so the thrust axis `û` and everything derived from it are unaffected; only
the rendered roll and any convergence *predicate* are.

A 180° reorientation costs `π / maxSlewRadPerSimS = 12.0 s` of **simulation**
time at every warp tier, hence `12.0 s / warp` of wall time — 12 s at 1x,
2.4 s at 5x, 0.24 s at 50x.

#### Manual body rates and wall-time authority (ADR-035)

Manual rates are body-frame angular velocity `ω` in rad per **simulated** second.
Within one propagation call they are constant and evaluated exactly at every DP54
stage. With `+X` forward, roll is about `+X`, pitch about `+Y`, and yaw about
`+Z` (`Commands.rotate` takes `(pitch, yaw, roll)` and is reordered to that axis
convention on entry):

```
q(t) = normalize(q0 ⊗ [axis(ω)·sin(|ω|Δt/2), cos(|ω|Δt/2)])
```

Because `ω` is per simulated second, a fixed control deflection would spin the
ship `warp` times faster in wall time. `RATE_MAX = 0.6` is therefore the
vehicle's rotational authority **in the wall frame**, and the flight controller
(`game/flight/flightController.ts`, T0108) saturates against it *before*
converting:

```
rateWallRadS = clamp(controlLawOutputRadS, −RATE_MAX, +RATE_MAX)      # wall frame
rateSimRadS  = clamp(rateWallRadS / effectiveWarp, −RATE_MAX, +RATE_MAX)
```

The order is load-bearing. The game-layer control law is a pursuit, so its raw
output is unbounded — a 180° error asks for 2.85 rad/s at the shipped gains —
and clamping only *after* the division would admit `RATE_MAX` of **sim** rate at
every tier, i.e. `RATE_MAX · effectiveWarp` of wall rotation: 30 rad/s at 50x,
the v1 tumble this rule exists to prevent. With the wall-frame saturation first,
the **sim-frame envelope is `RATE_MAX / effectiveWarp`** (0.6 rad/s at 1x,
0.012 rad/s at 50x), and the second clamp is a no-op for any input already
bounded by `RATE_MAX` whenever `effectiveWarp ≥ 1`, which the whole ladder
satisfies. It is retained because it is the bound the simulation is entitled to
assume of anything reaching `Commands.rotate`.

Only *commanded* input is normalized. A body rate already held in the command
state is physical angular momentum and a tier change does not touch it: a ship
left coasting at `ω` keeps `ω` per simulated second and therefore appears to
rotate `effectiveWarp` times faster, exactly as every other motion does under
time compression. Reaching that state requires disabling the game layer's
stability assist, which otherwise damps rotation to rest whenever the controls
are released.

Manual rotation is locked above `MANUAL_ATTITUDE_MAX_WARP = 100`
(`core/time.ts`): `Commands.rotate` forces the rates to zero there, and raising
warp past the tier clears any rates already commanded — the same shape as the
`MAX_THRUST_WARP` throttle lockout in §3.2. Attitude holds remain available at
every tier.

The endpoint attitude commits only when the propagation succeeds. Hold-mode
directions are recomputed at every stage, so thrust follows the curved orbit.

### 3.1 Integrator: Dormand–Prince 5(4), adaptive (ADR-002)

- Embedded RK5(4) pair, FSAL, standard DP54 tableau (cite Hairer–Nørsett–Wanner; tableau constants in `dp54.ts` must match the published values to full double precision).
- Integrated state is the 7-component `(r, u, τ)` of §3 (celerity formulation — the integrator can never overshoot past c).
- Error control: `err = |y5 − y4|` component-wise against `tol = absTol + relTol·|y|`, with `relTol = 1e-9`, `absTol = 1e-6 km` (position), `1e-9 km/s` (celerity), `1e-6 s` (τ). PI step controller: `h_new = h · min(5, max(0.2, 0.9·(1/err)^(1/5)))`.
- The propagator is a pure function: `propagate(state, t0, t1, derivFn, tol) → state` — shared verbatim by SimulationCore and the predictor worker.

### 3.2 Time warp

Ladder: `1, 5, 10, 50, 100, 1e3, 1e4, 1e5, 1e6, 1e7`. Per frame the sim advances `Δt = warp × wallDt`.

- **Thrust allowed at warp ≤ 1000** ("physics warp"). Above 1000x throttle is forced to 0 (coast).
- **Substep budget:** 4,000 accepted DP54 steps per frame. If the controller cannot cover `Δt` within budget (deep in a gravity well at high warp), warp auto-clamps to the highest sustainable tier; HUD shows the clamp and reason. Never trade accuracy for speed silently.

The highest sustainable tier is selected by integrating ascending canonical
tier endpoints with one cumulative accepted-step budget. Every completed tier
is a rollback checkpoint; a partially completed next tier is discarded. The
published `effectiveWarp` is therefore always a ladder member and coordinate
time advances by exactly `wallDt · effectiveWarp`. If 1x itself cannot finish,
the frame fails without publishing. DP54 tolerances are never relaxed.

Entering a requested tier above 1000x clears active throttle and invalidates
the thrust trajectory once. Positive throttle commands remain forced to zero
until the requested tier returns to 1000x or below; lowering warp does not
restore prior throttle intent. `INTEGRATION_BUDGET` takes reason priority when
the effective tier is reduced; otherwise sustainable coast-only warp reports
`THRUST_LOCKOUT`.

### 3.3 Optional mutual n-body mode ("dynamic bodies", default OFF)

Bodies integrated mutually with velocity-Verlet (leapfrog), fixed 300 s step, on a worker; warp capped at 1e5x. Symplectic ⇒ bounded energy error. Regression: 1-year inner-system integration, relative energy drift < 1e-9.

## 4. Launch phase (2D) — DEFERRED (optional post-v1 expansion)

> **Scope note (2026-07-15):** this entire section is fully specified but **not part of v1**. v1 starts with the ship in a 400 km LEO. Keep this spec current; implement via tasks T0060–T0062 when the launch expansion is prioritized.

### 4.1 State & frame

Earth-centered inertial polar coordinates in the launch plane: `(r, φ, ṙ, φ̇)`. Point-mass rocket, constant mass. Alcântara: latitude −2.3236°, longitude −44.3672°, pad altitude ≈ 40 m.

Initial conditions on the pad: `r = R⊕ + h_pad`, `ṙ = 0`, `φ̇ = ω⊕` (Earth rotation, ω⊕ = 7.2921159e-5 rad/s ⇒ ~464.7 m/s eastward at Alcântara — the equatorial launch bonus, shown on the HUD).

### 4.2 Equations of motion (polar — angular momentum conservation is intrinsic)

```
r̈  = r·φ̇² − μ⊕/r² + (T·cos(θ−γ') + D_r)/m ...decomposed as:
r̈  = r·φ̇²  −  μ⊕/r²  +  a_thrust,r  +  a_drag,r
φ̈  = (−2·ṙ·φ̇  +  a_thrust,t  +  a_drag,t) / r
```

Thrust direction = pitch angle θ measured from local horizontal (player-controlled pitch rate, |θ̇| ≤ 4°/s; optional prograde-hold sets θ to the surface-relative velocity direction).

### 4.3 Atmosphere — US Standard Atmosphere 1976

- Seven lapse-rate layers 0–86 km (base altitudes/temperatures/lapse rates per USSA-1976 tables, geopotential altitude), exponential extrapolation 86–120 km, ρ = 0 above 120 km.
- Outputs: T(h), p(h), ρ(h), speed of sound `a = √(γRT)`, γ = 1.4, R = 287.053 J/(kg·K).

### 4.4 Drag

```
v_rel = v − v_atm         (atmosphere co-rotates: v_atm,tangential = ω⊕·r for h < 90 km,
                           linearly tapering to 0 between 90 and 200 km)
D = ½ · ρ(h) · |v_rel|² · Cd(M) · A ,  opposite v_rel
```

Cd(Mach) lookup (linear interpolation): `0.0→0.30, 0.8→0.35, 1.0→0.55, 1.2→0.50, 2.0→0.40, 5.0→0.28, ≥10→0.25`. Reference area A and thrust T from the ship config.

Dynamic pressure `q = ½ρ|v_rel|²` reported every step; max-q recorded and called out.

### 4.5 Integrator & warp

Fixed-step classical RK4 at 100 Hz substeps (reproducible for regression tests). Launch warp ≤ 10x.

### 4.6 Handoff 2D → 3D (`sim/launch/handoff.ts`)

Trigger: altitude > 140 km (drag ≈ 0 there; the 90–200 km taper means residual drag at 140 km is negligible for handoff purposes).

1. 2D polar state → Cartesian position/velocity in the launch plane.
2. Embed the plane in Earth-centered ICRF: for a due-east launch from latitude φ_L, inclination `i = φ_L` (2.3236°); RAAN chosen so the orbital plane contains Alcântara's inertial position at ignition (computed from GMST/Earth rotation angle at t_launch). Full derivation with explicit rotation matrices lives here when implemented — the implementing PR must write out the matrices in this section.
3. Rotate ECI (equatorial) → ecliptic J2000 (obliquity ε = 23.43928°): `r_ecl = Rx(−ε)·r_eq`.
4. Add Earth's heliocentric rails state at t: `r_helio = r_ecl + r⊕(t)`.

**Tests:** round-trip specific energy and angular momentum (2D values vs 3D Earth-relative values) agree to 1e-9 relative.

## 5. Energy / Δv ledger — pure-energy propulsion (ADR-007)

Propulsion is propellantless; the physically honest cost model is the **photon-drive bound**:

```
P = F·c            (drive power for thrust F; braking and turning cost the same as accelerating)
E_spent = ∫ P dt   (coordinate time; integrated inside the same substeps as motion — warp-invariant)
```

`SimulationCore` integrates five private ledger quadratures alongside
`(r,u,τ)` without expanding the public seven-component ship state. For
`α_vector` in km/s²:

```
dE/dt = m · (1000·|α_vector|) · (1000·c)
d(proper Δv)/dt = (1000·|α_vector|)/γ
d(proper Δv_vector)/dt = (1000·α_vector)/γ
```

Ledger components use the same accepted/rejected DP54 stages and transactional
rollback as motion. The vector is an inertial signed integral; scalar proper
Δv is its non-negative path integral.

- **Headline HUD metric: cumulative E_spent, displayed in Wh** (1 Wh = 3600 J; internal unit J). Formatter uses SI prefixes k, M, G, T, P, E, Z, Y — values are astronomically large by design (a LEO plane change is TWh-scale; pushing toward c diverges as (γ−1)mc²). 3 significant digits, e.g. `4.82 PWh`.
- **Current power draw** `P = F·c` (W, same prefix formatter) shown live while thrusting.
- Secondary readouts:
  - **Proper Δv** `= ∫ α dτ` (m/s) — what the crew experiences; the orbital-mechanics currency at low speed.
  - **Kinetic energy change** `ΔE_kin`, with `E_kin = (γ−1)·m·c²` — exposes both the Oberth effect and the relativistic divergence near c.
- **Burn log entry** per contiguous thrust interval: `{t_start, t_end, τ_start, τ_end, E_spent, proper Δv, peak power, dominant body, prograde/normal/radial decomposition}`. The dominant body and normalized local axes are captured at burn start: `prograde = normalize(v_rel)`, `normal = normalize(r_rel × v_rel)`, `radial = normalize(r_rel)`. Components are signed dot products of the integrated inertial proper-Δv vector with those start axes. History is a preallocated 256-entry ring; oldest entries are overwritten.
- **Why plane changes hurt (verify in tests):** E = c·|Δp| for any momentum change; leaving the ecliptic plane inherited from the solar system's angular momentum requires rotating a ~30 km/s momentum vector — the ledger must price that honestly (§7.8).
- **Launch losses** (deferred launch phase only): gravity loss `= ∫ (μ⊕/r²)·sin γ_fp dt`, drag loss `= ∫ (D/m) dt`.

## 6. Analysis

### 6.1 Observer-frame radiative rendering (ADR-031)

Relativistic visual presentation is derived from simulation state without
feeding back into the integrator. For observer velocity
`beta = v_observer/c`, Lorentz factor `gamma`, and an inertial unit direction
`n` from observer to source, define:

- `q = beta dot n`
- `k = ((gamma - 1)/|beta|^2) q + gamma`
- `n_observed = (n + k beta) / (gamma (1 + q))`
- `D = gamma (1 + q) = 1 / (gamma (1 - beta dot n_observed))`

`n_observed` is the aberrated source direction and `D` is the observed-to-
emitted frequency ratio. The Lorentz invariant `I_nu/nu^3` gives a bolometric
headlight-beaming basis proportional to `D^3`. Rendering uses the bounded color
and gain mapping in rendering-spec section 10, faded continuously from identity;
these presentation bounds do not alter the physical definitions above.

- **Solar-system barycenter (CM):** `r_cm = Σ mᵢrᵢ / Σ mᵢ`, `v_cm = Σ mᵢvᵢ / Σ mᵢ` over the whole catalog (masses from GM/G), evaluated per frame from rails. The HUD state-vector widget displays, **relative to the CM**: ship velocity `v − v_cm` (this starts at ~30 km/s in LEO — Earth's real orbital velocity, deliberately visible from the first frame), proper acceleration vector, **relativistic linear momentum** `p = γ·m·(v − v_cm)` and **angular momentum** `L = (r − r_cm) × p`. Also derived: speed as % of c, and γ.
- **Dominant body:** start from the instantaneous argmax over bodies of
  `gᵢ = μᵢ/|r − rᵢ|²`, then apply the catalogued SOI hierarchy and a 10% band
  (ADR-029). With previous dominant `D` and raw challenger `C`:
  - no valid `D` publishes `C` immediately;
  - a descendant `C` replaces its ancestor `D` only when
    `g_C > 1.1·g_D` and `|r-r_C| ≤ 0.9·r_SOI,C`;
  - an ancestor `C` cannot reclaim dominance while
    `|r-r_D| ≤ 1.1·r_SOI,D`, and afterward still requires
    `g_C > 1.1·g_D`;
  - unrelated contenders require `g_C > 1.1·g_D`.
  SOI radii use `r_SOI = a·(m/M)^(2/5)` and are precomputed in bodies.json;
  the root's null SOI is compiled as infinity.
- **Osculating elements** wrt dominant body from state vectors (standard conversion via h, e, n vectors; handle e→0 and i→0 degeneracies explicitly). Computed every frame for the HUD; it is an *approximation* in an n-body field — the worker prediction is the truth.
- **Trajectory prediction:** worker propagates thrust-free with §3.1 over
  `max(2 osculating periods, 90 days, user-extended)`. Production requests
  2,000 output points; setup-time test requests may ask for fewer, and every
  request is capped at 2,000 with a minimum of two. Absent impact, the initial
  and horizon endpoints are included at uniform coordinate-time spacing. The seven-component
  state is propagated sequentially between adjacent output times with the
  production DP54 tolerance, rails, full n-body field, relativistic derivative,
  and zero proper acceleration. Each propagation call is limited to exactly one
  accepted DP54 step, carries `nextStepSec` into the next call, and repeats until
  the output time is reached; the production 4,000-step budget applies per
  output interval.
- SOI and target events are evaluated at each emitted point. SOI changes reuse the
  §6 hysteretic selector and encode the previous and next body. Target closest
  approach is the earliest minimum sampled target-centre distance. Collision
  radius is `meanRadiusKm + atmosphereTopKm`, with absent atmosphere top treated
  as zero. Impact is tested across every accepted DP54 step in each body's
  linearly interpolated relative frame. With `r0 = ship0 - body0`,
  `r1 = ship1 - body1`, and `d = r1 - r0`, solve `|r0 + f·d|² = R²`; when
  `|r0| > R`, the smallest root `f ∈ [0,1]` is the entry crossing. The earliest
  crossing in coordinate time wins, with catalog order breaking an exact tie.
  Its ship position and time are linearly interpolated, replace the pending
  output sample as the final polyline point, and stop both propagation loops.
  Impact time-to-impact is crossing time minus prediction start time (ADR-030).
- **Surface contact (live simulation, ADR-036).** The predictor above is
  thrust-free and advisory; the flown trajectory is tested independently in
  `SimulationCore`, so a powered descent the forecast never saw still collides.
  The collision sphere is the same `meanRadiusKm + atmosphereTopKm` (absent
  atmosphere top treated as zero), and for the four giants `atmosphereTopKm` is
  `equatorialRadius(1 bar) − meanRadiusKm`, making the sphere the smallest one
  containing the 1-bar oblate spheroid. Per **accepted** DP54 step, every body is
  tested in two stages. Stage one solves the same `|r0 + f·d|² = R²` root as
  above over the step's chord, sharing `smallestUnitRoot`; because the chord of a
  gravitating arc sags toward the attractor (≈ 0.31 km over a typical LEO step)
  this stage is a deliberate superset and is never authoritative. Stage two
  re-propagates the sub-interval with the production tolerance and bisects the
  first genuinely penetrating time to **1 ms**, reporting the low bracket
  endpoint, so the ship comes to rest at or outside the sphere and the central
  singularity of §3's n-body field stays unreachable for it. A segment that opens
  at or inside a sphere is immediate contact at its own start time. On contact
  the integrator freezes: coordinate time stops, warp is forced to 1x, throttle
  to zero, and the snapshot publishes `impactOccurred`, `impactBodyIndex`,
  `impactSpeedKmS` (`|v_ship − v_body|` in coordinate velocity; body rotation
  excluded) and `impactSimTimeSec`. The freeze is derived geometry and is not
  persisted; a reloaded impacted document re-derives it on its first step.
- **Warnings:** impact (red, with countdown), atmosphere entry, SOI change, escape from dominant body.

## 7. Regression & validation tests (must exist before v1)

1. **Kepler solver:** |E| residual < 1e-12 across e ∈ [0, 0.99] and hyperbolic e ∈ (1, 5]; round-trip elements ↔ state vectors to 1e-10 relative.
2. **Two-body DP54:** circular and e=0.7 orbits, 10 periods: position error vs analytic < 1e-3 km; energy and |h| drift < 1e-9 relative. This convergence regression uses the test-only verification profile `relTol = 2e-11`, `absTol = 2e-8 km` (position), and `2e-11 km/s` (velocity), still capped at 4,000 accepted steps. The operational ship profile remains the §3.1 profile and is separately required to cover both ten-period cases within that budget; local operational tolerance is not a promise of the stricter accumulated ten-period global error.
3. **Rails accuracy:** vs `ephemerides-check.json` within §2 bounds.
4. **Launch regression** *(deferred with §4)*: scripted throttle/pitch profile reaches 200±5 km orbit; total Δv within ±1% of the golden value; max-q within ±2%.
5. **Handoff** *(deferred with §4)*: energy/angular-momentum round-trip < 1e-9 relative.
6. **Golden trajectories:** three 30-day unpowered ship propagations (400 km LEO, post-Earth-SOI Earth–Mars transfer coast, Jupiter flyby) start at J2026 and use the production §3.1 tolerance profile against the full §2/§3 rails-plus-n-body field. Store the initial state and 31 samples at one-day cadence in `tests/golden/`; each daily segment must finish within the 4,000 accepted-step budget or fail loudly. Compare every `(r, u, τ)` sample component. The many-step adaptive LEO case uses cross-runtime absolute drift limits of `2e-2 km` for position, `2e-5 km/s` for celerity, and `1e-6 s` for proper time; the transfer and flyby retain `1e-3 km`, `1e-9 km/s`, and `1e-6 s`, respectively (ADR-017). Any change that moves them requires an explicit golden update in the PR (reviewable diff).
7. **Ledger:** proper Δv of an impulsive-approximation Hohmann LEO→GEO within 1% of the analytic 3.90 km/s; E_spent for the same maneuver within 1% of c·m·Δv. Each burn starts from an aligned ship: since ADR-035 a prograde hold slews at `maxSlewRadPerSimS` rather than snapping, so the scenario coasts `θ_err / maxSlewRadPerSimS` before opening the throttle. Alignment is a precondition of the scenario, never a relaxation of the 1% bounds.
8. **Relativistic kinematics:** constant proper acceleration α from rest — analytic hyperbolic-motion solution `v(t) = αt/√(1+(αt/c)²)`, `τ(t) = (c/α)·asinh(αt/c)`: DP54 matches to 1e-9 relative over a span reaching γ = 10; |v| < c strictly at all times; γ from u exact.
9. **Newtonian limit:** the full relativistic propagator vs the pure Newtonian model from the same coordinate state on a 10-orbit circular LEO coast — final position separation < 5e-8 relative. The expected accumulated phase separation is ≈ 4.12e-8 under the §3 celerity dynamics even though γ−1 ≈ 3e-10 instantaneously (ADR-012).
10. **Plane-change pricing:** rotating a 30 km/s velocity vector by 90° at constant speed via continuous thrust — ledger E_spent within 2% of the analytic ∫Fc dt for the flown profile, and strictly greater than c·m·|Δp| (the impulsive lower bound).
11. **Time dilation:** 1 year of coordinate time at γ = 2 yields τ within 1e-9 of t/2 (with dτ integrated, not recomputed).
12. **N-body field:** single-body inverse-square acceleration relative error < 1e-14. In an ideal circular Earth-Sun barycentric rotating frame, independently solved L1 lies 1.4e6–1.6e6 km from Earth and satisfies `|g_x + n²·x| / max(|g_x|, |n²·x|) < 1e-10`; Coriolis acceleration is zero for this stationary rotating-frame point.
13. **Hold-mode slew (§3.0.1, ADR-035):** a step of `θ_step` toward a target `θ_err` away lands on the great circle at exactly `θ_step`, and composing N steps of `θ_step/N` reproduces it to 1e-14. A 90° hold converges in `θ_err / maxSlewRadPerSimS` within one frame; a 180° reversal costs `π / maxSlewRadPerSimS = 12.0 s` of simulation time at every warp tier, i.e. `12.0 s / warp` of wall time (≤ 2.5 s at 5x, ≤ 0.25 s at 50x). One frame reached through the warp ladder, or integrated at a different tolerance, or published after a budget-exhausted tier was rolled back, yields the same attitude as that frame integrated in a single segment, to 1e-12. A converged prograde hold is slew-rate-independent: against an unbounded rate (which reproduces the pre-ADR-035 law up to the ≤ 5.6e-8 rad thrust-direction round trip of §3.0.1) one LEO orbit drifts < 1e-3 km. At 1x versus 100x a converged hold agrees on energy and proper Δv to 1e-12 and on position, celerity, attitude and the per-axis burn decomposition to 1e-9 km / 1e-12 km/s / 1e-12 rad.
