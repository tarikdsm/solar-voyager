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
ADR-019 records the provisional full-catalog ceilings superseded by this T0023
calibration.

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

### 3.1 Integrator: Dormand–Prince 5(4), adaptive (ADR-002)

- Embedded RK5(4) pair, FSAL, standard DP54 tableau (cite Hairer–Nørsett–Wanner; tableau constants in `dp54.ts` must match the published values to full double precision).
- Integrated state is the 7-component `(r, u, τ)` of §3 (celerity formulation — the integrator can never overshoot past c).
- Error control: `err = |y5 − y4|` component-wise against `tol = absTol + relTol·|y|`, with `relTol = 1e-9`, `absTol = 1e-6 km` (position), `1e-9 km/s` (celerity), `1e-6 s` (τ). PI step controller: `h_new = h · min(5, max(0.2, 0.9·(1/err)^(1/5)))`.
- The propagator is a pure function: `propagate(state, t0, t1, derivFn, tol) → state` — shared verbatim by SimulationCore and the predictor worker.

### 3.2 Time warp

Ladder: `1, 5, 10, 50, 100, 1e3, 1e4, 1e5, 1e6, 1e7`. Per frame the sim advances `Δt = warp × wallDt`.

- **Thrust allowed at warp ≤ 1000** ("physics warp"). Above 1000x throttle is forced to 0 (coast).
- **Substep budget:** 4,000 accepted DP54 steps per frame. If the controller cannot cover `Δt` within budget (deep in a gravity well at high warp), warp auto-clamps to the highest sustainable tier; HUD shows the clamp and reason. Never trade accuracy for speed silently.

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

- **Headline HUD metric: cumulative E_spent, displayed in Wh** (1 Wh = 3600 J; internal unit J). Formatter uses SI prefixes k, M, G, T, P, E, Z, Y — values are astronomically large by design (a LEO plane change is TWh-scale; pushing toward c diverges as (γ−1)mc²). 3 significant digits, e.g. `4.82 PWh`.
- **Current power draw** `P = F·c` (W, same prefix formatter) shown live while thrusting.
- Secondary readouts:
  - **Proper Δv** `= ∫ α dτ` (m/s) — what the crew experiences; the orbital-mechanics currency at low speed.
  - **Kinetic energy change** `ΔE_kin`, with `E_kin = (γ−1)·m·c²` — exposes both the Oberth effect and the relativistic divergence near c.
- **Burn log entry** per contiguous thrust interval: `{t_start, t_end, τ_start, τ_end, E_spent, proper Δv, peak power, dominant body, prograde/normal/radial decomposition}`.
- **Why plane changes hurt (verify in tests):** E = c·|Δp| for any momentum change; leaving the ecliptic plane inherited from the solar system's angular momentum requires rotating a ~30 km/s momentum vector — the ledger must price that honestly (§7.8).
- **Launch losses** (deferred launch phase only): gravity loss `= ∫ (μ⊕/r²)·sin γ_fp dt`, drag loss `= ∫ (D/m) dt`.

## 6. Analysis

