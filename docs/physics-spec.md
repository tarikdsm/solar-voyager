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

- **Epoch:** J2026 = 2026-01-01 00:00:00 TDB. Sim time `t` = seconds since this epoch (float64).
- **Frame:** heliocentric, ecliptic J2000 (ICRF-aligned). +X toward the J2000 vernal equinox, +Z toward the north ecliptic pole.
- **All physics state is float64.** float32 exists only on the GPU side (see rendering-spec).
- Constants: `AU = 1.495978707e8 km`, `G` never used directly — bodies carry GM (more precise).
- Precision check: at Neptune (4.5e9 km) float64 resolution ≈ 1e-6 km = 1 mm. One global frame suffices.

## 2. Celestial bodies — analytic Keplerian rails (ADR-001)

Each body carries osculating elements at epoch, baked from JPL Horizons (`tools/bake_ephemerides.py` → `data/bodies.json`):

`{a, e, i, Ω, ω, M₀}` — heliocentric for planets/dwarfs/asteroids/comets; **parent-relative** for moons (Moon → Earth, Io → Jupiter, ...).

Position at time t:

1. Mean anomaly: `M = M₀ + n·(t − t₀)`, `n = √(μ_parent/a³)` (elliptic) or `√(μ_parent/(−a)³)` (hyperbolic).
2. Solve Kepler's equation by Newton–Raphson to |Δ| < 1e-12 rad, max 30 iterations:
   - Elliptic: `M = E − e·sin E`, start `E₀ = M` (or `π` if e > 0.8).
   - Hyperbolic (comets): `M = e·sinh H − H`.
3. True anomaly, radius → perifocal position/velocity → rotate by `Rz(Ω)·Rx(i)·Rz(ω)` into the parent frame.
4. Moons: add parent's heliocentric state (evaluated recursively).

Properties: O(1) per body, exact evaluation at any t (no drift at any warp), deterministic saves.

**Accuracy bounds** (regression-tested vs `data/ephemerides-check.json` Horizons vectors):

| Body class | max error @ +30 d | @ +365 d |
|---|---|---|
| Planets, dwarfs | 1,000 km | 20,000 km |
| Moon (Luna) | 500 km | 15,000 km |
| Giant-planet moons | 2,000 km | 50,000 km |

(Errors come from neglected mutual perturbations; resulting orbits remain physically plausible. Bounds are generous by design — tighten empirically after the bake, in the same PR that adds the data.)

## 3. Ship dynamics — full n-body + thrust

Ship acceleration at position **r**, velocity **v**, time t:

```
a(r, t) = Σ_i  −μᵢ · (r − rᵢ(t)) / |r − rᵢ(t)|³   +   a_thrust(t)
```

Sum over **all** bodies in the catalog (~50). `rᵢ(t)` from rails (§2). `a_thrust = (T·throttle/m) · û`, û = attitude unit vector, m = constant ship mass (infinite-energy premise: no propellant depletion).

### 3.1 Integrator: Dormand–Prince 5(4), adaptive (ADR-002)

- Embedded RK5(4) pair, FSAL, standard DP54 tableau (cite Hairer–Nørsett–Wanner; tableau constants in `dp54.ts` must match the published values to full double precision).
- Error control: `err = |y5 − y4|` component-wise against `tol = absTol + relTol·|y|`, with `relTol = 1e-9`, `absTol = 1e-6 km` (position), `1e-9 km/s` (velocity). PI step controller: `h_new = h · min(5, max(0.2, 0.9·(1/err)^(1/5)))`.
- The propagator is a pure function: `propagate(state, t0, t1, accelFn, tol) → state` — shared verbatim by SimulationCore and the predictor worker.

### 3.2 Time warp

Ladder: `1, 5, 10, 50, 100, 1e3, 1e4, 1e5, 1e6, 1e7`. Per frame the sim advances `Δt = warp × wallDt`.

- **Thrust allowed at warp ≤ 1000** ("physics warp"). Above 1000x throttle is forced to 0 (coast).
- **Substep budget:** 4,000 accepted DP54 steps per frame. If the controller cannot cover `Δt` within budget (deep in a gravity well at high warp), warp auto-clamps to the highest sustainable tier; HUD shows the clamp and reason. Never trade accuracy for speed silently.

### 3.3 Optional mutual n-body mode ("dynamic bodies", default OFF)

Bodies integrated mutually with velocity-Verlet (leapfrog), fixed 300 s step, on a worker; warp capped at 1e5x. Symplectic ⇒ bounded energy error. Regression: 1-year inner-system integration, relative energy drift < 1e-9.

## 4. Launch phase (2D)

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

## 5. Δv / energy ledger

Integrated inside the same substeps as motion (warp-invariant):

- **Cumulative Δv** `= ∫ |a_thrust| dt` (m/s on HUD) — the headline cost metric; identical to what plane changes/captures "really cost".
- **Mechanical energy delivered** `= ∫ m·(a_thrust · v) dt` (J) — secondary readout; exposes the Oberth effect.
- **Launch losses** (launch phase only): gravity loss `= ∫ (μ⊕/r²)·sin γ dt`, drag loss `= ∫ (D/m) dt` — shown post-launch.
- **Burn log entry** per contiguous thrust interval: `{t_start, t_end, Δv, energy, dominant body, prograde/normal/radial decomposition}`.

## 6. Analysis

- **Dominant body:** argmax over bodies of `μᵢ/|r − rᵢ|²`; SOI radii (`r_SOI = a·(m/M)^(2/5)`, precomputed in bodies.json) as tie-break/hysteresis (10% band to avoid flicker).
- **Osculating elements** wrt dominant body from state vectors (standard conversion via h, e, n vectors; handle e→0 and i→0 degeneracies explicitly). Computed every frame for the HUD; it is an *approximation* in an n-body field — the worker prediction is the truth.
- **Trajectory prediction:** worker propagates thrust-free with §3.1 over max(2 osculating periods, 90 days, user-extended); downsampled polyline ≤ 2000 points; events: SOI transitions, closest approach to target, **impact** (path crosses body radius + atmosphere top) with time-to-impact.
- **Warnings:** impact (red, with countdown), atmosphere entry, SOI change, escape from dominant body.

## 7. Regression & validation tests (must exist before v1)

1. **Kepler solver:** |E| residual < 1e-12 across e ∈ [0, 0.99] and hyperbolic e ∈ (1, 5]; round-trip elements ↔ state vectors to 1e-10 relative.
2. **Two-body DP54:** circular and e=0.7 orbits, 10 periods: position error vs analytic < 1e-3 km; energy and |h| drift < 1e-9 relative.
3. **Rails accuracy:** vs `ephemerides-check.json` within §2 bounds.
4. **Launch regression:** scripted throttle/pitch profile reaches 200±5 km orbit; total Δv within ±1% of the golden value; max-q within ±2%.
5. **Handoff:** energy/angular-momentum round-trip < 1e-9 relative.
6. **Golden trajectories:** three 30-day ship propagations (LEO, Earth–Mars transfer, Jupiter flyby) stored in `tests/golden/`; any change that moves them requires an explicit golden update in the PR (reviewable diff).
7. **Ledger:** Δv of an impulsive-approximation Hohmann LEO→GEO within 1% of the analytic 3.90 km/s.