- **Solar-system barycenter (CM):** `r_cm = Σ mᵢrᵢ / Σ mᵢ`, `v_cm = Σ mᵢvᵢ / Σ mᵢ` over the whole catalog (masses from GM/G), evaluated per frame from rails. The HUD state-vector widget displays, **relative to the CM**: ship velocity `v − v_cm` (this starts at ~30 km/s in LEO — Earth's real orbital velocity, deliberately visible from the first frame), proper acceleration vector, **relativistic linear momentum** `p = γ·m·(v − v_cm)` and **angular momentum** `L = (r − r_cm) × p`. Also derived: speed as % of c, and γ.
- **Dominant body:** argmax over bodies of `μᵢ/|r − rᵢ|²`; SOI radii (`r_SOI = a·(m/M)^(2/5)`, precomputed in bodies.json) as tie-break/hysteresis (10% band to avoid flicker).
- **Osculating elements** wrt dominant body from state vectors (standard conversion via h, e, n vectors; handle e→0 and i→0 degeneracies explicitly). Computed every frame for the HUD; it is an *approximation* in an n-body field — the worker prediction is the truth.
- **Trajectory prediction:** worker propagates thrust-free with §3.1 over max(2 osculating periods, 90 days, user-extended); downsampled polyline ≤ 2000 points; events: SOI transitions, closest approach to target, **impact** (path crosses body radius + atmosphere top) with time-to-impact.
- **Warnings:** impact (red, with countdown), atmosphere entry, SOI change, escape from dominant body.

## 7. Regression & validation tests (must exist before v1)

1. **Kepler solver:** |E| residual < 1e-12 across e ∈ [0, 0.99] and hyperbolic e ∈ (1, 5]; round-trip elements ↔ state vectors to 1e-10 relative.
2. **Two-body DP54:** circular and e=0.7 orbits, 10 periods: position error vs analytic < 1e-3 km; energy and |h| drift < 1e-9 relative. This convergence regression uses the test-only verification profile `relTol = 2e-11`, `absTol = 2e-8 km` (position), and `2e-11 km/s` (velocity), still capped at 4,000 accepted steps. The operational ship profile remains the §3.1 profile and is separately required to cover both ten-period cases within that budget; local operational tolerance is not a promise of the stricter accumulated ten-period global error.
3. **Rails accuracy:** vs `ephemerides-check.json` within §2 bounds.
4. **Launch regression** *(deferred with §4)*: scripted throttle/pitch profile reaches 200±5 km orbit; total Δv within ±1% of the golden value; max-q within ±2%.
5. **Handoff** *(deferred with §4)*: energy/angular-momentum round-trip < 1e-9 relative.
6. **Golden trajectories:** three 30-day unpowered ship propagations (400 km LEO, post-Earth-SOI Earth–Mars transfer coast, Jupiter flyby) start at J2026 and use the production §3.1 tolerance profile against the full §2/§3 rails-plus-n-body field. Store the initial state and 31 samples at one-day cadence in `tests/golden/`; each daily segment must finish within the 4,000 accepted-step budget or fail loudly. Compare every `(r, u, τ)` sample component. The many-step adaptive LEO case uses cross-runtime absolute drift limits of `2e-2 km` for position, `2e-5 km/s` for celerity, and `1e-6 s` for proper time; the transfer and flyby retain `1e-3 km`, `1e-9 km/s`, and `1e-6 s`, respectively (ADR-017). Any change that moves them requires an explicit golden update in the PR (reviewable diff).
7. **Ledger:** proper Δv of an impulsive-approximation Hohmann LEO→GEO within 1% of the analytic 3.90 km/s; E_spent for the same maneuver within 1% of c·m·Δv.
8. **Relativistic kinematics:** constant proper acceleration α from rest — analytic hyperbolic-motion solution `v(t) = αt/√(1+(αt/c)²)`, `τ(t) = (c/α)·asinh(αt/c)`: DP54 matches to 1e-9 relative over a span reaching γ = 10; |v| < c strictly at all times; γ from u exact.
9. **Newtonian limit:** the full relativistic propagator vs the pure Newtonian model from the same coordinate state on a 10-orbit circular LEO coast — final position separation < 5e-8 relative. The expected accumulated phase separation is ≈ 4.12e-8 under the §3 celerity dynamics even though γ−1 ≈ 3e-10 instantaneously (ADR-012).
10. **Plane-change pricing:** rotating a 30 km/s velocity vector by 90° at constant speed via continuous thrust — ledger E_spent within 2% of the analytic ∫Fc dt for the flown profile, and strictly greater than c·m·|Δp| (the impulsive lower bound).
11. **Time dilation:** 1 year of coordinate time at γ = 2 yields τ within 1e-9 of t/2 (with dτ integrated, not recomputed).
12. **N-body field:** single-body inverse-square acceleration relative error < 1e-14. In an ideal circular Earth-Sun barycentric rotating frame, independently solved L1 lies 1.4e6–1.6e6 km from Earth and satisfies `|g_x + n²·x| / max(|g_x|, |n²·x|) < 1e-10`; Coriolis acceleration is zero for this stationary rotating-frame point.
